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
type SendStatus =
  | "idle"
  | "creating_ticket"
  | "ticket_ready"
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
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec < 1) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
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

  // Receive state
  const [ticketInput, setTicketInput] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [recvStatus, setRecvStatus] = useState<RecvStatus>("idle");
  const [recvProgress, setRecvProgress] = useState<RecvProgress | null>(null);
  const [recvError, setRecvError] = useState<string | null>(null);
  const [recvLogs, setRecvLogs] = useState<string[]>([]);
  const [recvSpeed, setRecvSpeed] = useState<number | null>(null);
  const recvSpeedRef = useRef<SpeedSample[]>([]);

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

        // Folder sends carry a file count on their hashing events.
        if (typeof parsed.files === "number") setSendFileCount(parsed.files);

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
          case "ticket_variants":
            setTickets({
              direct: parsed.direct ?? null,
              relay: parsed.relay ?? null,
              full: parsed.full,
            });
            // Confirm the canonical total. `ticket_hashing_size` already
            // set it once; we refresh here in case the source of truth
            // (e.g. a slightly different store-reported size) shifted.
            if (total !== null) setSendTotalSize(total);
            setSendStatus("ticket_ready");
            // Clear hashing progress — it's done and the ticket is the
            // main signal now.
            setSendProgress(null);
            break;
          case "upload_started":
            sendSpeedRef.current = [];
            setSendSpeed(null);
            setSendProgress({
              phase: "uploading",
              bytes: 0,
              total: total ?? null,
            });
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
            break;
          case "upload_complete":
            setSendStatus("complete");
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
            break;
          case "error":
            setSendError(`${parsed.stage}: ${parsed.message}`);
            setSendStatus("error");
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

        switch (parsed.type) {
          case "connect_start":
          case "connect_check_start":
            setRecvStatus((s) => (s === "idle" ? "connecting" : s));
            // Reset speed tracking when a new transfer cycle starts.
            recvSpeedRef.current = [];
            setRecvSpeed(null);
            break;
          case "download_size":
            setRecvProgress({ bytes: 0, total, phase: "download" });
            break;
          case "download_started":
            setRecvStatus("downloading");
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
      setFilePath(result);
      await startSendWith(result, false);
    }
  }

  async function pickFolder() {
    const result = await open({ multiple: false, directory: true });
    if (typeof result === "string") {
      // One-step folder send: the whole folder becomes a HashSeq collection.
      setFilePath(result);
      await startSendWith(result, true);
    }
  }

  async function startSendWith(targetPath: string, asFolder: boolean) {
    setSendStatus("creating_ticket");
    setIsFolderSend(asFolder);
    setSendFileCount(null);
    setTickets(null);
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
      // the resumed share line gets the right folder hint.
      const entry: LastSend = {
        filePath: targetPath,
        savedAt: Date.now(),
        isFolder: asFolder,
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

  const sendBusy = sendStatus === "creating_ticket";

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
          <button className="ghost-button" onClick={openNewTransferWindow}>
            + New Window
          </button>
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
          disabled={sendBusy || recvBusy}
        >
          Send
        </button>
        <button
          role="tab"
          aria-selected={mode === "receive"}
          className={mode === "receive" ? "active" : ""}
          onClick={() => setMode("receive")}
          disabled={sendBusy || recvBusy}
        >
          Receive
        </button>
      </div>

      {mode === "send" && (
        <section className="panel">
          <h2>Send a file</h2>
          {lastSend && !sendBusy && (
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
            <button onClick={pickFile} disabled={sendBusy}>
              Pick file…
            </button>
            <button onClick={pickFolder} disabled={sendBusy}>
              Pick folder…
            </button>
            <button
              onClick={stopSend}
              disabled={
                sendStatus !== "creating_ticket" &&
                sendStatus !== "ticket_ready"
              }
            >
              Stop
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

          <p className="status">
            Status: <code>{sendStatus}</code>
          </p>

          {sendError && <p className="error">{sendError}</p>}

          {sendProgress && (() => {
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
              {ticketFellBack && (
                <p className="hint">
                  {connectionMode === "direct_only"
                    ? "No direct address is available on this network — sharing the full ticket (direct + relay) instead."
                    : "No relay address is available — sharing the full ticket (direct + relay) instead."}
                </p>
              )}
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

          <div className="actions">
            <button onClick={pickDestination} disabled={recvBusy}>
              {isFolderReceive ? "Pick destination folder…" : "Pick destination…"}
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
          </div>

          {outputPath && <p className="filepath">{outputPath}</p>}

          <p className="status">
            Status: <code>{recvStatus}</code>
          </p>

          {recvError && <p className="error">{recvError}</p>}

          {recvProgress && (() => {
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
    </main>
  );
}

export default App;
