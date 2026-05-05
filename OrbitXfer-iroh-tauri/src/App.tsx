import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type SendStatus = "idle" | "sending" | "ticket_ready" | "complete" | "error";

interface Tickets {
  direct: string | null;
  relay: string | null;
  full: string;
}

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [status, setStatus] = useState<SendStatus>("idle");
  const [tickets, setTickets] = useState<Tickets | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    const eventPrefix = "OX_EVENT ";

    unlisteners.push(
      listen<string>("send:stdout", (e) => {
        const line = e.payload;
        setLogs((prev) => [...prev, line]);

        const idx = line.indexOf(eventPrefix);
        if (idx === -1) return;
        try {
          const parsed = JSON.parse(line.substring(idx + eventPrefix.length));
          if (parsed.type === "ticket_variants") {
            setTickets({
              direct: parsed.direct ?? null,
              relay: parsed.relay ?? null,
              full: parsed.full,
            });
            setStatus("ticket_ready");
          } else if (parsed.type === "upload_complete") {
            setStatus("complete");
          } else if (parsed.type === "error") {
            setErrorMsg(`${parsed.stage}: ${parsed.message}`);
            setStatus("error");
          }
        } catch {
          /* not JSON, ignore */
        }
      })
    );

    unlisteners.push(
      listen<string>("send:stderr", (e) => {
        setLogs((prev) => [...prev, "[stderr] " + e.payload]);
      })
    );

    unlisteners.push(
      listen<number | null>("send:exit", (e) => {
        setLogs((prev) => [...prev, `[exit] code=${e.payload}`]);
      })
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  async function pickFile() {
    const result = await open({ multiple: false, directory: false });
    if (typeof result === "string") {
      setFilePath(result);
      setTickets(null);
      setErrorMsg(null);
      setStatus("idle");
    }
  }

  async function startSend() {
    if (!filePath) return;
    setStatus("sending");
    setTickets(null);
    setErrorMsg(null);
    setLogs([]);
    try {
      await invoke("start_send", { filePath });
    } catch (err) {
      setErrorMsg(String(err));
      setStatus("error");
    }
  }

  async function stopSend() {
    try {
      await invoke("stop_send");
    } catch (err) {
      console.error(err);
    }
    setStatus("idle");
  }

  return (
    <main className="container">
      <header>
        <h1>OrbitXfer</h1>
        <p className="subtitle">Tauri migration — Phase 1</p>
      </header>

      <section className="panel">
        <h2>Send a file</h2>
        <div className="actions">
          <button onClick={pickFile} disabled={status === "sending"}>
            Pick file…
          </button>
          <button
            onClick={startSend}
            disabled={!filePath || status === "sending"}
          >
            Start Send
          </button>
          <button
            onClick={stopSend}
            disabled={status !== "sending" && status !== "ticket_ready"}
          >
            Stop
          </button>
        </div>

        {filePath && <p className="filepath">{filePath}</p>}

        <p className="status">
          Status: <code>{status}</code>
        </p>

        {errorMsg && <p className="error">{errorMsg}</p>}

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
      </section>

      <details className="logs">
        <summary>Logs ({logs.length})</summary>
        <pre>{logs.join("\n")}</pre>
      </details>
    </main>
  );
}

export default App;
