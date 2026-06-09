import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
type RecvStatus =
  | "idle"
  | "connecting"
  | "downloading"
  | "exporting"
  | "complete"
  | "error";

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
}

interface LastReceive {
  ticketInput: string;
  outputPath: string;
  savedAt: number;
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
        const upsertReceiver = (id: number, patch: Partial<ReceiverRow>) =>
          setReceivers((prev) => {
            const idx = prev.findIndex((r) => r.connectionId === id);
            if (idx === -1) {
              return [
                ...prev,
                {
                  connectionId: id,
                  endpointId: null,
                  label: null,
                  bytes: 0,
                  total: null,
                  speed: null,
                  status: "active",
                  ...patch,
                },
              ];
            }
            const next = [...prev];
            next[idx] = { ...next[idx], ...patch };
            return next;
          });

        switch (parsed.type) {
          case "ticket_hashing_start":
            sendSpeedRef.current = [];
            setSendSpeed(null);
            setSendProgress({ phase: "hashing", bytes: 0, total: null });
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
              upsertReceiver(connId, {
                endpointId,
                label: knownLabel,
                status: "active",
              });
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
              setReceivers((prev) =>
                prev.map((r) =>
                  r.connectionId === connId && r.status !== "complete"
                    ? { ...r, status: "disconnected" }
                    : r
                )
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
              upsertReceiver(connId, {
                bytes: 0,
                total: total ?? null,
                status: "active",
              });
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
          case "error":
            setSendError(`${parsed.stage}: ${parsed.message}`);
            setSendStatus("error");
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
        // If the receive sidecar exited mid-flight, mark it as an error
        // instead of leaving the UI stuck on "connecting"/"downloading".
        setRecvStatus((curr) =>
          curr === "connecting" || curr === "downloading" || curr === "exporting"
            ? "error"
            : curr
        );
        setRecvError((prev) =>
          prev ??
          (e.payload !== 0
            ? `Receive process exited with code ${e.payload}.`
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

  async function startSendWith(targetPath: string, asFolder: boolean) {
    setSendStatus("creating_ticket");
    setIsFolderSend(asFolder);
    setSendFileCount(null);
    setReceivers([]);
    receiverSpeedRef.current.clear();
    labelsByEndpointRef.current.clear();
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
      await invoke("start_send", {
        filePath: targetPath,
        connectionMode,
      });
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
    await startSendWith(lastSend.filePath, lastSend.isFolder ?? false);
  }

  async function stopSend() {
    try {
      await invoke("stop_send");
    } catch (err) {
      console.error(err);
    }
    setSendStatus("idle");
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
    try {
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
    await startReceiveWith(lastRecv.ticketInput, lastRecv.outputPath);
  }

  async function stopReceive() {
    try {
      await invoke("stop_receive");
    } catch (err) {
      console.error(err);
    }
    setRecvStatus("idle");
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
    setChatStatus("disconnected");
  }

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
    recvStatus === "exporting";

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
    <main className="container">
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
          {/* "+ New Transfer Window" lives in each panel's actions row
              (right-justified) from v0.1.83 on. The header slot stays as
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

      {mode === "send" && (
        <section className="panel">
          <h2>Send a file</h2>

          {lastSend && !sendActive && (
            <button
              className="resume-button"
              onClick={resumeLastSend}
              title={lastSend.filePath}
            >
              ↻ Resume last send:{" "}
              <code>{basename(lastSend.filePath)}</code>
            </button>
          )}

          <fieldset className="connection-mode" disabled={sendBusy}>
            <legend>Connection mode</legend>

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
            <button
              className="ghost-button new-window-button"
              onClick={openNewTransferWindow}
            >
              + New Transfer Window
            </button>
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
                rows={3}
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
                      {r.status === "active" && r.total ? (
                        <progress value={r.bytes} max={r.total} />
                      ) : r.status === "active" ? (
                        <progress />
                      ) : null}
                      {r.status === "active" && (
                        <div className="receiver-meta">
                          <span>
                            {formatBytes(r.bytes)}
                            {r.total !== null && (
                              <> / {formatBytes(r.total)}</>
                            )}
                          </span>
                          {r.speed !== null && (
                            <>
                              <span className="progress-sep">·</span>
                              <span>{formatSpeed(r.speed)}</span>
                            </>
                          )}
                          {eta !== null && (
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

          {lastRecv && !recvBusy && (
            <button
              className="resume-button"
              onClick={resumeLastReceive}
              title={`${lastRecv.outputPath}`}
            >
              ↻ Resume last receive:{" "}
              <code>{basename(lastRecv.outputPath)}</code>
            </button>
          )}

          <label className="field">
            <span>Ticket</span>
            <textarea
              value={ticketInput}
              onChange={(e) => setTicketInput(e.target.value)}
              placeholder="Paste the share ticket here — surrounding text is okay, we'll extract it."
              disabled={recvBusy}
              rows={3}
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
            <button onClick={pickDestination} disabled={recvBusy}>
              {isFolderReceive ? "Pick Destination Folder…" : "Pick Destination…"}
            </button>
            <button
              onClick={startReceive}
              disabled={!parsedTicket || !outputPath || recvBusy}
            >
              Start Receive
            </button>
            <button onClick={stopReceive} disabled={!recvBusy}>
              Stop
            </button>
            <button
              className="ghost-button new-window-button"
              onClick={openNewTransferWindow}
            >
              + New Transfer Window
            </button>
          </div>

          {outputPath && <p className="filepath">{outputPath}</p>}

          {recvStatus !== "complete" && (
            <p className="status">
              Status: <code>{recvStatus}</code>
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
                  <span className="progress-phase">{phaseLabel}</span>
                  {recvPercent !== null && (
                    <span className="progress-pct">
                      {recvPercent.toFixed(1)}%
                    </span>
                  )}
                </div>
                {recvProgress.total ? (
                  <progress
                    value={recvProgress.bytes}
                    max={recvProgress.total}
                  />
                ) : (
                  // Indeterminate: total unknown until export_size arrives.
                  <progress />
                )}
                <div className="progress-footer">
                  <span className="progress-bytes">
                    {formatBytes(recvProgress.bytes)}
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
              <button
                onClick={stopChat}
                disabled={chatStatus !== "connected"}
                className="ghost-button"
              >
                Stop Chat
              </button>
            </div>
          </header>

          <div className="chat-scrollback" role="log" aria-live="polite">
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
