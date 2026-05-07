import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { downloadDir } from "@tauri-apps/api/path";
import "./App.css";

type Mode = "send" | "receive";
type SendStatus = "idle" | "sending" | "ticket_ready" | "complete" | "error";
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

interface ParsedReceiveInput {
  ticket: string;
  suggestedName: string | null;
}

// Extract a blob ticket — and, if present, a suggested filename — from
// arbitrary input. The ticket itself is just a hash + node ID + relay info;
// the filename does NOT travel inside it. We rely on the CLI's existing
// "orbitxfer-iroh-cli receive <ticket> <path>" share format to carry the
// filename alongside the ticket. Anything after the ticket that looks
// path-like (has a separator) or filename-like (has an extension) becomes
// the suggested name.
function parseReceiveInput(input: string): ParsedReceiveInput | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/blob[a-z0-9]{60,}/i);
  if (!match) return null;
  const ticket = match[0];

  const after = trimmed
    .slice(match.index! + ticket.length)
    .trim()
    .replace(/^['"]|['"]$/g, "");

  let suggestedName: string | null = null;
  if (after) {
    const last = basename(after);
    const hasSeparator = /[/\\]/.test(after);
    const hasExtension = /\.[\w]{1,10}$/.test(last);
    if ((hasSeparator || hasExtension) && last && last.length <= 255) {
      suggestedName = last;
    }
  }

  return { ticket, suggestedName };
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

async function openNewTransferWindow() {
  // Each window needs a unique label so per-window state in Rust stays
  // isolated. Capabilities use the "window-*" pattern, so labels must
  // start with "window-".
  const label = `window-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const win = new WebviewWindow(label, {
    url: "index.html",
    title: "OrbitXfer",
    width: 900,
    height: 700,
  });
  // Surface creation errors so they don't disappear silently.
  win.once("tauri://error", (e) => {
    console.error("New window failed to open:", e);
  });
}

function App() {
  // Per-window mode. Each window picks Send or Receive; the other panel is
  // hidden so a single window stays focused on one task. Open another window
  // for the other direction.
  const [mode, setMode] = useState<Mode>("send");

  // Tracks whether the user has explicitly picked a destination via the save
  // dialog. We auto-fill the destination from the parsed ticket's filename,
  // but only if the user hasn't already chosen one — we don't want to clobber
  // a manual selection just because they edited the ticket textarea.
  const userPickedDest = useRef(false);

  // Send state
  const [filePath, setFilePath] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [tickets, setTickets] = useState<Tickets | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendLogs, setSendLogs] = useState<string[]>([]);

  // Receive state
  const [ticketInput, setTicketInput] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [recvStatus, setRecvStatus] = useState<RecvStatus>("idle");
  const [recvProgress, setRecvProgress] = useState<RecvProgress | null>(null);
  const [recvError, setRecvError] = useState<string | null>(null);
  const [recvLogs, setRecvLogs] = useState<string[]>([]);

  const win = useMemo(() => getCurrentWindow(), []);

  // Update the OS window title when mode changes so the user can tell
  // multiple windows apart in Mission Control / app switcher.
  useEffect(() => {
    win.setTitle(`OrbitXfer — ${mode === "send" ? "Send" : "Receive"}`).catch(
      (err) => console.error("setTitle failed:", err)
    );
  }, [mode, win]);

  // When a ticket with a filename is pasted and the user hasn't already
  // picked a destination, auto-fill ~/Downloads/<filename>. This means the
  // received file keeps its original name and extension without the user
  // having to click Pick destination at all. They can still override.
  useEffect(() => {
    if (userPickedDest.current) return;
    const parsed = parseReceiveInput(ticketInput);
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

        if (parsed.type === "ticket_variants") {
          setTickets({
            direct: parsed.direct ?? null,
            relay: parsed.relay ?? null,
            full: parsed.full,
          });
          setSendStatus("ticket_ready");
        } else if (parsed.type === "upload_complete") {
          setSendStatus("complete");
        } else if (parsed.type === "error") {
          setSendError(`${parsed.stage}: ${parsed.message}`);
          setSendStatus("error");
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
        // error so the UI doesn't sit stuck on "sending".
        setSendStatus((curr) =>
          curr === "sending" ? "error" : curr
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
      setFilePath(result);
      setTickets(null);
      setSendError(null);
      setSendStatus("idle");
    }
  }

  async function startSend() {
    if (!filePath) return;
    setSendStatus("sending");
    setTickets(null);
    setSendError(null);
    setSendLogs([]);
    try {
      await invoke("start_send", { filePath });
    } catch (err) {
      setSendError(String(err));
      setSendStatus("error");
    }
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

  async function startReceive() {
    const parsed = parseReceiveInput(ticketInput);
    const ticket = parsed?.ticket ?? null;
    if (!ticket) {
      setRecvError(
        "No valid ticket found in the input. Tickets start with 'blob' and are around 250 characters of letters and digits. Paste the ticket (or the full 'orbitxfer-iroh-cli receive …' line) and try again."
      );
      setRecvStatus("error");
      return;
    }
    if (!outputPath) {
      setRecvError(
        "Pick a destination file first — click 'Pick destination…' and choose where to save the incoming file."
      );
      setRecvStatus("error");
      return;
    }
    setRecvStatus("connecting");
    setRecvProgress(null);
    setRecvError(null);
    setRecvLogs([]);
    try {
      await invoke("start_receive", { ticket, outputPath });
    } catch (err) {
      setRecvError(String(err));
      setRecvStatus("error");
    }
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

  const recvPercent =
    recvProgress && recvProgress.total && recvProgress.total > 0
      ? Math.min(100, (recvProgress.bytes / recvProgress.total) * 100)
      : null;

  const recvBusy =
    recvStatus === "connecting" ||
    recvStatus === "downloading" ||
    recvStatus === "exporting";

  const sendBusy = sendStatus === "sending";

  return (
    <main className="container">
      <header className="app-header">
        <div>
          <h1>OrbitXfer</h1>
          <p className="subtitle">Tauri migration — Phase 3b</p>
        </div>
        <button className="ghost-button" onClick={openNewTransferWindow}>
          + New Window
        </button>
      </header>

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
          <div className="actions">
            <button onClick={pickFile} disabled={sendBusy}>
              Pick file…
            </button>
            <button
              onClick={startSend}
              disabled={!filePath || sendBusy}
            >
              Start Send
            </button>
            <button
              onClick={stopSend}
              disabled={
                sendStatus !== "sending" && sendStatus !== "ticket_ready"
              }
            >
              Stop
            </button>
          </div>

          {filePath && <p className="filepath">{filePath}</p>}

          <p className="status">
            Status: <code>{sendStatus}</code>
          </p>

          {sendError && <p className="error">{sendError}</p>}

          {tickets && (
            <div className="ticket-box">
              <h3>Share this with the recipient</h3>
              <p className="hint">
                The line below carries the ticket and the filename, so the
                receiving side can suggest a save name. If the recipient pastes
                it into OrbitXfer's Receive panel, the filename comes through.
              </p>
              <textarea
                readOnly
                value={
                  filePath
                    ? `orbitxfer-iroh-cli receive ${tickets.full} ${basename(filePath)}`
                    : tickets.full
                }
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                rows={3}
              />
              <details>
                <summary>just the bare ticket (no filename)</summary>
                <textarea readOnly value={tickets.full} rows={3} />
              </details>
              {tickets.direct && (
                <details>
                  <summary>direct ticket</summary>
                  <textarea readOnly value={tickets.direct} />
                </details>
              )}
              {tickets.relay && (
                <details>
                  <summary>relay ticket</summary>
                  <textarea readOnly value={tickets.relay} />
                </details>
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
                          suggested filename: {suggestedName}
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
              Pick destination…
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

          {recvProgress && (
            <div className="progress-box">
              {recvProgress.total ? (
                <progress
                  value={recvProgress.bytes}
                  max={recvProgress.total}
                />
              ) : (
                // Indeterminate: total unknown until export_size arrives.
                <progress />
              )}
              <p className="progress-label">
                <span className="progress-phase">
                  {recvProgress.phase === "export"
                    ? "Writing to disk: "
                    : "Downloading: "}
                </span>
                {formatBytes(recvProgress.bytes)}
                {recvProgress.total !== null && (
                  <> / {formatBytes(recvProgress.total)}</>
                )}
                {recvPercent !== null && (
                  <span className="progress-pct">
                    {" "}
                    ({recvPercent.toFixed(1)}%)
                  </span>
                )}
              </p>
            </div>
          )}

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
