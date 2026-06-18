import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { downloadDir } from "@tauri-apps/api/path";
import { platform } from "@tauri-apps/plugin-os";
import "./App.css";

type Mode = "send" | "receive";
type ThemePref = "auto" | "light" | "dark";
type ResolvedTheme = "light" | "dark";
type SendStatus =
  | "idle"
  | "creating_ticket"
  | "sharing"
  | "complete"
  // v0.1.90 — clean user-initiated Stop Send. The sidecar stops
  // serving the file but stays alive for chat (chat outlives the
  // transfer), so this is distinct from "error" and from "idle".
  | "stopped"
  | "error";
type ConnectionMode = "full" | "relay_only" | "direct_only";

// Per-mode explanatory copy, auto-shown beneath whichever radio is
// currently selected (no click-to-expand — the description for the active
// choice is always visible, the other two are hidden).
const CONNECTION_MODE_DESCRIPTIONS: Record<ConnectionMode, string> = {
  full:
    "A direct peer-to-peer link when the network allows it; uses the relay only if it has to. Recommended for most transfers.",
  relay_only:
    "Routes through iroh's relay to get connected, with a direct upgrade happening in the background whenever the network allows it. The most firewall- and NAT-friendly choice, and your IP addresses stay out of the ticket.",
  direct_only:
    "True peer-to-peer with zero relay involvement. Same direct attempt as the recommended mode, but with no safety net: a blocked path means a failed transfer. Great on a shared/local network.",
};

// v0.1.87 — short labels for the collapsed connection-mode disclosure
// summary, so the user sees their current choice without expanding.
const CONNECTION_MODE_LABELS: Record<ConnectionMode, string> = {
  full: "Direct + Relay (recommended)",
  relay_only: "Relay only",
  direct_only: "Direct only",
};
type RecvStatus =
  | "idle"
  | "connecting"
  | "downloading"
  | "exporting"
  | "complete"
  | "error"
  // v0.1.86 — Option A: bounded retry state machine. After Phase 1
  // (3 fast attempts) exhausts without reaching the sender, we
  // enter a 10-minute slow-poll loop with exponential backoff. The
  // UI renders a prominent panel with a live countdown to the next
  // retry. Status returns to "downloading" if Phase 2 succeeds, or
  // transitions to "error" if the budget runs out.
  | "waiting_for_sender"
  // v0.1.88 (#6) — transient state shown the instant the user clicks
  // Stop, before the sidecar has actually exited. Replaces the old
  // several-seconds-of-nothing-then-"error" experience.
  | "stopping"
  // v0.1.88 (#6) — clean user-initiated stop (distinct from "error").
  | "stopped";

// v0.1.86 — Live state for the "waiting for sender" panel. nextRetryAt
// is a wall-clock unix-ms so the React countdown effect can decrement
// in real time; the other fields are set from each
// download_waiting_for_sender event.
interface RecvRetryInfo {
  phase2Attempt: number;
  budgetMs: number;
  timeRemainingMs: number;
  nextRetryInMs: number;
  nextRetryAt: number;
}

// v0.1.85 — chat-while-you-transfer.
//
// ChatStatus state machine:
//   idle        — no chat connection has been attempted yet
//   connecting  — the chat ALPN is opening in parallel with the
//                 blob ALPN; on the sender side this is the
//                 "waiting for receiver to dial" state
//   connected   — both sides have exchanged Hello; messages flow
//   disconnected — peer hung up or stream closed
//   unavailable — the chat ALPN failed to connect (timeout, network
//                 issue, peer not running v0.1.85+)
type ChatStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unavailable";

// One entry in the chat scrollback. `kind: "you"` is what the local
// user typed, `"peer"` is what the other side sent, `"system"` is a
// status line we render distinctly (Connected / Disconnected / etc.).
interface ChatMessageItem {
  kind: "you" | "peer" | "system";
  body: string;
  at: number; // unix ms
}

interface Tickets {
  direct: string | null;
  relay: string | null;
  full: string;
}

interface RecvProgress {
  bytes: number;
  total: number | null;
  phase: "download" | "export";
}

interface SendProgress {
  phase: "hashing" | "uploading";
  bytes: number;
  total: number | null;
}

// A single receiver connected to this sender during the current serving
// session. Shown in the sender's "Receivers" panel.
interface ReceiverRow {
  connectionId: number;
  endpointId: string | null; // receiver's ephemeral NodeID
  label: string | null; // nickname the receiver volunteered, if any
  bytes: number;
  total: number | null;
  speed: number | null;
  status: "active" | "complete" | "disconnected";
}

const LS_RECEIVER_LABEL = "orbitxfer.receiverLabel.v1";

// Theme preference. "auto" follows the system; "light"/"dark" force a
// specific palette. Persisted in localStorage and applied globally via
// the `data-theme` attribute on <html>. An inline script in index.html
// already sets data-theme before React mounts (no flash); React keeps
// it in sync after that.
const LS_THEME = "orbitxfer.theme.v1";

function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(LS_THEME);
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto";
  } catch {
    return "auto";
  }
}

function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
}

function loadReceiverLabel(): string {
  try {
    return localStorage.getItem(LS_RECEIVER_LABEL) ?? "";
  } catch {
    return "";
  }
}

const OX_EVENT_PREFIX = "OX_EVENT ";

function parseOxEvent(line: string): any | null {
  const idx = line.indexOf(OX_EVENT_PREFIX);
  if (idx === -1) return null;
  try {
    return JSON.parse(line.substring(idx + OX_EVENT_PREFIX.length));
  } catch {
    return null;
  }
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

// localStorage-based persistence of the most recent send / receive. Shared
// across all windows in the app (same origin), so opening a new window
// surfaces the same Resume buttons.
const LS_LAST_SEND = "orbitxfer.lastSend.v1";
const LS_LAST_RECV = "orbitxfer.lastReceive.v1";

interface LastSend {
  filePath: string;
  savedAt: number;
  isFolder?: boolean;
  // v0.1.85 — preserved ticket variants from the first session. The
  // NodeID is the same across Stop→Resume cycles (per-file identity),
  // but the encoded IP/port section drifts between sessions because
  // ports are randomly assigned. Saving and re-displaying the
  // original ticket on Resume keeps the share line stable for
  // anyone who already received it.
  tickets?: Tickets;
  // v0.1.88 (#5) — canonical payload size, saved so Resume Last Send
  // can pass it to the cached-blob fast path (and so the resumed
  // share line keeps its `# size=` annotation without a re-hash).
  totalSize?: number;
}

interface LastReceive {
  ticketInput: string;
  outputPath: string;
  savedAt: number;
  // v0.1.86 — Option B: cross-session resume. Set true when the
  // receive successfully finishes (export_complete fires). Defaults
  // to undefined/false on a freshly-started receive. On app open,
  // if there's a LastReceive entry with completed != true, we show
  // a prominent "Resume incomplete download?" banner so the user
  // can pick up where a previous app session left off.
  completed?: boolean;
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`save ${key} failed:`, e);
  }
}

interface ParsedReceiveInput {
  ticket: string;
  suggestedName: string | null;
  /// Canonical payload size extracted from the share line's `# size=<N>`
  /// suffix, when present. Lets the receiver UI seed its progress total
  /// the instant the ticket is pasted (before `start_receive` is even
  /// invoked), so the receive percentage uses the same denominator as
  /// the sender's upload percentage. null when the share line predates
  /// v0.1.65 or someone shared the bare ticket.
  canonicalSize: number | null;
  /// True when the share line's name token ends with a trailing slash
  /// (e.g. `MyFolder/`), indicating the ticket is a folder (collection)
  /// rather than a single file. This is only a UI hint for showing the
  /// right destination picker; the CLI reads the authoritative file-vs-
  /// folder flag from the ticket format itself.
  isFolder: boolean;
}

// Extract a blob ticket — and, if present, a suggested filename and
// canonical payload size — from arbitrary input. The ticket itself is
// just a hash + node ID + relay info; the filename and size do NOT travel
// inside it. We rely on the CLI's existing
// "orbitxfer-iroh-cli receive <ticket> <path>" share format to carry the
// filename, and we append a `# size=<bytes>` shell-comment suffix to carry
// the canonical payload size. Backward-compatible: an old client missing
// the size suffix still parses fine; the receiver just waits for observe()
// to learn the total like before.
function parseReceiveInput(input: string): ParsedReceiveInput | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/blob[a-z0-9]{60,}/i);
  if (!match) return null;
  const ticket = match[0];

  let after = trimmed
    .slice(match.index! + ticket.length)
    .trim()
    .replace(/^['"]|['"]$/g, "");

  // Extract `# size=<N>` first, then strip it out so the basename
  // logic below doesn't see "12345" as a filename. The pattern is
  // intentionally loose about spaces so a manually-edited share line
  // still parses.
  let canonicalSize: number | null = null;
  const sizeMatch = after.match(/#\s*size\s*=\s*(\d+)/i);
  if (sizeMatch) {
    const n = Number(sizeMatch[1]);
    if (Number.isFinite(n) && n >= 0) canonicalSize = n;
    after = after.replace(/#\s*size\s*=\s*\d+.*$/i, "").trim();
  }

  // A trailing slash on the name token marks a folder, e.g. `MyFolder/`.
  // Detect it, then strip it before deriving the basename.
  let isFolder = false;
  let suggestedName: string | null = null;
  if (after) {
    if (/[/\\]\s*$/.test(after)) {
      isFolder = true;
    }
    const cleaned = after.replace(/[/\\]+\s*$/, "");
    const last = basename(cleaned);
    const hasSeparator = /[/\\]/.test(cleaned);
    const hasExtension = /\.[\w]{1,10}$/.test(last);
    if ((isFolder || hasSeparator || hasExtension) && last && last.length <= 255) {
      suggestedName = last;
    }
  }

  return { ticket, suggestedName, canonicalSize, isFolder };
}

function formatBytes(bytes: number): string {
  // Decimal (SI) units, base 1000 — matches what Finder, modern Windows
  // Explorer, and most consumer file-size displays show. Pre-v0.1.82 used
  // base 1024 (technically KiB/MiB/...) with KB/MB/... labels, which
  // could read ~7% off vs the OS's reported size for the same file.
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec < 1) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/// Format a duration in seconds as "Xs" / "Xm Ys" / "Xh Ym" — used by both
/// the live ETA and the post-transfer completion summary's "Time" row.
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatEta(remainingBytes: number, bytesPerSec: number | null): string | null {
  if (bytesPerSec === null || bytesPerSec < 1) return null;
  const seconds = remainingBytes / bytesPerSec;
  if (!isFinite(seconds) || seconds < 0) return null;
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

interface SpeedSample {
  at: number; // ms timestamp
  bytes: number; // cumulative bytes at that time
}

/// Push a new (timestamp, bytes) sample and trim anything older than the
/// 5-second window. Returns the trimmed list so callers can compute speed.
function trackSpeed(samples: SpeedSample[], bytes: number): SpeedSample[] {
  const now = Date.now();
  samples.push({ at: now, bytes });
  const cutoff = now - 5000;
  while (samples.length > 0 && samples[0].at < cutoff) {
    samples.shift();
  }
  return samples;
}

/// Compute bytes-per-second over the rolling window. Returns null if there
/// aren't enough samples or the window is too short to be meaningful.
function speedFromSamples(samples: SpeedSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.at - first.at) / 1000;
  if (dt <= 0.1) return null;
  const dbytes = last.bytes - first.bytes;
  return dbytes / dt;
}

async function openNewTransferWindow() {
  // Window creation happens Rust-side via the open_new_window command so
  // the Window submenu can be rebuilt with the new window included. We
  // could create the window from JS via `new WebviewWindow(...)` but that
  // bypasses the menu update.
  try {
    await invoke("open_new_window");
  } catch (err) {
    console.error("New window failed to open:", err);
  }
}

function App() {
  // Per-window mode. Each window picks Send or Receive; the other panel is
  // hidden so a single window stays focused on one task. Open another window
  // for the other direction.
  const [mode, setMode] = useState<Mode>("send");

  // Global theme preference. Lives in localStorage so every window in the
  // app stays in sync (we listen for storage events below). Auto follows
  // the system; Light/Dark force a specific palette. The View menu has
  // three items that emit `theme:set` events handled below.
  const [themePref, setThemePref] = useState<ThemePref>(loadThemePref);

  // Persist + apply on change. Resolves Auto → system pref each time.
  useEffect(() => {
    try {
      localStorage.setItem(LS_THEME, themePref);
    } catch (e) {
      console.error("save theme failed:", e);
    }
    applyTheme(resolveTheme(themePref));
  }, [themePref]);

  // When the user is on "Auto", react live to OS light/dark changes so
  // the app flips with the system (mid-session light→dark sunset, etc).
  useEffect(() => {
    if (themePref !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(resolveTheme("auto"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themePref]);

  // v0.1.89 — measure the window chrome height ONCE (outer − inner,
  // in logical px) so `fitWindow` can compensate for the titlebar.
  useEffect(() => {
    void (async () => {
      try {
        const w = getCurrentWindow();
        const scale = await w.scaleFactor();
        const outer = await w.outerSize();
        const inner = await w.innerSize();
        const delta = (outer.height - inner.height) / scale;
        // Guard against nonsense (negative / absurd) readings.
        chromeHeightRef.current = delta > 0 && delta < 120 ? delta : 28;
      } catch {
        chromeHeightRef.current = 28; // macOS titlebar fallback
      }
    })();
  }, []);

  // v0.1.89 — resize the window so ALL content fits without scrolling.
  // Robust rewrite of v0.1.87's auto-fit:
  //   - target = content height + chrome (titlebar) + small margin,
  //     so the bottom never gets clipped under the titlebar.
  //   - max bound from window.screen.availHeight (synchronous,
  //     already excludes the macOS menu bar + Dock) instead of the
  //     flaky async currentMonitor().
  //   - width left untouched (only height flexes).
  // Called from the ResizeObserver AND explicitly on key state
  // transitions (below), since content appears in waves.
  // v0.1.89 (revised) — DEADBAND fit. The earlier "measure once and
  // setSize" approach raced with content that renders in waves (the
  // share-ticket textarea, receivers, logs appear after the
  // ticket_variants event), leaving the window short for seconds.
  // This version:
  //   - GROWS the moment the content overflows the current inner
  //     (webview) height,
  //   - SHRINKS only when there's clearly excess empty space,
  //   - does NOTHING inside a deadband — which also absorbs the
  //     ambiguity of whether setSize targets the inner or outer size
  //     (the titlebar's worth of px), so there's no oscillation.
  // Run from the ResizeObserver (snappy) AND a low-frequency interval
  // (bulletproof catch-up regardless of render timing).
  const fitWindow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const content = Math.ceil(el.getBoundingClientRect().height);
    const inner = window.innerHeight; // current webview content height (CSS px)
    const chrome = chromeHeightRef.current;
    const MIN_HEIGHT = 420;
    // v0.1.90 — bottom headroom. A few px is not enough: the measured
    // `chrome` delta can under-estimate the real titlebar by a px or two,
    // and child margins can extend past the container box, both of which
    // leave content a hair taller than the inner height → a thin
    // scrollbar even right after a grow. 16px reliably clears it while
    // staying well inside the shrink deadband (no oscillation).
    const SAFETY = 16;

    let maxHeight = 2400;
    try {
      const avail = window.screen?.availHeight;
      if (typeof avail === "number" && avail > 200) maxHeight = avail - 8;
    } catch {
      /* keep default */
    }

    const overflowing = content > inner - 2; // content doesn't fit
    const tooMuchSpace = inner - content > chrome + 80; // lots of empty space
    if (!overflowing && !tooMuchSpace) return; // inside deadband — no-op

    const target = Math.max(
      MIN_HEIGHT,
      Math.min(content + chrome + SAFETY, maxHeight)
    );
    getCurrentWindow()
      .setSize(new LogicalSize(window.innerWidth, target))
      .catch((e) => console.warn("auto-resize failed:", e));
  }, []);

  // ResizeObserver → fitWindow on content-size changes (snappy path).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: number | undefined;
    const debounced = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(fitWindow, 50);
    };
    const ro = new ResizeObserver(debounced);
    ro.observe(el);
    debounced();
    return () => {
      ro.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [fitWindow]);

  // v0.1.89 — bulletproof catch-up: poll fitWindow on a low-frequency
  // interval. The deadband makes this a near-free no-op whenever the
  // window already fits, but it GUARANTEES the window catches up to
  // staged content within ~250ms no matter how the render timing
  // races the ResizeObserver.
  useEffect(() => {
    const id = window.setInterval(fitWindow, 250);
    return () => window.clearInterval(id);
  }, [fitWindow]);

  // Cross-window sync: when one window changes the theme, every other
  // open window picks it up via the storage event.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS_THEME) {
        setThemePref(loadThemePref());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Menu wiring: the View > Theme submenu in Rust emits `theme:set` with
  // the new pref as payload. Emitted app-wide (not per-window) since the
  // theme is a global setting.
  useEffect(() => {
    const unlisten = listen<string>("theme:set", (e) => {
      const v = e.payload;
      if (v === "auto" || v === "light" || v === "dark") {
        setThemePref(v);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Connection mode — applies to all sends from this window. Always starts
  // at "full" (Direct + Relay fallback, the recommended mode) on every
  // launch and every new window. Intentionally NOT persisted: each new
  // window/session begins from the safe recommended default rather than
  // inheriting a previous niche choice (Relay-only / Direct-only).
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>("full");

  // Tracks whether the user has explicitly picked a destination via the save
  // dialog. We auto-fill the destination from the parsed ticket's filename,
  // but only if the user hasn't already chosen one — we don't want to clobber
  // a manual selection just because they edited the ticket textarea.
  const userPickedDest = useRef(false);

  // v0.1.87 — auto-fit the window height to its content. A
  // ResizeObserver on the main container measures the natural
  // content height and resizes the window so everything fits
  // without scrolling. Width is left untouched. Bounded below by a
  // minimum and above by the monitor's (approximate) work area, so
  // even with the ticket + receivers + chat all open at once the
  // window grows to fit rather than showing a scrollbar — unless
  // the content genuinely exceeds the screen, in which case
  // scrolling remains as a fallback.
  const containerRef = useRef<HTMLElement | null>(null);
  // v0.1.93 — the chat transcript element; auto-scrolled to the newest
  // message so you don't have to scroll down to see incoming chat.
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  // v0.1.89 — the window chrome (titlebar) height in logical px,
  // measured once as outerSize − innerSize. We ADD this to the target
  // so the window is tall enough to show all content below the
  // titlebar. If setSize turns out to target the inner size, the only
  // cost is a few px of slack at the bottom — never a clip.
  const chromeHeightRef = useRef<number>(0);

  // Persisted "last send" / "last receive" so the user can resume an
  // interrupted transfer (or just redo their last one) after a window close,
  // app quit, or crash.
  const [lastSend, setLastSend] = useState<LastSend | null>(() =>
    loadJson<LastSend>(LS_LAST_SEND)
  );
  const [lastRecv, setLastRecv] = useState<LastReceive | null>(() =>
    loadJson<LastReceive>(LS_LAST_RECV)
  );

  // Send state
  const [filePath, setFilePath] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [tickets, setTickets] = useState<Tickets | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendLogs, setSendLogs] = useState<string[]>([]);
  const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
  const [sendSpeed, setSendSpeed] = useState<number | null>(null);
  const sendSpeedRef = useRef<SpeedSample[]>([]);
  // Canonical payload size from the local file's metadata. Captured at
  // hashing time so we can both (a) keep the upload progress denominator
  // pinned across phases and (b) embed it in the share line's `# size=<N>`
  // suffix. null until the CLI's `ticket_variants` (or earlier
  // `ticket_hashing_size`) event arrives.
  const [sendTotalSize, setSendTotalSize] = useState<number | null>(null);
  // True when the current send is a folder (collection). Drives the
  // trailing-slash folder hint in the share line and the file-count label.
  const [isFolderSend, setIsFolderSend] = useState(false);
  // Number of files in a folder send, reported by the CLI's hashing events.
  const [sendFileCount, setSendFileCount] = useState<number | null>(null);
  // Connected receivers for the current send session, keyed by the CLI's
  // per-connection id. Populated from receiver_connected / upload_* /
  // receiver_label / receiver_disconnected events so the sender can see
  // who's downloading. Reset at the start of each send.
  const [receivers, setReceivers] = useState<ReceiverRow[]>([]);
  // Per-receiver rolling speed samples, keyed by connection id.
  const receiverSpeedRef = useRef<Map<number, SpeedSample[]>>(new Map());
  // Labels volunteered by receivers, keyed by their (ephemeral) NodeID.
  // Kept separately because a label can arrive before or after the
  // matching blob connection.
  const labelsByEndpointRef = useRef<Map<string, string>>(new Map());
  // v0.1.92 — map each blob connection id to the receiver's (ephemeral)
  // NodeID, so progress events that only carry a connection id can be
  // attributed to the right ENDPOINT row. A single receiver opens a new
  // connection on every retry; without this we'd render one row per
  // connection (the duplicate-"Receivers" bug).
  const connToEndpointRef = useRef<Map<number, string>>(new Map());
  // Timestamps bracketing the actual data transfer, used to compute the
  // average speed + total time in the "Transfer Complete" summary. For
  // sends with multiple receivers the stats reflect the FIRST receiver's
  // completion (when the user conceptually thinks of the send as "done");
  // per-receiver figures stay accurate in the Receivers panel.
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [sendCompletedAt, setSendCompletedAt] = useState<number | null>(null);

  // Receive state
  const [ticketInput, setTicketInput] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [recvStatus, setRecvStatus] = useState<RecvStatus>("idle");
  const [recvProgress, setRecvProgress] = useState<RecvProgress | null>(null);
  const [recvError, setRecvError] = useState<string | null>(null);
  const [recvLogs, setRecvLogs] = useState<string[]>([]);
  const [recvSpeed, setRecvSpeed] = useState<number | null>(null);
  const recvSpeedRef = useRef<SpeedSample[]>([]);
  // Folder receive: file count + (capped) name list, learned from the
  // CLI's `collection_files` metadata prefetch so we can show what's in
  // the folder during the download. null for single-file receives.
  const [recvFolderFileCount, setRecvFolderFileCount] = useState<number | null>(
    null
  );
  const [recvFolderFiles, setRecvFolderFiles] = useState<string[] | null>(null);
  const [recvFolderTruncated, setRecvFolderTruncated] = useState(false);
  // The file currently being written to disk during the export phase.
  const [recvCurrentFile, setRecvCurrentFile] = useState<{
    index: number;
    name: string;
    files: number | null;
  } | null>(null);
  // Timestamps bracketing the receive — used for the completion summary.
  // Start = first download_started, end = export_complete (includes the
  // local write phase, matching the user's perceived total wait).
  const [recvStartedAt, setRecvStartedAt] = useState<number | null>(null);
  const [recvCompletedAt, setRecvCompletedAt] = useState<number | null>(null);

  // v0.1.86 — Option B: cross-session resume banner state. True once
  // the user clicks Dismiss on the banner for this session — keeps
  // it from coming back every component re-render until the next
  // app open. Per-window only; not persisted, since dismissing in
  // one window shouldn't silence the prompt in another.
  const [resumeBannerDismissed, setResumeBannerDismissed] = useState(false);

  // v0.1.86 — Option A retry state. Null when not in
  // waiting_for_sender mode; populated from each
  // download_waiting_for_sender event so the panel can render the
  // countdown + attempt count + total time remaining.
  const [recvRetryInfo, setRecvRetryInfo] = useState<RecvRetryInfo | null>(null);

  // v0.1.88 (#6) — set true while a user-initiated Stop is in flight,
  // so the recv:exit handler renders "Stopped" rather than treating
  // the exit as a crash. Cleared when a new receive starts.
  const recvStoppingRef = useRef(false);
  // v0.1.88 (#7) — the plain-English reason from the most recent
  // download_waiting_for_sender / download_giving_up event, shown in
  // the waiting panel so the user knows WHY it's retrying.
  const [recvRetryReason, setRecvRetryReason] = useState<string | null>(null);
  // Tick state: incremented every second while waiting so the
  // countdown display updates in real time without re-firing the
  // event handler.
  const [retryCountdownTick, setRetryCountdownTick] = useState(0);

  // v0.1.85 — When the user clicks "Resume last send", we want to
  // show the SAME ticket the first session showed (the NodeID is
  // preserved by per-file identity, but encoded IP/port info drifts
  // between sessions and would otherwise cause the displayed ticket
  // string to subtly change). Setting this ref BEFORE the next
  // ticket_variants event fires tells the handler to keep showing
  // the preserved variants instead of overwriting with the new
  // sidecar's variants. The ref is reset to false after one use so
  // a subsequent fresh Pick File / Pick Folder works normally.
  const preserveTicketsOnNextSession = useRef(false);
  // Visible UI flag: when true, render a small "Same ticket as
  // before" hint above the share-line box so the user understands
  // the preserved-ticket behavior.
  const [isPreservedTicket, setIsPreservedTicket] = useState(false);

  // v0.1.85 — chat-while-you-transfer state. One chat per window:
  // for a Send-mode window it tracks the chat with the first
  // receiver who dials; for a Receive-mode window it's the chat
  // with that sender. Status walks idle → connecting → connected →
  // disconnected (peer Bye / stream closed) OR unavailable
  // (couldn't open the chat ALPN at all). Chat outlives the
  // transfer — `recvStatus === "complete"` does NOT close the chat
  // panel.
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [chatPeerLabel, setChatPeerLabel] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [chatInput, setChatInput] = useState("");
  // v0.1.93 — keep the chat transcript pinned to the newest message.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);
  // Opt-in nickname the receiver volunteers so the sender sees who's
  // downloading. Empty = don't send any label. Persisted across launches.
  const [receiverLabel, setReceiverLabel] = useState<string>(loadReceiverLabel);
  useEffect(() => {
    try {
      localStorage.setItem(LS_RECEIVER_LABEL, receiverLabel);
    } catch (e) {
      console.error("save receiverLabel failed:", e);
    }
  }, [receiverLabel]);

  const win = useMemo(() => getCurrentWindow(), []);

  // Update the OS window title when mode changes so the user can tell
  // multiple windows apart in Mission Control / app switcher.
  useEffect(() => {
    win.setTitle(`OrbitXfer — ${mode === "send" ? "Send" : "Receive"}`).catch(
      (err) => console.error("setTitle failed:", err)
    );
  }, [mode, win]);

  // Cross-window sync: when ANOTHER window persists a new last send / last
  // receive, this window's Resume buttons should reflect it without a reload.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS_LAST_SEND) setLastSend(loadJson<LastSend>(LS_LAST_SEND));
      else if (e.key === LS_LAST_RECV)
        setLastRecv(loadJson<LastReceive>(LS_LAST_RECV));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Identity-reset listener. Fires globally (not window-scoped) when the
  // user picks OrbitXfer → Reset Identity… from the menu. Every window in
  // the app should clear its active-transfer UI and surface a brief banner
  // so the user knows what just happened.
  const [identityResetAt, setIdentityResetAt] = useState<number | null>(null);
  useEffect(() => {
    const unlisten = listen<null>("identity:reset", () => {
      setSendStatus("idle");
      setTickets(null);
      setSendError(null);
      setRecvStatus("idle");
      setRecvProgress(null);
      setRecvError(null);
      setIdentityResetAt(Date.now());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-clear the banner a few seconds after a reset.
  useEffect(() => {
    if (identityResetAt === null) return;
    const t = setTimeout(() => setIdentityResetAt(null), 6000);
    return () => clearTimeout(t);
  }, [identityResetAt]);

  // Generic transient notification used by menu actions that need to tell
  // the user something didn't happen (e.g. "Resume Last Send" clicked with
  // no previous send). Same auto-clear pattern as the identity reset banner.
  const [menuMessage, setMenuMessage] = useState<string | null>(null);
  useEffect(() => {
    if (menuMessage === null) return;
    const t = setTimeout(() => setMenuMessage(null), 4500);
    return () => clearTimeout(t);
  }, [menuMessage]);

  // Sleep-inhibitor badge: shown across every window while any window has
  // an active transfer. Rust holds the actual platform-specific wake lock
  // (IOKit on macOS, SetThreadExecutionState on Windows, systemd-logind
  // Inhibit on Linux) and broadcasts transfer:active / transfer:idle to
  // tell every window's UI when to show or hide the ☕ indicator.
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);
  useEffect(() => {
    const unsubs: Promise<UnlistenFn>[] = [];
    unsubs.push(
      listen("transfer:active", () => setKeepAwakeActive(true))
    );
    unsubs.push(
      listen("transfer:idle", () => setKeepAwakeActive(false))
    );
    return () => {
      unsubs.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // Platform label for the wake-lock badge — "Mac" / "PC" / "computer".
  // Detected once at mount. Default "computer" so the badge has reasonable
  // text even if the platform call fails or hasn't resolved yet.
  const [platformLabel, setPlatformLabel] = useState("computer");
  useEffect(() => {
    try {
      const p = platform();
      if (p === "macos") setPlatformLabel("Mac");
      else if (p === "windows") setPlatformLabel("PC");
      else setPlatformLabel("computer");
    } catch (e) {
      console.error("platform() failed:", e);
    }
  }, []);

  // Webview zoom level, controlled by the View menu's zoom items. Stored
  // per-window in state; the actual zoom is applied via Tauri's webview
  // setZoom() API. Bounded so the UI can't go off the rails.
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const webviewWin = useMemo(() => getCurrentWebviewWindow(), []);
  useEffect(() => {
    webviewWin.setZoom(zoomLevel).catch((err) => {
      console.error("setZoom failed:", err);
    });
  }, [zoomLevel, webviewWin]);

  // Listeners for menu events emitted from the Rust side. These fire only
  // for the focused window (Rust uses emit_to(focused_window)), so each
  // window responds individually. The events themselves carry no payload.
  useEffect(() => {
    const unsubs: Promise<UnlistenFn>[] = [];

    // The Rust menu handler doesn't know about lastSend in localStorage,
    // so we read it fresh here and either kick off the resume or show a
    // friendly no-op message. The lastSend state we already have in React
    // might be stale across cross-window updates, so re-reading guarantees
    // freshness.
    unsubs.push(
      win.listen("menu:resume-last-send", () => {
        const stored = loadJson<LastSend>(LS_LAST_SEND);
        if (stored) {
          setMode("send");
          setLastSend(stored);
          startSendWith(stored.filePath, stored.isFolder ?? false);
        } else {
          setMenuMessage(
            "No previous send to resume — start a send first."
          );
        }
      })
    );

    unsubs.push(
      win.listen("view:zoom-in", () => {
        setZoomLevel((z) => Math.min(3.0, z * 1.1));
      })
    );
    unsubs.push(
      win.listen("view:zoom-out", () => {
        setZoomLevel((z) => Math.max(0.4, z / 1.1));
      })
    );
    unsubs.push(
      win.listen("view:actual-size", () => {
        setZoomLevel(1.0);
      })
    );

    return () => {
      unsubs.forEach((p) => p.then((fn) => fn()));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  // When a ticket with a filename is pasted and the user hasn't already
  // picked a destination, auto-fill ~/Downloads/<filename>. This means the
  // received file keeps its original name and extension without the user
  // having to click Pick destination at all. They can still override.
  //
  // Also, if the share line carries a `# size=<N>` suffix, seed the
  // receive progress total from it RIGHT NOW — before the user hits
  // Start Receive, before the sidecar is spawned, before observe()
  // round-trips to the provider. This keeps the receiver's percentage
  // denominator identical to the sender's the moment the ticket is
  // pasted, so the two progress bars stay visually aligned through the
  // whole transfer.
  useEffect(() => {
    const parsed = parseReceiveInput(ticketInput);

    // Size seed is independent of the destination-auto-fill. Apply it
    // only while we're still idle/error so we don't clobber a live
    // recvProgress mid-transfer if the user happens to edit the ticket
    // textarea.
    if (parsed?.canonicalSize !== undefined && parsed?.canonicalSize !== null) {
      if (recvStatus === "idle" || recvStatus === "error") {
        setRecvProgress({
          bytes: 0,
          total: parsed.canonicalSize,
          phase: "download",
        });
      }
    } else if (recvStatus === "idle") {
      // Ticket has no size hint and we're idle; clear any stale seed
      // from a previous paste.
      setRecvProgress(null);
    }

    if (userPickedDest.current) return;
    if (!parsed?.suggestedName) {
      // Ticket without filename info; clear any previously auto-filled path.
      if (outputPath !== null) setOutputPath(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dir = await downloadDir();
        const sep = dir.endsWith("/") ? "" : "/";
        if (!cancelled) setOutputPath(`${dir}${sep}${parsed.suggestedName}`);
      } catch {
        if (!cancelled) setOutputPath(parsed.suggestedName);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketInput]);

  // All event listeners use the *current window's* listen() so events
  // emitted via app.emit_to(window_label, ...) only reach the window that
  // initiated the corresponding command. Without this, two open windows
  // would both react to a single window's CLI events.
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      win.listen<string>("send:stdout", (e) => {
        const line = e.payload;
        setSendLogs((prev) => [...prev, line]);

        const parsed = parseOxEvent(line);
        if (!parsed) return;

        const total =
          typeof parsed.total === "number" ? parsed.total : null;
        const bytes = typeof parsed.bytes === "number" ? parsed.bytes : null;
        const connId =
          typeof parsed.connection_id === "number"
            ? parsed.connection_id
            : null;

        // Folder sends carry a file count on their hashing events.
        if (typeof parsed.files === "number") setSendFileCount(parsed.files);

        // Upsert a receiver row by connection id, creating it if absent.
        // v0.1.92 — upsert a receiver row keyed by ENDPOINT, not
        // connection. A single receiver re-dials with a new connection
        // id on every retry/resume; we collapse all of those into one
        // row (the latest connection wins) so the Receivers list shows
        // one entry per actual peer instead of a pile of duplicates.
        //
        // v0.1.94 — key on connection IDENTITY, not magnitude.
        // connection ids are handle-like, NOT monotonic (a resumed
        // connection can have a SMALLER id than the one it replaces — an
        // earlier magnitude check wrongly dropped resume updates, leaving
        // the row stuck "disconnected"). Instead: a `supersede` event (a
        // new connection's receiver_connected / upload_started) makes
        // that connection the CURRENT one for the endpoint; a
        // non-supersede event (upload_progress) only applies to the
        // current connection, so stale events from a superseded
        // connection are ignored without dropping the live one.
        const upsertReceiver = (
          id: number,
          patch: Partial<ReceiverRow>,
          supersede = false
        ) =>
          setReceivers((prev) => {
            const endpointId =
              patch.endpointId ??
              connToEndpointRef.current.get(id) ??
              null;
            let idx = endpointId
              ? prev.findIndex((r) => r.endpointId === endpointId)
              : -1;
            if (idx === -1) {
              idx = prev.findIndex((r) => r.connectionId === id);
            }
            if (idx === -1) {
              return [
                ...prev,
                {
                  connectionId: id,
                  endpointId,
                  label: null,
                  bytes: 0,
                  total: null,
                  speed: null,
                  status: "active",
                  ...patch,
                },
              ];
            }
            const row = prev[idx];
            // Non-supersede events only update the CURRENT connection.
            if (!supersede && row.connectionId !== id) {
              return prev;
            }
            const next = [...prev];
            // v0.1.95 — keep per-receiver bytes MONOTONIC so a resume's
            // upload_started(bytes:0) (and the delta-only serve that
            // follows) doesn't drop the bar below where it was. A
            // genuinely new transfer clears the receivers first, so this
            // never sticks across transfers.
            const nextBytes =
              patch.bytes !== undefined
                ? Math.max(patch.bytes, row.bytes ?? 0)
                : row.bytes;
            next[idx] = {
              ...row,
              ...patch,
              bytes: nextBytes,
              connectionId: id,
              endpointId: endpointId ?? row.endpointId,
            };
            return next;
          });

        switch (parsed.type) {
          case "ticket_hashing_start":
            sendSpeedRef.current = [];
            setSendSpeed(null);
            setSendProgress({ phase: "hashing", bytes: 0, total: null });
            break;
          // v0.1.88 (#5) — Resume fast path: the CLI reused the cached
          // blob instead of re-hashing. No hashing progress will
          // follow; the ticket_variants event arrives next. Clear any
          // stale hashing progress so the UI jumps straight to the
          // share line.
          case "ticket_reused":
            setSendProgress(null);
            sendSpeedRef.current = [];
            setSendSpeed(null);
            if (total !== null) setSendTotalSize(total);
            break;
          case "ticket_hashing_size":
            // First authoritative reading of the file's payload size.
            // Cache it now so we can embed it in the share line even
            // before `ticket_variants` arrives.
            if (total !== null) setSendTotalSize(total);
            setSendProgress((prev) => ({
              phase: "hashing",
              bytes: prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
            }));
            break;
          case "ticket_hashing_progress":
            if (bytes !== null) {
              const samples = trackSpeed(sendSpeedRef.current, bytes);
              setSendSpeed(speedFromSamples(samples));
            }
            setSendProgress((prev) => ({
              phase: "hashing",
              bytes: bytes ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
            }));
            break;
          case "ticket_hashing_complete":
            setSendProgress((prev) => ({
              phase: "hashing",
              bytes: total ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
            }));
            // Reset speed samples — upload phase will track its own.
            sendSpeedRef.current = [];
            setSendSpeed(null);
            break;
          case "ticket_variants": {
            const newTickets: Tickets = {
              direct: parsed.direct ?? null,
              relay: parsed.relay ?? null,
              full: parsed.full,
            };
            if (preserveTicketsOnNextSession.current) {
              // v0.1.85 — Resume Last Send is in progress. The CLI
              // emitted a fresh ticket (same NodeID + hash, but with
              // updated IP/port encoding), and we deliberately DON'T
              // overwrite the displayed tickets — we keep showing
              // the originals so anyone holding the previous share
              // line stays correct. We still update sendStatus etc.
              // so the rest of the UI behaves normally.
              preserveTicketsOnNextSession.current = false;
              setIsPreservedTicket(true);
            } else {
              setTickets(newTickets);
              setIsPreservedTicket(false);
              // Save tickets into LastSend so a future Resume can
              // re-display them. We update the existing localStorage
              // entry (which already has filePath) with the tickets
              // field. This is the FIRST time tickets are saved for
              // this share — subsequent ticket_variants events in
              // the same session (e.g. if iroh's address set
              // changes) do NOT overwrite the saved tickets, so
              // the saved version always matches what the user
              // originally saw and possibly shared.
              const existing = loadJson<LastSend>(LS_LAST_SEND);
              if (existing && existing.filePath && !existing.tickets) {
                const updated: LastSend = {
                  ...existing,
                  tickets: newTickets,
                  // v0.1.88 (#5) — capture the canonical size too, so
                  // Resume can pass it to the cached-blob fast path.
                  totalSize:
                    typeof total === "number" ? total : existing.totalSize,
                };
                saveJson(LS_LAST_SEND, updated);
                setLastSend(updated);
              }
            }
            // Confirm the canonical total. `ticket_hashing_size` already
            // set it once; we refresh here in case the source of truth
            // (e.g. a slightly different store-reported size) shifted.
            if (total !== null) setSendTotalSize(total);
            setSendStatus("sharing");
            // Clear hashing progress — it's done and the ticket is the
            // main signal now.
            setSendProgress(null);
            break;
          }
          case "receiver_connected":
            if (connId !== null) {
              const endpointId =
                typeof parsed.endpoint_id === "string"
                  ? parsed.endpoint_id
                  : null;
              const knownLabel = endpointId
                ? labelsByEndpointRef.current.get(endpointId) ?? null
                : null;
              if (endpointId) {
                connToEndpointRef.current.set(connId, endpointId);
              }
              // supersede: this connection becomes the endpoint's current
              // one (re-activates a row left "disconnected" by a Stop).
              upsertReceiver(
                connId,
                {
                  endpointId,
                  label: knownLabel,
                  status: "active",
                },
                true
              );
            }
            break;
          case "receiver_label": {
            const endpointId =
              typeof parsed.endpoint_id === "string"
                ? parsed.endpoint_id
                : null;
            const label =
              typeof parsed.label === "string" ? parsed.label : null;
            if (endpointId && label) {
              labelsByEndpointRef.current.set(endpointId, label);
              setReceivers((prev) => {
                // v0.1.85 — dedup by label. When the same person
                // hits Stop → Resume on the receiver side, they
                // reconnect with a fresh ephemeral iroh NodeID and
                // the prior receiver-row's disconnect event may not
                // have propagated yet (the SIGKILL takes up to 5 s).
                // Without this, a single user's three retries
                // showed up as three Receivers rows (`russo recieve`
                // ×3) all looking active.
                //
                // Strategy: when a new label arrives, any OTHER row
                // with the same label that ISN'T already
                // successfully completed gets removed. The newest
                // labeled connection supersedes any in-flight or
                // disconnected predecessors with the same label.
                // Completed rows are preserved as a per-session
                // history.
                //
                // Trade-offs:
                //  - Two real machines with the same label
                //    downloading concurrently → only the most
                //    recent shows. Labels are user-typed and not
                //    unique; this is an acceptable cost for the
                //    common "I stopped and resumed" case.
                //  - Completed rows stay visible so the user can
                //    see "russo recieve finished" alongside any new
                //    "russo recieve (retry)" attempt.
                return prev
                  .filter(
                    (r) =>
                      r.label !== label ||
                      r.endpointId === endpointId ||
                      r.status === "complete"
                  )
                  .map((r) =>
                    r.endpointId === endpointId ? { ...r, label } : r
                  );
              });
            }
            break;
          }
          case "receiver_disconnected":
            if (connId !== null) {
              // v0.1.92 — resolve to the endpoint row and only mark it
              // disconnected if THIS is its current connection. A late
              // disconnect from a superseded (older) connection must not
              // knock the freshly-reconnected row offline.
              const endpointId =
                connToEndpointRef.current.get(connId) ?? null;
              setReceivers((prev) =>
                prev.map((r) => {
                  const isThisRow = endpointId
                    ? r.endpointId === endpointId
                    : r.connectionId === connId;
                  // Only the row's CURRENT connection dropping counts —
                  // a late disconnect from a superseded connection (e.g.
                  // after a resume re-connected) must not knock the live
                  // row offline. (Match identity, not magnitude.)
                  if (
                    isThisRow &&
                    connId === r.connectionId &&
                    r.status !== "complete"
                  ) {
                    return { ...r, status: "disconnected" };
                  }
                  return r;
                })
              );
            }
            break;
          case "upload_started":
            sendSpeedRef.current = [];
            setSendSpeed(null);
            setSendProgress({
              phase: "uploading",
              bytes: 0,
              total: total ?? null,
            });
            // Bracket the transfer for the completion-summary stats. Only
            // the FIRST upload_started (across all receivers) wins.
            setSendStartedAt((prev) => prev ?? Date.now());
            if (connId !== null) {
              // supersede: a fresh serve makes this the current connection.
              upsertReceiver(
                connId,
                {
                  bytes: 0,
                  total: total ?? null,
                  status: "active",
                },
                true
              );
            }
            break;
          case "upload_progress":
            if (bytes !== null) {
              const samples = trackSpeed(sendSpeedRef.current, bytes);
              setSendSpeed(speedFromSamples(samples));
            }
            setSendProgress((prev) => ({
              phase: "uploading",
              bytes: bytes ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
            }));
            if (connId !== null && bytes !== null) {
              const map = receiverSpeedRef.current;
              const samples = trackSpeed(map.get(connId) ?? [], bytes);
              map.set(connId, samples);
              upsertReceiver(connId, {
                bytes,
                total: total ?? null,
                speed: speedFromSamples(samples),
                status: "active",
              });
            }
            break;
          case "upload_complete": {
            // For a HashSeq (folder) send, iroh fires Completed PER child
            // blob — root, meta, then each file — so this event arrives
            // many times. Only treat it as "the transfer is done" when the
            // running completed_bytes (carried as `bytes`) covers the
            // canonical `total`. Without this gate the summary would flash
            // ✓ Transfer Complete the moment the tiny root blob finishes
            // (which is microseconds after Start).
            const completedBytes =
              typeof parsed.bytes === "number" ? parsed.bytes : null;
            const totalForCheck =
              typeof parsed.total === "number" ? parsed.total : null;
            const isFinal =
              totalForCheck === null ||
              completedBytes === null ||
              completedBytes >= totalForCheck;
            if (isFinal) {
              setSendStatus("complete");
              // Mark the completion moment for the summary stats. Only the
              // FIRST receiver's TRUE completion sets this (the moment the
              // send is actually done for that receiver).
              setSendCompletedAt((prev) => prev ?? Date.now());
              setSendProgress((prev) =>
                prev
                  ? {
                      phase: "uploading",
                      bytes: prev.total ?? prev.bytes,
                      total: prev.total,
                    }
                  : null
              );
              sendSpeedRef.current = [];
              setSendSpeed(null);
              if (connId !== null) {
                setReceivers((prev) =>
                  prev.map((r) =>
                    r.connectionId === connId
                      ? {
                          ...r,
                          bytes: r.total ?? r.bytes,
                          speed: null,
                          status: "complete",
                        }
                      : r
                  )
                );
              }
            }
            // Intermediate per-blob completions are intentionally a no-op:
            // upload_started for the next blob will arrive and the speed/
            // bytes display continues uninterrupted.
            break;
          }
          case "upload_request_done": {
            // v0.1.96 — the definitive "this receiver finished" signal. The
            // CLI emits it when a GET request's update stream closes after a
            // clean serve (Completed, never Aborted), which means the peer
            // pulled everything it asked for. Unlike upload_complete this is
            // INDEPENDENT of byte totals, so it correctly fires on a resumed
            // /partial transfer where the sender only served the missing
            // ranges (bytes < total) — exactly the case that used to leave
            // the row stuck "disconnected". Mark the row complete
            // unconditionally so it wins regardless of whether a racing
            // receiver_disconnected already flipped it red.
            setSendStatus("complete");
            setSendCompletedAt((prev) => prev ?? Date.now());
            setSendProgress((prev) =>
              prev
                ? {
                    phase: "uploading",
                    bytes: prev.total ?? prev.bytes,
                    total: prev.total,
                  }
                : null
            );
            sendSpeedRef.current = [];
            setSendSpeed(null);
            if (connId !== null) {
              setReceivers((prev) =>
                prev.map((r) =>
                  r.connectionId === connId
                    ? {
                        ...r,
                        bytes: r.total ?? r.bytes,
                        speed: null,
                        status: "complete",
                      }
                    : r
                )
              );
            }
            break;
          }
          case "error":
            setSendError(`${parsed.stage}: ${parsed.message}`);
            setSendStatus("error");
            break;
          // v0.1.90 — clean Stop Send. The transfer stops but the
          // sidecar stays alive for chat; show "Stopped" (not error)
          // and leave the chat panel live.
          case "send_stopped":
            setSendStatus("stopped");
            break;
          // v0.1.93 — warm resume confirmed by the CLI (serving picked
          // back up in the same process; chat undisturbed).
          case "send_resumed":
            setSendStatus("sharing");
            setSendError(null);
            break;
          // v0.1.85 — chat events. Same set fires on the receive side
          // listener below; the handler logic is identical, just
          // scoped to whichever sidecar this window is running.
          case "chat_connected": {
            const label =
              typeof parsed.label === "string" ? parsed.label : "Receiver";
            setChatPeerLabel(label);
            setChatStatus("connected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Connected to ${label}`,
                at: Date.now(),
              },
            ]);
            break;
          }
          case "chat_message_received": {
            const body =
              typeof parsed.body === "string" ? parsed.body : "";
            const at =
              typeof parsed.sent_at_unix_ms === "number"
                ? parsed.sent_at_unix_ms
                : Date.now();
            setChatMessages((prev) => [
              ...prev,
              { kind: "peer", body, at },
            ]);
            break;
          }
          case "chat_disconnected":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `${chatPeerLabel ?? "Peer"} disconnected`,
                at: Date.now(),
              },
            ]);
            break;
          case "chat_unavailable":
            setChatStatus("unavailable");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Chat unavailable (${
                  typeof parsed.reason === "string"
                    ? parsed.reason
                    : "no chat connection"
                })`,
                at: Date.now(),
              },
            ]);
            break;
          case "chat_send_failed":
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Send failed: ${
                  typeof parsed.error === "string" ? parsed.error : "unknown"
                }`,
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.88 (#8/#9) — Reconnect Chat lifecycle (receiver-side;
          // harmless no-ops on the sender channel).
          case "chat_reconnecting":
            setChatStatus("connecting");
            setChatMessages((prev) => [
              ...prev,
              { kind: "system", body: "Reconnecting chat…", at: Date.now() },
            ]);
            break;
          case "chat_reconnect_failed":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Couldn't reconnect chat (${
                  typeof parsed.reason === "string" ? parsed.reason : "unknown"
                }). Retrying…`,
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.89 — auto-reconnect gave up after the streak cap.
          // Chat stays available for a manual Reconnect Chat.
          case "chat_gave_up":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: "Gave up auto-reconnecting — the sender seems to be offline. Click Reconnect Chat to try again.",
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.89 — never leave the UI stuck on "Connecting…": any
          // session error resolves to disconnected.
          case "chat_session_error":
            setChatStatus((cur) =>
              cur === "connected" ? cur : "disconnected"
            );
            break;
        }
      })
    );

    unlisteners.push(
      win.listen<string>("send:stderr", (e) => {
        setSendLogs((prev) => [...prev, "[stderr] " + e.payload]);
      })
    );

    unlisteners.push(
      win.listen<number | null>("send:exit", (e) => {
        setSendLogs((prev) => [...prev, `[exit] code=${e.payload}`]);
        // If the sidecar exited before producing a ticket, surface it as an
        // error so the UI doesn't sit stuck on "creating_ticket".
        setSendStatus((curr) =>
          curr === "creating_ticket" ? "error" : curr
        );
        setSendError((prev) =>
          prev ??
          (e.payload !== 0
            ? `Send process exited with code ${e.payload} before producing a ticket.`
            : null)
        );
      })
    );

    unlisteners.push(
      win.listen<string>("recv:stdout", (e) => {
        const line = e.payload;
        setRecvLogs((prev) => [...prev, line]);

        const parsed = parseOxEvent(line);
        if (!parsed) return;

        const total =
          typeof parsed.total === "number" ? parsed.total : null;
        const bytes = typeof parsed.bytes === "number" ? parsed.bytes : null;
        const files = typeof parsed.files === "number" ? parsed.files : null;

        switch (parsed.type) {
          case "connect_start":
          case "connect_check_start":
            setRecvStatus((s) => (s === "idle" ? "connecting" : s));
            // Reset speed tracking when a new transfer cycle starts.
            recvSpeedRef.current = [];
            setRecvSpeed(null);
            break;
          case "collection_files":
            // The CLI prefetched the folder's metadata — show the list/count
            // while the file data is still downloading.
            setRecvFolderFileCount(files);
            if (Array.isArray(parsed.names)) {
              setRecvFolderFiles(
                parsed.names.filter((n: unknown) => typeof n === "string")
              );
            }
            setRecvFolderTruncated(parsed.truncated === true);
            break;
          case "export_file_start":
            setRecvStatus("exporting");
            if (
              typeof parsed.name === "string" &&
              typeof parsed.index === "number"
            ) {
              setRecvCurrentFile({
                index: parsed.index,
                name: parsed.name,
                files,
              });
            }
            if (files !== null) setRecvFolderFileCount(files);
            break;
          case "download_size":
            setRecvProgress({ bytes: 0, total, phase: "download" });
            break;
          case "download_resume_baseline": {
            // v0.1.85 — the CLI walked the .orbitxfer-pieces/
            // store dir at session start and found cached bytes
            // from a previous interrupted receive. Seed the
            // progress bar with the baseline so users see e.g.
            // "3.4 GB / 4.58 GB" the moment the receive starts,
            // instead of "0 MB / 4.58 GB" ticking up from scratch
            // when 75% of the file already lives on disk. The
            // CLI also adds this baseline to every subsequent
            // download_progress.bytes value, so the percentage
            // and ETA reflect cumulative completion correctly.
            const baseline =
              typeof parsed.bytes === "number" ? parsed.bytes : 0;
            if (baseline > 0) {
              setRecvProgress((prev) => ({
                bytes: baseline,
                total: prev?.total ?? null,
                phase: "download",
              }));
            }
            break;
          }
          case "download_started":
            setRecvStatus("downloading");
            // Start the receive clock when bytes actually begin flowing.
            setRecvStartedAt((prev) => prev ?? Date.now());
            setRecvProgress((prev) => ({
              bytes: prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "download",
            }));
            break;
          case "download_progress":
            setRecvStatus("downloading");
            // v0.1.86 — if we just exited a Phase 2 retry cycle by
            // succeeding, clear the retry panel.
            setRecvRetryInfo(null);
            if (bytes !== null) {
              const samples = trackSpeed(recvSpeedRef.current, bytes);
              setRecvSpeed(speedFromSamples(samples));
            }
            setRecvProgress((prev) => ({
              bytes: bytes ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "download",
            }));
            break;
          // v0.1.86 — Option A retry events.
          case "download_waiting_for_sender": {
            const phase2Attempt =
              typeof parsed.phase2_attempt === "number"
                ? parsed.phase2_attempt
                : 0;
            const budgetMs =
              typeof parsed.budget_ms === "number" ? parsed.budget_ms : 0;
            const timeRemainingMs =
              typeof parsed.time_remaining_ms === "number"
                ? parsed.time_remaining_ms
                : 0;
            const nextRetryInMs =
              typeof parsed.next_retry_in_ms === "number"
                ? parsed.next_retry_in_ms
                : 0;
            setRecvStatus("waiting_for_sender");
            setRecvRetryInfo({
              phase2Attempt,
              budgetMs,
              timeRemainingMs,
              nextRetryInMs,
              nextRetryAt: Date.now() + nextRetryInMs,
            });
            // v0.1.88 (#7) — capture the plain-English reason.
            if (typeof parsed.reason === "string") {
              setRecvRetryReason(parsed.reason);
            }
            // Pause the speed display — no bytes are flowing during
            // the wait, and stale samples would mislead the ETA.
            setRecvSpeed(null);
            recvSpeedRef.current = [];
            break;
          }
          case "download_retry_cancelled":
            setRecvRetryInfo(null);
            // recv:exit will set status to "error" shortly. We just
            // make sure the retry panel stops rendering.
            break;
          case "download_giving_up":
            setRecvRetryInfo(null);
            setRecvStatus("error");
            setRecvError(
              // v0.1.88 (#7) — lead with the categorized reason if we
              // have one, then the budget note.
              `${
                typeof parsed.reason === "string" ? parsed.reason + " " : ""
              }The sender didn't come back online within ${
                typeof parsed.budget_ms === "number"
                  ? Math.round(parsed.budget_ms / 60000) + " minutes"
                  : "the retry budget"
              }. Your partial download is saved — try Resume when they're back.`
            );
            break;
          // v0.1.88 (#6) — clean user-initiated stop. The CLI emits
          // this right before exiting on a Stop, so we can show a
          // calm "Stopped" instead of an error.
          case "receive_stopped":
            recvStoppingRef.current = false;
            setRecvRetryInfo(null);
            setRecvStatus("stopped");
            break;
          case "download_complete":
            // Data has arrived. File is not yet written — that's the export
            // phase. Don't flip to "complete" until export_complete.
            setRecvProgress((prev) => ({
              bytes: total ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "download",
            }));
            // Export phase has different bytes; reset speed window.
            recvSpeedRef.current = [];
            setRecvSpeed(null);
            break;
          case "export_started":
            setRecvStatus("exporting");
            if (files !== null) setRecvFolderFileCount(files);
            setRecvProgress((prev) => ({
              bytes: 0,
              total: total ?? prev?.total ?? null,
              phase: "export",
            }));
            break;
          case "export_size":
            setRecvProgress((prev) => ({
              bytes: prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "export",
            }));
            break;
          case "export_progress":
            setRecvStatus("exporting");
            if (bytes !== null) {
              const samples = trackSpeed(recvSpeedRef.current, bytes);
              setRecvSpeed(speedFromSamples(samples));
            }
            setRecvProgress((prev) => ({
              bytes: bytes ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "export",
            }));
            break;
          case "export_complete":
            setRecvStatus("complete");
            // End the receive clock when the file(s) are fully written to
            // disk — this matches the user's perceived "how long did it
            // take" (which includes the local export phase, not just the
            // network transfer).
            setRecvCompletedAt((prev) => prev ?? Date.now());
            setRecvCurrentFile(null);
            setRecvProgress((prev) => ({
              bytes: total ?? prev?.bytes ?? 0,
              total: total ?? prev?.total ?? null,
              phase: "export",
            }));
            // v0.1.86 — Option B: mark the LastReceive entry as
            // completed. The cross-session resume banner only fires
            // when the most recent saved receive lacks this flag.
            {
              const existing = loadJson<LastReceive>(LS_LAST_RECV);
              if (existing) {
                const updated: LastReceive = {
                  ...existing,
                  completed: true,
                };
                saveJson(LS_LAST_RECV, updated);
                setLastRecv(updated);
              }
            }
            break;
          case "error":
            setRecvError(`${parsed.stage}: ${parsed.message}`);
            setRecvStatus("error");
            break;
          case "connect_check_failed":
          case "connect_failed":
            // Not fatal on its own; CLI may retry. Surface in logs only.
            break;
          // v0.1.85 — chat events (receive side). Identical structure
          // to the send-side handler above; could be extracted into a
          // shared helper, but inlined here keeps the switch readable.
          case "chat_connected": {
            const label =
              typeof parsed.label === "string" ? parsed.label : "Sender";
            setChatPeerLabel(label);
            setChatStatus("connected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Connected to ${label}`,
                at: Date.now(),
              },
            ]);
            break;
          }
          case "chat_message_received": {
            const body =
              typeof parsed.body === "string" ? parsed.body : "";
            const at =
              typeof parsed.sent_at_unix_ms === "number"
                ? parsed.sent_at_unix_ms
                : Date.now();
            setChatMessages((prev) => [
              ...prev,
              { kind: "peer", body, at },
            ]);
            break;
          }
          case "chat_disconnected":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `${chatPeerLabel ?? "Peer"} disconnected`,
                at: Date.now(),
              },
            ]);
            break;
          case "chat_unavailable":
            setChatStatus("unavailable");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Chat unavailable (${
                  typeof parsed.reason === "string"
                    ? parsed.reason
                    : "no chat connection"
                })`,
                at: Date.now(),
              },
            ]);
            break;
          case "chat_send_failed":
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Send failed: ${
                  typeof parsed.error === "string" ? parsed.error : "unknown"
                }`,
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.88 (#8/#9) — Reconnect Chat lifecycle (receiver-side;
          // harmless no-ops on the sender channel).
          case "chat_reconnecting":
            setChatStatus("connecting");
            setChatMessages((prev) => [
              ...prev,
              { kind: "system", body: "Reconnecting chat…", at: Date.now() },
            ]);
            break;
          case "chat_reconnect_failed":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: `Couldn't reconnect chat (${
                  typeof parsed.reason === "string" ? parsed.reason : "unknown"
                }). Retrying…`,
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.89 — auto-reconnect gave up after the streak cap.
          // Chat stays available for a manual Reconnect Chat.
          case "chat_gave_up":
            setChatStatus("disconnected");
            setChatMessages((prev) => [
              ...prev,
              {
                kind: "system",
                body: "Gave up auto-reconnecting — the sender seems to be offline. Click Reconnect Chat to try again.",
                at: Date.now(),
              },
            ]);
            break;
          // v0.1.89 — never leave the UI stuck on "Connecting…": any
          // session error resolves to disconnected.
          case "chat_session_error":
            setChatStatus((cur) =>
              cur === "connected" ? cur : "disconnected"
            );
            break;
        }
      })
    );

    unlisteners.push(
      win.listen<string>("recv:stderr", (e) => {
        setRecvLogs((prev) => [...prev, "[stderr] " + e.payload]);
      })
    );

    unlisteners.push(
      win.listen<number | null>("recv:exit", (e) => {
        setRecvLogs((prev) => [...prev, `[exit] code=${e.payload}`]);
        // v0.1.88 (#6) — if this exit was a user-initiated Stop, show
        // "Stopped", not "error". The CLI emits `receive_stopped`
        // before exiting on a clean stop, which already flips status
        // to "stopped"; this is the belt-and-suspenders path for when
        // only the exit arrives.
        if (recvStoppingRef.current) {
          recvStoppingRef.current = false;
          setRecvStatus((curr) =>
            curr === "complete" ? curr : "stopped"
          );
          return;
        }
        // If the receive sidecar exited mid-flight, mark it as an error
        // instead of leaving the UI stuck on "connecting"/"downloading".
        setRecvStatus((curr) =>
          curr === "connecting" ||
          curr === "downloading" ||
          curr === "exporting" ||
          curr === "waiting_for_sender"
            ? "error"
            : curr
        );
        setRecvError((prev) =>
          prev ??
          (e.payload !== 0 && e.payload !== null
            ? `The receive ended unexpectedly (exit code ${e.payload}). The sender may have stopped sharing, or the connection dropped. Your partial download is saved — try Resume.`
            : e.payload === null
            ? "The receive ended unexpectedly. The sender may have stopped sharing, or the connection dropped. Your partial download is saved — try Resume."
            : null)
        );
      })
    );


    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [win]);

  // ---------- Send actions ----------

  async function pickFile() {
    const result = await open({ multiple: false, directory: false });
    if (typeof result === "string") {
      // One-step send: picking a file immediately kicks off the transfer.
      // v0.1.85 — a fresh Pick File implies a fresh ticket; clear any
      // preserved tickets from a previous Resume so the user sees the
      // new sidecar's actual ticket variants.
      preserveTicketsOnNextSession.current = false;
      setIsPreservedTicket(false);
      setFilePath(result);
      await startSendWith(result, false);
    }
  }

  async function pickFolder() {
    const result = await open({ multiple: false, directory: true });
    if (typeof result === "string") {
      // One-step folder send: the whole folder becomes a HashSeq collection.
      preserveTicketsOnNextSession.current = false;
      setIsPreservedTicket(false);
      setFilePath(result);
      await startSendWith(result, true);
    }
  }

  async function startSendWith(
    targetPath: string,
    asFolder: boolean,
    // v0.1.88 (#5) — on Resume, the prior ticket + size enable the
    // cached-blob fast path (skips re-hashing). Undefined for a fresh
    // send.
    reuse?: { ticket: string; size?: number }
  ) {
    setSendStatus("creating_ticket");
    setIsFolderSend(asFolder);
    setSendFileCount(null);
    setReceivers([]);
    receiverSpeedRef.current.clear();
    labelsByEndpointRef.current.clear();
    connToEndpointRef.current.clear();
    setSendStartedAt(null);
    setSendCompletedAt(null);
    // v0.1.85 — only clear tickets when NOT in preserve mode. When
    // preserve mode is on (we're inside resumeLastSend), the
    // tickets state is intentionally pre-populated below and we
    // want to keep showing it through the new sidecar's startup.
    if (!preserveTicketsOnNextSession.current) {
      setTickets(null);
    }
    setSendError(null);
    setSendLogs([]);
    setSendProgress(null);
    setSendSpeed(null);
    sendSpeedRef.current = [];
    setSendTotalSize(null);
    try {
      // v0.1.95 — if a send process is already alive (kept up for chat
      // after Stop), start the NEW transfer IN-PROCESS so the live chat
      // survives — no respawn. Only for a fresh pick; a reuse/resume goes
      // through the cached-blob fast path below.
      let warm = false;
      if (!reuse) {
        try {
          warm = await invoke<boolean>("start_send_new_warm", {
            filePath: targetPath,
          });
        } catch (e) {
          console.error(e);
        }
      }
      if (!warm) {
        await invoke("start_send", {
          filePath: targetPath,
          connectionMode,
          // v0.1.88 (#5) — fast-path reuse args (undefined for a fresh send).
          reuseTicket: reuse?.ticket,
          reuseSize: reuse?.size,
        });
      }
      // Persist the path on successful spawn — even if the transfer is later
      // interrupted, the user can resume with one click. isFolder is kept so
      // the resumed share line gets the right folder hint. Tickets are
      // saved later, in the ticket_variants handler, so a fresh-Pick-File
      // path doesn't carry over stale tickets from a prior session.
      const existing = loadJson<LastSend>(LS_LAST_SEND);
      const entry: LastSend = {
        filePath: targetPath,
        savedAt: Date.now(),
        isFolder: asFolder,
        // Preserve the ALREADY-SAVED tickets ONLY when we're resuming the
        // same file — otherwise drop them so a fresh share doesn't display
        // stale variants.
        tickets:
          preserveTicketsOnNextSession.current &&
          existing?.filePath === targetPath
            ? existing?.tickets
            : undefined,
      };
      saveJson(LS_LAST_SEND, entry);
      setLastSend(entry);
    } catch (err) {
      setSendError(String(err));
      setSendStatus("error");
    }
  }

  async function resumeLastSend() {
    if (!lastSend) return;
    // v0.1.93 — try a WARM resume first. If the send process is still
    // alive (kept up for chat after Stop), it resumes serving in-process
    // with no respawn and no spurious "exited" error — and the chat
    // connection is undisturbed. Falls back to the cold respawn below
    // when the process had already exited.
    try {
      const warm = await invoke<boolean>("resume_send_warm");
      if (warm) {
        setFilePath(lastSend.filePath);
        setSendStatus("sharing");
        return;
      }
    } catch (err) {
      console.error(err);
    }
    setFilePath(lastSend.filePath);
    // v0.1.85 — pre-populate the displayed tickets with the saved
    // variants from the original session. The NodeID portion of
    // these tickets is still valid because per-file identity gives
    // the resumed sidecar the same ephemeral key; only the encoded
    // IP/port section drifts. Receivers holding the original share
    // line will still reach the sender via iroh discovery on the
    // unchanged NodeID. The hint banner below
    // (`isPreservedTicket`) tells the user that's what's happening.
    if (lastSend.tickets) {
      setTickets(lastSend.tickets);
      preserveTicketsOnNextSession.current = true;
      setIsPreservedTicket(true);
    }
    // v0.1.88 (#5) — enable the cached-blob fast path. The CLI only
    // reuses single Raw blobs, so folders harmlessly fall through to
    // re-hash even when we pass the ticket.
    const reuse =
      lastSend.tickets?.full && !lastSend.isFolder
        ? { ticket: lastSend.tickets.full, size: lastSend.totalSize }
        : undefined;
    await startSendWith(
      lastSend.filePath,
      lastSend.isFolder ?? false,
      reuse
    );
  }

  async function stopSend() {
    try {
      await invoke("stop_send");
    } catch (err) {
      console.error(err);
    }
    // v0.1.90 — Stop Send no longer ends the process: it stops serving
    // the file but the sidecar stays alive for chat. Reflect "stopped"
    // (the CLI confirms with a `send_stopped` event) rather than
    // resetting to "idle" — that would hide the live chat's Reconnect
    // affordance and the stopped state.
    setSendStatus("stopped");
  }

  // ---------- Receive actions ----------

  async function suggestedAbsolutePath(name: string): Promise<string> {
    // Tauri's save dialog wants an absolute path for defaultPath; a bare
    // filename quietly falls back to "Untitled" on macOS. Anchor at
    // ~/Downloads (which is what the user expects for received files anyway).
    try {
      const dir = await downloadDir();
      const sep = dir.endsWith("/") ? "" : "/";
      return `${dir}${sep}${name}`;
    } catch {
      return name;
    }
  }

  async function pickDestination() {
    const parsed = parseReceiveInput(ticketInput);

    // Folder ticket: the user picks a PARENT directory, and we extract the
    // collection into <parent>/<foldername>. A save-as dialog wouldn't make
    // sense for a directory.
    if (parsed?.isFolder) {
      const dir = await open({
        directory: true,
        multiple: false,
        title: "Choose where to save the received folder",
      });
      if (typeof dir === "string") {
        const name = parsed.suggestedName ?? "received-folder";
        const sep = dir.endsWith("/") ? "" : "/";
        userPickedDest.current = true;
        setOutputPath(`${dir}${sep}${name}`);
        setRecvError(null);
        setRecvProgress(null);
        setRecvStatus("idle");
      }
      return;
    }

    const defaultPath = parsed?.suggestedName
      ? await suggestedAbsolutePath(parsed.suggestedName)
      : undefined;
    const result = await save({
      title: "Save received file as…",
      defaultPath,
    });
    if (typeof result === "string") {
      userPickedDest.current = true;
      setOutputPath(result);
      setRecvError(null);
      setRecvProgress(null);
      setRecvStatus("idle");
    }
  }

  async function startReceiveWith(rawInput: string, dest: string) {
    const parsed = parseReceiveInput(rawInput);
    const ticket = parsed?.ticket ?? null;
    if (!ticket) {
      setRecvError(
        "No valid ticket found in the input. Tickets start with 'blob' and are around 250 characters of letters and digits. Paste the ticket (or the full 'orbitxfer-iroh-cli receive …' line) and try again."
      );
      setRecvStatus("error");
      return;
    }
    if (!dest) {
      setRecvError(
        "Pick a destination file first — click 'Pick destination…' and choose where to save the incoming file."
      );
      setRecvStatus("error");
      return;
    }

    // If the ticket carries a filename, override whatever basename the
    // user picked in the save dialog. The user picks the FOLDER; the
    // filename comes from the ticket so the received file keeps its
    // original name and extension. Fixes the "saved as Untitled" footgun
    // when the user clicked Pick destination before pasting the ticket.
    let finalDest = dest;
    if (parsed?.suggestedName) {
      const destBasename = basename(dest);
      if (destBasename !== parsed.suggestedName) {
        const destDir = dest.substring(
          0,
          dest.length - destBasename.length
        );
        finalDest = destDir + parsed.suggestedName;
        setOutputPath(finalDest);
      }
    }
    // v0.1.86 — disk-space preflight. If the ticket carries a
    // canonical size (most do, via the `# size=…` annotation on the
    // share line), ask the OS how much free space is at the
    // destination, and confirm with the user if it's not enough.
    // Safety margin: 64 MiB or 1% of file size, whichever's larger —
    // covers filesystem metadata + small over-reports.
    const seededTotalForCheck = parsed?.canonicalSize ?? null;
    if (seededTotalForCheck !== null && seededTotalForCheck > 0) {
      try {
        const free = (await invoke<number>("check_disk_space", {
          path: finalDest,
        })) as number;
        if (free > 0) {
          const margin = Math.max(
            64 * 1024 * 1024,
            Math.floor(seededTotalForCheck * 0.01)
          );
          if (free < seededTotalForCheck + margin) {
            const proceed = await ask(
              `This download is ${formatBytes(
                seededTotalForCheck
              )}, but only ${formatBytes(
                free
              )} is free at the destination. Continuing anyway will likely run out of disk space partway through.\n\nContinue anyway?`,
              {
                title: "Not enough free disk space",
                kind: "warning",
                okLabel: "Continue anyway",
                cancelLabel: "Cancel receive",
              }
            );
            if (!proceed) {
              setRecvStatus("idle");
              return;
            }
          }
        }
      } catch (err) {
        // Can't probe — silently skip. The CLI will still log free
        // space and fail informatively if the disk fills up.
        console.warn("disk space check failed:", err);
      }
    }

    setRecvStatus("connecting");
    // Keep the size-seeded total if we have one. Reset bytes to 0 but
    // preserve the denominator so the bar doesn't jump to indeterminate
    // for a frame between Start Receive and the first download_size /
    // download_progress event from the CLI.
    const seededTotal = parsed?.canonicalSize ?? null;
    setRecvProgress(
      seededTotal !== null
        ? { bytes: 0, total: seededTotal, phase: "download" }
        : null
    );
    setRecvError(null);
    setRecvLogs([]);
    setRecvSpeed(null);
    recvSpeedRef.current = [];
    setRecvFolderFileCount(null);
    setRecvFolderFiles(null);
    setRecvFolderTruncated(false);
    setRecvCurrentFile(null);
    setRecvStartedAt(null);
    setRecvCompletedAt(null);
    // v0.1.88 — clear stop/retry-reason state for the fresh receive.
    recvStoppingRef.current = false;
    setRecvRetryInfo(null);
    setRecvRetryReason(null);
    try {
      // v0.1.98 — if a receiver process is still alive (lingering for
      // chat after a previous transfer), receive this NEW ticket
      // IN-PROCESS: the chat survives and we reuse the warm,
      // already-connected endpoint instead of cold-respawning (which
      // dropped chat and raced connection setup, erroring the first try).
      // Returns false when no process is running → cold start below.
      let warm = false;
      try {
        warm = await invoke<boolean>("start_receive_new_warm", {
          ticket,
          outputPath: finalDest,
          expectedSize: seededTotal !== null ? seededTotal : undefined,
        });
      } catch (err) {
        console.warn("warm new-receive failed; falling back to cold start:", err);
      }
      if (!warm) {
        // Pass expectedSize so the CLI seeds its own download total from
        // the same canonical value and emits `download_size` immediately —
        // long before observe() lands. Both sides now share the exact
        // same denominator. Pass undefined when missing so Tauri's serde
        // sees Option<u64>::None rather than 0.
        await invoke("start_receive", {
          ticket,
          outputPath: finalDest,
          expectedSize: seededTotal !== null ? seededTotal : undefined,
          // Opt-in: only send a label if the user typed one.
          receiverLabel: receiverLabel.trim() ? receiverLabel.trim() : undefined,
        });
      }
      const entry: LastReceive = {
        ticketInput: rawInput,
        outputPath: finalDest,
        savedAt: Date.now(),
      };
      saveJson(LS_LAST_RECV, entry);
      setLastRecv(entry);
    } catch (err) {
      setRecvError(String(err));
      setRecvStatus("error");
    }
  }

  async function startReceive() {
    await startReceiveWith(ticketInput, outputPath ?? "");
  }

  async function resumeLastReceive() {
    if (!lastRecv) return;
    setTicketInput(lastRecv.ticketInput);
    setOutputPath(lastRecv.outputPath);
    // Suppress the auto-fill effect from clobbering the resumed destination.
    userPickedDest.current = true;
    // v0.1.94 — try a WARM resume first. If the receive process is still
    // alive (kept up for chat after Stop), it re-runs the download
    // in-process with no respawn and no "ended unexpectedly" error — and
    // chat stays connected. Falls back to the cold respawn otherwise.
    try {
      const warm = await invoke<boolean>("resume_receive_warm");
      if (warm) {
        recvStoppingRef.current = false;
        setRecvError(null);
        setRecvStatus("downloading");
        return;
      }
    } catch (err) {
      console.error(err);
    }
    await startReceiveWith(lastRecv.ticketInput, lastRecv.outputPath);
  }

  async function stopReceive() {
    // v0.1.88 (#6) — show "Stopping…" immediately and flag that this
    // exit is user-initiated, so the recv:exit handler shows
    // "Stopped" instead of "error / exited with code null". The CLI
    // cancels the in-flight download promptly and emits
    // `receive_stopped`.
    //
    // v0.1.90 — Stop Receive no longer ends the process: it cancels
    // the download but the sidecar stays alive for chat (chat outlives
    // the transfer). The recv:exit handler fires only later, when chat
    // closes or the window is closed.
    recvStoppingRef.current = true;
    setRecvStatus("stopping");
    setRecvRetryInfo(null);
    try {
      await invoke("stop_receive");
    } catch (err) {
      console.error(err);
    }
  }

  // ---------- v0.1.85 — Chat actions ----------

  /// Append a local message and ship it across the chat ALPN. Empty
  /// strings are dropped (no point sending zero-length frames). The
  /// optimistic local append happens BEFORE the invoke so the user
  /// sees their text in the scrollback instantly; if the CLI
  /// responds with `chat_send_failed`, the system line surfaces it.
  async function sendChatMessage() {
    const body = chatInput.trim();
    if (!body) return;
    if (chatStatus !== "connected") return;
    setChatMessages((prev) => [
      ...prev,
      { kind: "you", body, at: Date.now() },
    ]);
    setChatInput("");
    try {
      await invoke("send_chat_message", { body });
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          kind: "system",
          body: `Send failed: ${err}`,
          at: Date.now(),
        },
      ]);
    }
  }

  /// Close the chat with a Bye. Goes through the active sidecar's
  /// stdin; the sidecar writes Bye and closes the chat stream
  /// (without affecting the transfer).
  async function stopChat() {
    try {
      await invoke("stop_chat");
    } catch (err) {
      console.error(err);
    }
    // Optimistically reflect the close locally; the sidecar will also
    // emit `chat_disconnected` which will overwrite this.
    // v0.1.92 — Stop Chat is REVERSIBLE now: the coordinator stays
    // alive, so the Reconnect Chat button is intentionally still
    // offered on this side (no more suppression).
    setChatStatus("disconnected");
  }

  // v0.1.88 (#8/#9) — re-dial a dropped chat. Works while the receive
  // process is still alive (downloading / waiting_for_sender / the
  // post-transfer keepalive). The CLI re-connects the chat ALPN to
  // the same sender and emits chat_reconnecting → chat_connected (or
  // chat_reconnect_failed).
  async function reconnectChat() {
    try {
      await invoke("reconnect_chat");
    } catch (err) {
      console.error(err);
    }
  }

  // v0.1.86 — Drive the "next retry in X s" countdown by ticking once
  // per second while recvRetryInfo is set. We use a state increment
  // rather than directly mutating recvRetryInfo so the existing
  // event handler stays the single source of truth for the actual
  // values; the tick is purely a re-render trigger that the render
  // function uses to recompute `nextRetryAt - Date.now()`.
  useEffect(() => {
    if (recvRetryInfo === null) return;
    const id = setInterval(() => {
      setRetryCountdownTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [recvRetryInfo]);

  // v0.1.89 — explicit window re-fit on the major state transitions
  // that grow/shrink the layout in waves (mode switch, ticket appears,
  // chat opens, progress/summary/retry panels appear). The
  // ResizeObserver usually catches these, but firing here too — after
  // React has committed the new DOM (one tick later) — makes the fit
  // reliable even when content lands in a burst that the observer's
  // debounce might measure mid-render.
  useEffect(() => {
    const id = window.setTimeout(fitWindow, 80);
    return () => window.clearTimeout(id);
  }, [
    fitWindow,
    mode,
    sendStatus,
    recvStatus,
    chatStatus,
    chatMessages.length,
    tickets,
    isPreservedTicket,
    recvProgress,
    recvRetryInfo,
    receivers.length,
    sendProgress,
  ]);

  // ---------- Render ----------

  const parsedReceive = parseReceiveInput(ticketInput);
  const parsedTicket = parsedReceive?.ticket ?? null;
  const suggestedName = parsedReceive?.suggestedName ?? null;
  const isFolderReceive = parsedReceive?.isFolder ?? false;

  const recvPercent =
    recvProgress && recvProgress.total && recvProgress.total > 0
      ? Math.min(100, (recvProgress.bytes / recvProgress.total) * 100)
      : null;

  const recvBusy =
    recvStatus === "connecting" ||
    recvStatus === "downloading" ||
    recvStatus === "exporting" ||
    // v0.1.86 — the sidecar is still alive during Phase 2 wait,
    // so the panel is "busy" from the user's POV. This also keeps
    // Stop Receive enabled (it's the cancel-the-waiting affordance).
    recvStatus === "waiting_for_sender";

  // Brief hashing window where the connection-mode fieldset is locked.
  const sendBusy = sendStatus === "creating_ticket";
  // The "a send is going on, don't start another one in this window"
  // gate. Stays true through hashing + sharing + the post-first-receiver
  // "complete" state (because the sidecar keeps serving until Stop or
  // window close). Pick File / Pick Folder / Resume / mode-switch tabs
  // all use this so the user can't silently kill an in-flight share.
  const sendActive =
    sendStatus === "creating_ticket" ||
    sendStatus === "sharing" ||
    sendStatus === "complete";

  // v0.1.90 — is a sidecar that can host chat still alive? Chat now
  // outlives the transfer (Stop Send / Stop Receive keep the process
  // up), so Reconnect Chat is offered whenever the process is alive on
  // EITHER side — including after a Stop — not just mid-download. Used
  // to gate the Reconnect Chat button. Excludes idle/error (process
  // gone) and the pre-serving/pre-connect states.
  const chatProcessAlive =
    mode === "receive"
      ? recvStatus === "downloading" ||
        recvStatus === "waiting_for_sender" ||
        recvStatus === "exporting" ||
        recvStatus === "complete" ||
        recvStatus === "stopped"
      : sendStatus === "sharing" ||
        sendStatus === "complete" ||
        sendStatus === "stopped";

  // Pick which ticket variant to put in the share line based on the
  // selected connection mode. The CLI emits all three variants (full /
  // relay / direct) with every send, so toggling the radio re-renders
  // this instantly — no re-send needed. If the preferred variant isn't
  // available (e.g. no direct IPs behind certain NATs), fall back to the
  // full ticket and flag it so the user knows why.
  const selectedTicket: string | null = !tickets
    ? null
    : connectionMode === "direct_only"
    ? tickets.direct ?? tickets.full
    : connectionMode === "relay_only"
    ? tickets.relay ?? tickets.full
    : tickets.full;

  const ticketFellBack =
    tickets !== null &&
    ((connectionMode === "direct_only" && !tickets.direct) ||
      (connectionMode === "relay_only" && !tickets.relay));

  // ---- Completion-summary stats (sender + receiver) ----
  // Computed once per render rather than stored, so they stay in sync
  // with the latest timestamps / canonical size.
  const sendElapsedSec =
    sendStartedAt !== null && sendCompletedAt !== null
      ? Math.max(0, (sendCompletedAt - sendStartedAt) / 1000)
      : null;
  const sendAvgSpeed =
    sendTotalSize !== null &&
    sendElapsedSec !== null &&
    sendElapsedSec > 0
      ? sendTotalSize / sendElapsedSec
      : null;
  const recvElapsedSec =
    recvStartedAt !== null && recvCompletedAt !== null
      ? Math.max(0, (recvCompletedAt - recvStartedAt) / 1000)
      : null;
  // For receive total: prefer the latest progress total, else fall back to
  // the share-line's canonical size.
  const recvTotalForSummary =
    recvProgress?.total ?? parsedReceive?.canonicalSize ?? null;
  const recvAvgSpeed =
    recvTotalForSummary !== null &&
    recvElapsedSec !== null &&
    recvElapsedSec > 0
      ? recvTotalForSummary / recvElapsedSec
      : null;

  return (
    <main className="container" ref={containerRef}>
      <header className="app-header">
        <div>
          <h1>OrbitXfer</h1>
          <p className="subtitle">Peer-to-peer file transfer over Iroh</p>
        </div>
        <div className="app-header-right">
          {keepAwakeActive && (
            <span
              className="keep-awake-badge"
              title={`OrbitXfer is preventing your ${platformLabel} from sleeping while a transfer is in progress.`}
            >
              <span aria-hidden="true">☕</span> Keeping {platformLabel} awake
            </span>
          )}
          {/* v0.1.87 — "+ New Transfer Window" lives in the mode-row
              beside the Send/Receive tabs. The header slot stays as
              the home for the keep-awake badge. */}
        </div>
      </header>

      {identityResetAt !== null && (
        <div className="reset-banner" role="status">
          Identity reset. Every share ticket you've previously sent is now
          invalid — old recipients can no longer reach this Mac via iroh.
        </div>
      )}

      {menuMessage !== null && (
        <div className="menu-banner" role="status">
          {menuMessage}
        </div>
      )}

      {/* v0.1.86 — Option B: cross-session resume banner. Renders
          when the most recent saved receive was never marked as
          completed (i.e., it was interrupted or the app was closed
          mid-transfer) and the user hasn't dismissed it this
          session. Hidden once they click Resume Last Receive (since
          recvBusy goes true) or Dismiss. */}
      {lastRecv &&
        lastRecv.completed !== true &&
        !resumeBannerDismissed &&
        !recvBusy &&
        mode === "receive" && (
          <div className="resume-banner-prominent" role="status">
            <div className="resume-banner-text">
              <strong>↻ Incomplete download from a previous session</strong>
              <p>
                <code title={lastRecv.outputPath}>
                  {basename(lastRecv.outputPath)}
                </code>{" "}
                was interrupted. You can resume from where it left off — the
                partial data is still on disk.
              </p>
            </div>
            <div className="resume-banner-actions">
              <button onClick={resumeLastReceive} className="primary">
                Resume Download
              </button>
              <button
                onClick={() => setResumeBannerDismissed(true)}
                className="ghost-button"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

      {/* v0.1.87 — the "+ New Transfer Window" button moves up here,
          to the right of the Send/Receive tabs (it used to live in
          each panel's actions row). A single shared button instead
          of one per panel. */}
      <div className="mode-row">
        <div className="mode-switch" role="tablist" aria-label="Window mode">
          <button
            role="tab"
            aria-selected={mode === "send"}
            className={mode === "send" ? "active" : ""}
            onClick={() => setMode("send")}
            disabled={sendActive || recvBusy}
          >
            Send
          </button>
          <button
            role="tab"
            aria-selected={mode === "receive"}
            className={mode === "receive" ? "active" : ""}
            onClick={() => setMode("receive")}
            disabled={sendActive || recvBusy}
          >
            Receive
          </button>
        </div>
        <button
          className="ghost-button new-window-button"
          onClick={openNewTransferWindow}
        >
          + New Transfer Window
        </button>
      </div>

      {mode === "send" && (
        <section className="panel">
          <h2>Send a file</h2>

          {/* v0.1.87 — connection mode is collapsed by default to keep
              the panel compact. The summary shows the current choice
              inline so it's discoverable without expanding. */}
          <details className="connection-disclosure">
            <summary>
              Connection:{" "}
              <span className="connection-current">
                {CONNECTION_MODE_LABELS[connectionMode]}
              </span>
            </summary>
            <fieldset className="connection-mode" disabled={sendBusy}>
              <label>
                <input
                  type="radio"
                  name={`conn-${win.label}`}
                  value="full"
                  checked={connectionMode === "full"}
                  onChange={() => setConnectionMode("full")}
                />
                Direct + Relay fallback{" "}
                <span className="recommended">(recommended)</span>
              </label>
              {connectionMode === "full" && (
                <p className="hint connection-desc">
                  {CONNECTION_MODE_DESCRIPTIONS.full}
                </p>
              )}

              <label>
                <input
                  type="radio"
                  name={`conn-${win.label}`}
                  value="relay_only"
                  checked={connectionMode === "relay_only"}
                  onChange={() => setConnectionMode("relay_only")}
                />
                Relay only (no direct IPs)
              </label>
              {connectionMode === "relay_only" && (
                <p className="hint connection-desc">
                  {CONNECTION_MODE_DESCRIPTIONS.relay_only}
                </p>
              )}

              <label>
                <input
                  type="radio"
                  name={`conn-${win.label}`}
                  value="direct_only"
                  checked={connectionMode === "direct_only"}
                  onChange={() => setConnectionMode("direct_only")}
                />
                Direct only (no relay)
              </label>
              {connectionMode === "direct_only" && (
                <p className="hint connection-desc">
                  {CONNECTION_MODE_DESCRIPTIONS.direct_only}
                </p>
              )}

              <p className="hint">
                All three modes are end-to-end encrypted — the relay can never
                read your files, it only helps route the connection.
              </p>
            </fieldset>
          </details>

          <div className="actions">
            <button onClick={pickFile} disabled={sendActive}>
              Pick File…
            </button>
            <button onClick={pickFolder} disabled={sendActive}>
              Pick Folder…
            </button>
            <button onClick={stopSend} disabled={!sendActive}>
              Stop
            </button>
            {/* v0.1.87 — Resume Last Send moved into the actions row,
                right-justified, taking the slot New Window vacated. */}
            {lastSend && !sendActive && (
              <button
                className="resume-button actions-resume"
                onClick={resumeLastSend}
                title={lastSend.filePath}
              >
                ↻ Resume: <code>{basename(lastSend.filePath)}</code>
              </button>
            )}
          </div>

          {filePath && (
            <p className="filepath">
              {filePath}
              {isFolderSend && sendFileCount !== null && (
                <>
                  {" "}
                  · {sendFileCount} file{sendFileCount === 1 ? "" : "s"}
                </>
              )}
            </p>
          )}

          {sendStatus !== "complete" && (
            <p className="status">
              Status: <code>{sendStatus}</code>
            </p>
          )}

          {sendError && <p className="error">{sendError}</p>}

          {sendProgress && sendProgress.phase === "hashing" && (() => {
            const pct =
              sendProgress.total && sendProgress.total > 0
                ? Math.min(100, (sendProgress.bytes / sendProgress.total) * 100)
                : null;
            const remaining =
              sendProgress.total !== null
                ? Math.max(0, sendProgress.total - sendProgress.bytes)
                : 0;
            const eta =
              sendProgress.total !== null
                ? formatEta(remaining, sendSpeed)
                : null;
            const phaseLabel =
              sendProgress.phase === "hashing" ? "Hashing" : "Uploading";
            return (
              <div className="progress-box">
                <div className="progress-header">
                  <span className="progress-phase">{phaseLabel}</span>
                  {pct !== null && (
                    <span className="progress-pct">{pct.toFixed(1)}%</span>
                  )}
                </div>
                {sendProgress.total ? (
                  <progress
                    value={sendProgress.bytes}
                    max={sendProgress.total}
                  />
                ) : (
                  <progress />
                )}
                <div className="progress-footer">
                  <span className="progress-bytes">
                    {formatBytes(sendProgress.bytes)}
                    {sendProgress.total !== null && (
                      <> / {formatBytes(sendProgress.total)}</>
                    )}
                  </span>
                  {sendSpeed !== null && (
                    <>
                      <span className="progress-sep">·</span>
                      <span className="progress-speed">
                        {formatSpeed(sendSpeed)}
                      </span>
                    </>
                  )}
                  {eta !== null && (
                    <>
                      <span className="progress-sep">·</span>
                      <span className="progress-eta">ETA {eta}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {tickets && selectedTicket && (
            <div className="ticket-box">
              <h3>Your Share Ticket:</h3>
              {isPreservedTicket && (
                <p className="preserved-ticket-hint" role="status">
                  ↻ Same ticket as before — anyone you already shared
                  this with can keep using it. (The sender's identity
                  is preserved across Stop → Resume; the share line you
                  see here is the original one.)
                </p>
              )}
              <p className="hint">
                Share this Ticket with the recipient to start the file
                transfer. They just need to paste it into Receive and click
                Start Receive.
              </p>
              <textarea
                readOnly
                value={
                  filePath
                    ? `orbitxfer-iroh-cli receive ${selectedTicket} ${basename(filePath)}${
                        isFolderSend ? "/" : ""
                      }${
                        sendTotalSize !== null
                          ? `  # size=${sendTotalSize}`
                          : ""
                      }`
                    : selectedTicket
                }
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                rows={2}
              />
              <p className="keep-open-warning" role="status">
                ⚠ Don't close this window. The file is only available to
                download while this window stays open.
              </p>
              {ticketFellBack && (
                <p className="hint">
                  {connectionMode === "direct_only"
                    ? "No direct address is available on this network — sharing the full ticket (direct + relay) instead."
                    : "No relay address is available — sharing the full ticket (direct + relay) instead."}
                </p>
              )}
            </div>
          )}

          {receivers.length > 0 && (
            <div className="receivers-panel">
              <h3>Receivers ({receivers.length})</h3>
              <p className="hint">
                Who's downloading right now. Names are provided by the
                recipient and aren't verified.
              </p>
              <ul className="receiver-list">
                {receivers.map((r, i) => {
                  const pct =
                    r.total && r.total > 0
                      ? Math.min(100, (r.bytes / r.total) * 100)
                      : null;
                  const name =
                    r.label && r.label.trim()
                      ? r.label
                      : `Receiver ${i + 1}`;
                  const nodeShort = r.endpointId
                    ? `${r.endpointId.slice(0, 8)}…`
                    : null;
                  // Per-receiver ETA: estimate of time-to-go from this
                  // receiver's rolling speed + remaining bytes.
                  const eta =
                    r.total !== null && r.speed !== null && r.speed > 0
                      ? formatEta(Math.max(0, r.total - r.bytes), r.speed)
                      : null;
                  return (
                    <li key={r.connectionId} className="receiver-row">
                      <div className="receiver-head">
                        <span className="receiver-name">{name}</span>
                        {nodeShort && (
                          <span className="receiver-node">{nodeShort}</span>
                        )}
                        <span className={`receiver-status ${r.status}`}>
                          {r.status === "complete"
                            ? "✓ complete"
                            : r.status === "disconnected"
                            ? "disconnected"
                            : pct !== null
                            ? `${pct.toFixed(0)}%`
                            : "connecting…"}
                        </span>
                      </div>
                      {/* v0.1.91/92 — keep the progress bar + byte count
                          FROZEN when a receiver disconnects, instead of
                          hiding it; only the live speed/ETA drop off.
                          v0.1.92: dropped the "interrupted" word — on a
                          RESUMED transfer the sender only serves the
                          missing slice, so it genuinely can't tell a
                          clean finish from an abort. The red
                          "disconnected" status above is the neutral
                          "connection ended" marker; the frozen bytes are
                          what THIS sender actually sent. */}
                      {(r.status === "active" ||
                        r.status === "disconnected") &&
                      r.total ? (
                        <progress value={r.bytes} max={r.total} />
                      ) : r.status === "active" ? (
                        <progress />
                      ) : null}
                      {(r.status === "active" ||
                        r.status === "disconnected") && (
                        <div className="receiver-meta">
                          <span>
                            {formatBytes(r.bytes)}
                            {r.total !== null && (
                              <> / {formatBytes(r.total)}</>
                            )}
                            {r.status === "disconnected" && " sent"}
                          </span>
                          {r.status === "active" && r.speed !== null && (
                            <>
                              <span className="progress-sep">·</span>
                              <span>{formatSpeed(r.speed)}</span>
                            </>
                          )}
                          {r.status === "active" && eta !== null && (
                            <>
                              <span className="progress-sep">·</span>
                              <span>ETA {eta}</span>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {sendStatus === "complete" && (
            <div className="completion-summary">
              <h3>✓ Transfer Complete</h3>
              <dl>
                <div>
                  <dt>Name</dt>
                  <dd>
                    <code>
                      {filePath ? basename(filePath) : "—"}
                      {isFolderSend ? "/" : ""}
                    </code>
                    {isFolderSend && sendFileCount !== null && (
                      <span className="summary-meta">
                        {" "}
                        ({sendFileCount} file
                        {sendFileCount === 1 ? "" : "s"})
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>
                    {sendTotalSize !== null
                      ? formatBytes(sendTotalSize)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>
                    {sendAvgSpeed !== null
                      ? `${formatSpeed(sendAvgSpeed)} (avg)`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>
                    {sendElapsedSec !== null
                      ? formatDuration(sendElapsedSec)
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <details className="logs">
            <summary>Send logs ({sendLogs.length})</summary>
            <pre>{sendLogs.join("\n")}</pre>
          </details>
          

        </section>
      )}

      {mode === "receive" && (
        <section className="panel">
          <h2>Receive a file</h2>

          <label className="field">
            <span>Ticket</span>
            <textarea
              value={ticketInput}
              onChange={(e) => setTicketInput(e.target.value)}
              placeholder="Paste the share ticket here — surrounding text is okay, we'll extract it."
              disabled={recvBusy}
              rows={2}
            />
            {ticketInput.trim() && (
              <p className="diagnostic">
                {parsedTicket ? (
                  <>
                    <span className="diagnostic-ok">✓ Ticket detected</span>{" "}
                    ({parsedTicket.length} chars)
                    {suggestedName && (
                      <>
                        {" · "}
                        <span className="diagnostic-name">
                          {isFolderReceive
                            ? `suggested folder: ${suggestedName}`
                            : `suggested filename: ${suggestedName}`}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="diagnostic-warn">
                    No ticket detected yet — looking for a "blob…" string.
                  </span>
                )}
              </p>
            )}
          </label>

          <label className="field">
            <span>Your label (optional)</span>
            <input
              type="text"
              value={receiverLabel}
              onChange={(e) => setReceiverLabel(e.target.value)}
              placeholder="e.g. Bob's MacBook — leave blank to stay anonymous"
              disabled={recvBusy}
              maxLength={64}
            />
            <p className="hint">
              If you enter a name, the sender will see it in their list of
              receivers so they know who's downloading. Leave it blank to
              send nothing.
            </p>
          </label>

          <div className="actions">
            {/* v0.1.87 — Pick Destination is disabled until a valid
                ticket is present, so the user can't pick a save
                location before they have something to receive. */}
            <button
              onClick={pickDestination}
              disabled={!parsedTicket || recvBusy}
            >
              {isFolderReceive ? "Pick Destination Folder…" : "Pick Destination…"}
            </button>
            {/* v0.1.87 — Start Receive flashes for attention once a
                valid ticket AND a destination are both present and
                we're idle, signalling it's the obvious next step. */}
            <button
              onClick={startReceive}
              disabled={!parsedTicket || !outputPath || recvBusy}
              className={
                parsedTicket && outputPath && !recvBusy && recvStatus === "idle"
                  ? "attention"
                  : ""
              }
            >
              Start Receive
            </button>
            <button onClick={stopReceive} disabled={!recvBusy}>
              Stop
            </button>
            {/* v0.1.87 — Resume Last Receive moved into the actions
                row, right-justified, taking the slot New Window
                vacated. */}
            {lastRecv && !recvBusy && (
              <button
                className="resume-button actions-resume"
                onClick={resumeLastReceive}
                title={`${lastRecv.outputPath}`}
              >
                ↻ Resume: <code>{basename(lastRecv.outputPath)}</code>
              </button>
            )}
          </div>

          {outputPath && <p className="filepath">{outputPath}</p>}

          {recvStatus !== "complete" && (
            <p className="status">
              Status:{" "}
              {/* v0.1.88 (#6) — friendly labels for the new transient
                  states; everything else shows the raw status code. */}
              {recvStatus === "stopping" ? (
                <span className="status-stopping">Stopping…</span>
              ) : recvStatus === "stopped" ? (
                <span className="status-stopped">
                  Stopped. Your partial download is saved — Resume to
                  finish later.
                </span>
              ) : (
                <code>{recvStatus}</code>
              )}
            </p>
          )}

          {recvStatus === "complete" && (
            <div className="completion-summary">
              <h3>✓ Transfer Complete</h3>
              <dl>
                <div>
                  <dt>Name</dt>
                  <dd>
                    <code>
                      {outputPath ? basename(outputPath) : "—"}
                      {isFolderReceive ? "/" : ""}
                    </code>
                    {isFolderReceive && recvFolderFileCount !== null && (
                      <span className="summary-meta">
                        {" "}
                        ({recvFolderFileCount} file
                        {recvFolderFileCount === 1 ? "" : "s"})
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>
                    {recvTotalForSummary !== null
                      ? formatBytes(recvTotalForSummary)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>
                    {recvAvgSpeed !== null
                      ? `${formatSpeed(recvAvgSpeed)} (avg)`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>
                    {recvElapsedSec !== null
                      ? formatDuration(recvElapsedSec)
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {recvError && <p className="error">{recvError}</p>}

          {/* v0.1.86 — Option A: prominent "waiting for sender"
              panel. Renders during the Phase 2 slow-poll retry
              loop. The progress bar above stays frozen at last
              reported bytes so the user sees that partial state
              isn't lost. */}
          {recvStatus === "waiting_for_sender" && recvRetryInfo && (() => {
            // Bind tick so React re-renders this block every second
            // while the countdown is active (the useEffect above
            // increments retryCountdownTick).
            void retryCountdownTick;
            const now = Date.now();
            const nextRetrySecs = Math.max(
              0,
              Math.round((recvRetryInfo.nextRetryAt - now) / 1000)
            );
            const remainingSecs = Math.max(
              0,
              Math.round(
                (recvRetryInfo.timeRemainingMs -
                  (now - (recvRetryInfo.nextRetryAt - recvRetryInfo.nextRetryInMs))) /
                  1000
              )
            );
            return (
              <div className="waiting-for-sender">
                <h3>
                  <span className="waiting-pulse" aria-hidden="true">
                    ●
                  </span>
                  {"  "}Waiting for sender to come back online
                </h3>
                {/* v0.1.88 (#7) — plain-English reason for the wait. */}
                {recvRetryReason && (
                  <p className="waiting-reason">{recvRetryReason}</p>
                )}
                <dl className="waiting-stats">
                  <div>
                    <dt>Next retry in</dt>
                    <dd>{nextRetrySecs}s</dd>
                  </div>
                  <div>
                    <dt>Will keep trying for</dt>
                    <dd>{formatDuration(remainingSecs)}</dd>
                  </div>
                  <div>
                    <dt>Attempts so far</dt>
                    <dd>
                      {recvRetryInfo.phase2Attempt}{" "}
                      (Phase 2)
                    </dd>
                  </div>
                </dl>
                <p className="hint">
                  Your partial download is preserved. If the sender
                  reconnects, the transfer resumes automatically.
                  Click <em>Stop Receive</em> to give up now.
                </p>
              </div>
            );
          })()}

          {recvStatus !== "complete" && recvProgress && (() => {
            const remaining =
              recvProgress.total !== null
                ? Math.max(0, recvProgress.total - recvProgress.bytes)
                : 0;
            const eta =
              recvProgress.total !== null
                ? formatEta(remaining, recvSpeed)
                : null;
            const phaseLabel =
              recvProgress.phase === "export"
                ? "Writing to disk"
                : "Downloading";
            return (
              <div className="progress-box">
                <div className="progress-header">
                  {/* v0.1.91 — when the transfer is interrupted (Stop, or
                      the sender dropped), freeze the progress and show a
                      red "Disconnected" marker, mirroring the red
                      "disconnected" status on the Send side. */}
                  <span className="progress-phase">
                    {recvStatus === "stopped"
                      ? "Transfer interrupted"
                      : phaseLabel}
                  </span>
                  {recvStatus === "stopped" ? (
                    <span className="progress-disconnected">
                      ● Disconnected
                    </span>
                  ) : (
                    recvPercent !== null && (
                      <span className="progress-pct">
                        {recvPercent.toFixed(1)}%
                      </span>
                    )
                  )}
                </div>
                {recvProgress.total ? (
                  <progress
                    // v0.1.93 — cap at total. The resume "already-cached"
                    // baseline is an over-estimate (includes store
                    // metadata overhead), so baseline + session bytes can
                    // exceed the real total and read >100%.
                    value={Math.min(recvProgress.bytes, recvProgress.total)}
                    max={recvProgress.total}
                  />
                ) : (
                  // Indeterminate: total unknown until export_size arrives.
                  <progress />
                )}
                <div className="progress-footer">
                  <span className="progress-bytes">
                    {formatBytes(
                      recvProgress.total !== null
                        ? Math.min(recvProgress.bytes, recvProgress.total)
                        : recvProgress.bytes
                    )}
                    {recvProgress.total !== null && (
                      <> / {formatBytes(recvProgress.total)}</>
                    )}
                  </span>
                  {recvSpeed !== null && (
                    <>
                      <span className="progress-sep">·</span>
                      <span className="progress-speed">
                        {formatSpeed(recvSpeed)}
                      </span>
                    </>
                  )}
                  {eta !== null && (
                    <>
                      <span className="progress-sep">·</span>
                      <span className="progress-eta">ETA {eta}</span>
                    </>
                  )}
                </div>
                {recvProgress.phase === "export" && recvCurrentFile && (
                  <p className="progress-file">
                    Writing file {recvCurrentFile.index}
                    {recvCurrentFile.files
                      ? ` of ${recvCurrentFile.files}`
                      : ""}
                    : <code>{recvCurrentFile.name}</code>
                  </p>
                )}
                {recvProgress.phase === "download" &&
                  recvFolderFileCount !== null && (
                    <div className="progress-files">
                      <span className="progress-hint">
                        Folder · {recvFolderFileCount} file
                        {recvFolderFileCount === 1 ? "" : "s"}
                      </span>
                      {recvFolderFiles && recvFolderFiles.length > 0 && (
                        <details>
                          <summary>show files</summary>
                          <ul className="file-list">
                            {recvFolderFiles.map((n, i) => (
                              <li key={i}>{n}</li>
                            ))}
                            {recvFolderTruncated && (
                              <li className="more">
                                …and{" "}
                                {recvFolderFileCount - recvFolderFiles.length}{" "}
                                more
                              </li>
                            )}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                {recvProgress.phase === "download" &&
                  recvProgress.total === null && (
                    <p className="progress-hint">
                      Total size becomes known once the download finishes
                      — the bar shows activity until then.
                    </p>
                  )}
              </div>
            );
          })()}

          <details className="logs">
            <summary>Receive logs ({recvLogs.length})</summary>
            <pre>{recvLogs.join("\n")}</pre>
          </details>


        </section>
      )}

      {/* v0.1.85 — chat panel. Lives below whichever transfer panel
          is active. Visible only after the chat ALPN has produced an
          event (connecting / connected / unavailable / etc.) so
          windows that haven't started a transfer yet stay clean. */}
      {chatStatus !== "idle" && (
        <section className="panel chat-panel">
          <header className="chat-header">
            <h2>
              {chatPeerLabel
                ? `Chat with ${chatPeerLabel}`
                : "Chat"}
            </h2>
            <div className="chat-status">
              <span
                className={`chat-status-dot chat-status-${chatStatus}`}
                aria-hidden="true"
              />
              <span className="chat-status-label">
                {chatStatus === "connecting" && "Connecting…"}
                {chatStatus === "connected" && "Connected"}
                {chatStatus === "disconnected" && "Disconnected"}
                {chatStatus === "unavailable" && "Unavailable"}
              </span>
              {/* v0.1.88/90/92 — Reconnect Chat appears when the chat
                  has dropped but a sidecar that can host chat is still
                  alive. Bidirectional and Stop-independent: it shows on
                  BOTH the Send and Receive sides, stays available after
                  Stop Send / Stop Receive, AND after a (now reversible)
                  Stop Chat. One click re-dials the peer. */}
              {(chatStatus === "disconnected" ||
                chatStatus === "unavailable") &&
                chatProcessAlive && (
                  <button
                    onClick={reconnectChat}
                    className="ghost-button"
                  >
                    Reconnect Chat
                  </button>
                )}
              <button
                onClick={stopChat}
                disabled={chatStatus !== "connected"}
                className="ghost-button"
              >
                Stop Chat
              </button>
            </div>
          </header>

          <div
            className="chat-scrollback"
            role="log"
            aria-live="polite"
            ref={chatScrollRef}
          >
            {chatMessages.length === 0 ? (
              <p className="chat-empty hint">
                No messages yet — say hi.
              </p>
            ) : (
              chatMessages.map((m, i) => (
                <div key={i} className={`chat-msg chat-msg-${m.kind}`}>
                  {m.kind === "system" ? (
                    <p className="chat-system-line">— {m.body} —</p>
                  ) : (
                    <>
                      <span className="chat-msg-author">
                        {m.kind === "you" ? "You" : chatPeerLabel ?? "Peer"}
                      </span>
                      <span className="chat-msg-body">{m.body}</span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void sendChatMessage();
            }}
          >
            <input
              type="text"
              className="chat-input"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                chatStatus === "connected"
                  ? "type a message…"
                  : "(chat not connected)"
              }
              disabled={chatStatus !== "connected"}
              maxLength={4096}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={chatStatus !== "connected" || !chatInput.trim()}
            >
              Send
            </button>
          </form>
        </section>
      )}
    </main>
  );
}

export default App;
