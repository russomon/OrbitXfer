import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";

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

function App() {
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

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      listen<string>("send:stdout", (e) => {
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
      listen<string>("send:stderr", (e) => {
        setSendLogs((prev) => [...prev, "[stderr] " + e.payload]);
      })
    );

    unlisteners.push(
      listen<number | null>("send:exit", (e) => {
        setSendLogs((prev) => [...prev, `[exit] code=${e.payload}`]);
      })
    );

    unlisteners.push(
      listen<string>("recv:stdout", (e) => {
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
      listen<string>("recv:stderr", (e) => {
        setRecvLogs((prev) => [...prev, "[stderr] " + e.payload]);
      })
    );

    unlisteners.push(
      listen<number | null>("recv:exit", (e) => {
        setRecvLogs((prev) => [...prev, `[exit] code=${e.payload}`]);
      })
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

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

  async function pickDestination() {
    const result = await save({
      title: "Save received file as…",
      defaultPath: undefined,
    });
    if (typeof result === "string") {
      setOutputPath(result);
      setRecvError(null);
      setRecvProgress(null);
      setRecvStatus("idle");
    }
  }

  async function startReceive() {
    const ticket = ticketInput.trim();
    if (!ticket || !outputPath) return;
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

  const recvPercent =
    recvProgress && recvProgress.total && recvProgress.total > 0
      ? Math.min(100, (recvProgress.bytes / recvProgress.total) * 100)
      : null;

  const recvBusy =
    recvStatus === "connecting" ||
    recvStatus === "downloading" ||
    recvStatus === "exporting";

  return (
    <main className="container">
      <header>
        <h1>OrbitXfer</h1>
        <p className="subtitle">Tauri migration — Phase 2</p>
      </header>

      <section className="panel">
        <h2>Send a file</h2>
        <div className="actions">
          <button onClick={pickFile} disabled={sendStatus === "sending"}>
            Pick file…
          </button>
          <button
            onClick={startSend}
            disabled={!filePath || sendStatus === "sending"}
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
            <h3>Share this ticket</h3>
            <textarea
              readOnly
              value={tickets.full}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
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

      <section className="panel">
        <h2>Receive a file</h2>

        <label className="field">
          <span>Ticket</span>
          <textarea
            value={ticketInput}
            onChange={(e) => setTicketInput(e.target.value)}
            placeholder="Paste the share ticket here…"
            disabled={recvBusy}
            rows={3}
          />
        </label>

        <div className="actions">
          <button onClick={pickDestination} disabled={recvBusy}>
            Pick destination…
          </button>
          <button
            onClick={startReceive}
            disabled={!ticketInput.trim() || !outputPath || recvBusy}
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
    </main>
  );
}

export default App;
