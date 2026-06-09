//! Chat protocol (`orbitxfer/chat/1`) — v0.1.85.
//!
//! Implements a small 1:1 chat protocol that runs as a SECOND ALPN
//! on the same iroh endpoints that already carry the `iroh_blobs`
//! transfer (sender side) and dial it (receiver side). The two ALPNs
//! have independent lifetimes: the chat outlives the transfer when
//! the transfer ends first (which is the common case — the receiver
//! finishes downloading but stays connected for conversation).
//!
//! Design highlights:
//!   - **No PAKE.** Authentication is implicit: only someone with the
//!     ticket can derive the sender's NodeID and dial it. iroh's QUIC
//!     TLS layer encrypts the channel.
//!   - **Length-prefixed JSON frames.** 4-byte big-endian length +
//!     body. Max 4 KiB body (bounds memory; chat is text).
//!   - **First-receiver-wins on the sender side.** The first chat
//!     dialer claims the slot; subsequent dialers are dropped with no
//!     session opened. The sender's UI only ever shows one
//!     conversation per session for v0.1.85.
//!   - **Bidirectional message exchange.** After both sides exchange
//!     `Hello`, either may send `Text` at any time. Either side may
//!     send `Bye` to close gracefully.

use anyhow::{anyhow, bail, Result};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{timeout, Duration};

/// The chat ALPN. Sender's Router accepts it alongside iroh_blobs::ALPN
/// and orbitxfer/label/0; receiver dials it separately from the blob
/// connection.
pub const CHAT_ALPN: &[u8] = b"orbitxfer/chat/1";

const PROTO_VERSION: u8 = 1;

/// Maximum frame size (length-prefixed body + slack for serde
/// envelope). The body itself is capped at 4 KiB; the envelope adds
/// the JSON keys and small numeric overhead.
const MAX_FRAME_BYTES: usize = 8192;

/// Maximum body bytes accepted from a peer. Inbound text is
/// truncated to this length to bound memory; outbound text is
/// rejected if it exceeds this length.
const MAX_BODY_BYTES: usize = 4096;

/// Timeout for the initial Hello exchange. If the peer hasn't sent
/// their Hello within this many seconds after the connection opens,
/// we assume the session is broken and close.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Wire-format chat messages.
///
/// We use serde's `tag = "type"` representation so JSON looks like
/// `{"type":"Text","body":"hi","sent_at_unix_ms":12345}` — human-
/// readable in logs and easy for the React side to consume.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ChatMessage {
    /// First frame each side sends after the bidirectional stream
    /// opens. Carries the wire-protocol version and an optional
    /// display label.
    Hello {
        proto_version: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// A user-typed text message. `sent_at_unix_ms` is set by the
    /// sender's local clock at compose time — UI uses it for the
    /// per-message timestamp.
    Text { body: String, sent_at_unix_ms: u64 },
    /// Graceful shutdown signal. The recipient should not send more
    /// messages after seeing this.
    Bye,
}

/// Sender-side protocol handler. Holds the outbox `Sender<ChatMessage>`
/// once a chat session establishes, allowing the outer subcommand
/// (run_send) to push outbound messages without re-entering the
/// chat-session task.
#[derive(Clone)]
pub struct ChatProtocol {
    inner: Arc<ChatProtocolInner>,
}

impl std::fmt::Debug for ChatProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatProtocol")
            .field("self_label", &self.inner.self_label)
            .finish()
    }
}

struct ChatProtocolInner {
    /// `Some(tx)` while a chat session is live; `None` before any
    /// connection arrives, or after one closes (first-receiver-wins
    /// means the slot doesn't refill — subsequent dialers get
    /// rejected).
    outbox: Mutex<Option<mpsc::Sender<ChatMessage>>>,
    /// Label to send in our Hello frame so the peer can render us
    /// with a friendly name.
    self_label: String,
    /// Sticky "this slot has ever been used" flag. First-receiver-
    /// wins means we DON'T accept new chats after the first one
    /// closes — even if outbox is None again, we reject.
    used: Mutex<bool>,
}

impl ChatProtocol {
    pub fn new(self_label: String) -> Self {
        Self {
            inner: Arc::new(ChatProtocolInner {
                outbox: Mutex::new(None),
                self_label,
                used: Mutex::new(false),
            }),
        }
    }

    /// True if there's a live chat session right now.
    pub async fn is_active(&self) -> bool {
        self.inner.outbox.lock().await.is_some()
    }

    /// True if a chat has ever been opened in this session (even if
    /// it has since closed). Used by the receiver-side wait-for-exit
    /// logic to distinguish "no chat ever happened" from "chat was
    /// here but closed".
    pub async fn has_been_used(&self) -> bool {
        *self.inner.used.lock().await
    }

    /// Queue an outbound text message. The frame is constructed
    /// here (with the current unix timestamp) and pushed to the
    /// active chat session's outbox. Returns an error if no chat
    /// is currently active.
    pub async fn send_text(&self, body: String) -> Result<()> {
        if body.len() > MAX_BODY_BYTES {
            bail!("text body too large: {} bytes (max {})", body.len(), MAX_BODY_BYTES);
        }
        let outbox = self.inner.outbox.lock().await;
        let Some(sender) = outbox.as_ref() else {
            bail!("no active chat session");
        };
        let msg = ChatMessage::Text {
            body,
            sent_at_unix_ms: now_unix_ms(),
        };
        sender
            .send(msg)
            .await
            .map_err(|e| anyhow!("chat outbox closed: {e}"))?;
        Ok(())
    }

    /// Send `Bye` and close the outbound side of the chat. The
    /// session task will then drain inbound until the peer also
    /// closes (or times out).
    pub async fn close(&self) -> Result<()> {
        let mut outbox = self.inner.outbox.lock().await;
        let Some(sender) = outbox.take() else {
            return Ok(());
        };
        let _ = sender.send(ChatMessage::Bye).await;
        // Dropping the sender (out of scope here) signals "no more
        // outbound messages" to the writer half of the chat session.
        Ok(())
    }
}

impl ProtocolHandler for ChatProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let remote_id = connection.remote_id().to_string();

        // First-receiver-wins gate. If this slot has ever been used
        // (whether or not the session is currently live), drop the
        // new dialer. v0.1.85 spec: subsequent receivers can still
        // download the file but don't get a chat panel.
        {
            let mut used = self.inner.used.lock().await;
            if *used {
                crate::emit_event(json!({
                    "type": "chat_attempt_rejected",
                    "reason": "first_receiver_wins",
                    "endpoint_id": remote_id,
                }));
                connection.close(0u32.into(), b"chat busy");
                return Ok(());
            }
            *used = true;
        }

        // Claim the outbox slot.
        let (outbox_tx, outbox_rx) = mpsc::channel::<ChatMessage>(64);
        {
            let mut outbox = self.inner.outbox.lock().await;
            *outbox = Some(outbox_tx);
        }

        let self_label = self.inner.self_label.clone();
        let proto_clone = self.clone();

        // Spawn the chat session as a task so this accept() can
        // return; the iroh router keeps the connection alive via
        // the task.
        tokio::spawn(async move {
            if let Err(e) =
                run_chat_session(connection, ChatSide::Sender, self_label, outbox_rx).await
            {
                crate::emit_event(json!({
                    "type": "chat_session_error",
                    "error": format!("{}", e),
                }));
            }
            // Session ended; clear the outbox so send_text() fails
            // cleanly if anyone still tries to use it.
            let mut outbox = proto_clone.inner.outbox.lock().await;
            *outbox = None;
        });

        Ok(())
    }
}

/// Which end of the connection we are. Determines whether we
/// `accept_bi` (server) or `open_bi` (client) the chat stream.
#[derive(Debug, Clone, Copy)]
pub enum ChatSide {
    /// We accepted the iroh connection; the peer dialed us.
    Sender,
    /// We dialed the iroh connection; we're the originator.
    Receiver,
}

impl ChatSide {
    fn default_peer_label(self) -> &'static str {
        match self {
            ChatSide::Sender => "Receiver",
            ChatSide::Receiver => "Sender",
        }
    }
}

/// Run a chat session over an established iroh connection. Performs
/// the Hello handshake, then runs reader+writer concurrently until
/// either side closes.
///
/// Emits the following OX_EVENT types:
///   - `chat_connected` (with peer's label) — after Hello exchange
///   - `chat_message_received` (body + sent_at_unix_ms) — per Text
///   - `chat_send_failed` (error) — on write failure
///   - `chat_disconnected` — on graceful close (Bye received) or
///     stream end
pub async fn run_chat_session(
    connection: Connection,
    side: ChatSide,
    self_label: String,
    mut outbox_rx: mpsc::Receiver<ChatMessage>,
) -> Result<()> {
    let remote_id = connection.remote_id().to_string();

    // Open or accept the bidirectional stream depending on which
    // side of the connection we are.
    let (mut send, mut recv) = match side {
        ChatSide::Sender => connection
            .accept_bi()
            .await
            .map_err(|e| anyhow!("chat accept_bi: {:?}", e))?,
        ChatSide::Receiver => connection
            .open_bi()
            .await
            .map_err(|e| anyhow!("chat open_bi: {:?}", e))?,
    };

    // Send our Hello.
    let hello = ChatMessage::Hello {
        proto_version: PROTO_VERSION,
        label: Some(self_label.clone()),
    };
    send_frame(&mut send, &hello).await?;

    // Await peer's Hello with a timeout. If we don't see it in
    // HELLO_TIMEOUT seconds, abandon the session.
    let peer_hello = match timeout(HELLO_TIMEOUT, recv_frame(&mut recv)).await {
        Ok(Ok(msg)) => msg,
        Ok(Err(e)) => bail!("hello recv error: {}", e),
        Err(_) => bail!("hello timeout"),
    };

    let peer_label = match peer_hello {
        ChatMessage::Hello {
            proto_version,
            label,
        } => {
            if proto_version != PROTO_VERSION {
                bail!("peer proto_version mismatch: {}", proto_version);
            }
            label.unwrap_or_else(|| side.default_peer_label().to_string())
        }
        other => bail!("expected Hello, got {:?}", other),
    };

    crate::emit_event(json!({
        "type": "chat_connected",
        "label": peer_label,
        "endpoint_id": remote_id.clone(),
    }));

    // v0.1.85 — single-loop reader+writer using tokio::select!. The
    // earlier two-task design deadlocked on graceful close: if one
    // side sent Bye, the other side's reader exited but its writer
    // kept waiting for outbox input forever. Co-locating both
    // directions lets us close the loop the moment Bye flows in
    // either direction.
    let mut we_sent_bye = false;
    loop {
        tokio::select! {
            // Outbound: pull from the GUI-driven outbox.
            outbound = outbox_rx.recv() => {
                match outbound {
                    Some(msg) => {
                        let is_bye = matches!(msg, ChatMessage::Bye);
                        if let Err(e) = send_frame(&mut send, &msg).await {
                            crate::emit_event(json!({
                                "type": "chat_send_failed",
                                "error": format!("{}", e),
                            }));
                            break;
                        }
                        if is_bye {
                            we_sent_bye = true;
                            break;
                        }
                    }
                    None => {
                        // Outbox closed externally (e.g. ChatProtocol::close
                        // taking the sender). Treat as an implicit Bye if
                        // we haven't already sent one.
                        if !we_sent_bye {
                            let _ = send_frame(&mut send, &ChatMessage::Bye).await;
                        }
                        break;
                    }
                }
            }
            // Inbound: read one frame from the peer.
            inbound = recv_frame(&mut recv) => {
                match inbound {
                    Ok(ChatMessage::Text { body, sent_at_unix_ms }) => {
                        let body = sanitize_text(&body);
                        crate::emit_event(json!({
                            "type": "chat_message_received",
                            "body": body,
                            "sent_at_unix_ms": sent_at_unix_ms,
                        }));
                    }
                    Ok(ChatMessage::Hello { .. }) => {
                        eprintln!("[chat] unexpected Hello after handshake");
                    }
                    Ok(ChatMessage::Bye) => {
                        // Peer initiated close. Echo a Bye so the
                        // peer's loop also breaks cleanly, then exit.
                        if !we_sent_bye {
                            let _ = send_frame(&mut send, &ChatMessage::Bye).await;
                        }
                        break;
                    }
                    Err(e) => {
                        let msg = format!("{}", e);
                        // EOF on the stream is a normal close, not an error.
                        if !msg.contains("UnexpectedEof")
                            && !msg.contains("ConnectionLost")
                        {
                            crate::emit_event(json!({
                                "type": "chat_read_error",
                                "error": msg,
                            }));
                        }
                        break;
                    }
                }
            }
        }
    }

    // Close our write side so the peer's stream read returns EOF.
    let _ = send.finish();

    crate::emit_event(json!({
        "type": "chat_disconnected",
        "endpoint_id": remote_id,
    }));

    Ok(())
}

// ----------------------------------------------------------------
// Wire codec — 4-byte big-endian length prefix + JSON body.
// ----------------------------------------------------------------

async fn send_frame(send: &mut SendStream, msg: &ChatMessage) -> Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    if bytes.len() > MAX_FRAME_BYTES {
        bail!("frame too large: {} bytes (max {})", bytes.len(), MAX_FRAME_BYTES);
    }
    let len = (bytes.len() as u32).to_be_bytes();
    send.write_all(&len).await?;
    send.write_all(&bytes).await?;
    Ok(())
}

async fn recv_frame(recv: &mut RecvStream) -> Result<ChatMessage> {
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(|e| anyhow!("read len: {:?}", e))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        bail!("frame length {} too large (max {})", len, MAX_FRAME_BYTES);
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf)
        .await
        .map_err(|e| anyhow!("read body: {:?}", e))?;
    let msg: ChatMessage = serde_json::from_slice(&buf)?;
    Ok(msg)
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/// Drop control characters (except `\n`) and truncate to
/// `MAX_BODY_BYTES`. We don't bundle a Unicode-normalization crate
/// for v0.1.85 — NFC normalization is a polish item for later.
fn sanitize_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len().min(MAX_BODY_BYTES));
    for c in s.chars() {
        if c != '\n' && c.is_control() {
            continue;
        }
        if out.len() + c.len_utf8() > MAX_BODY_BYTES {
            break;
        }
        out.push(c);
    }
    out
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ----------------------------------------------------------------
// Stdin command parsing — shared by run_send and run_receive
// ----------------------------------------------------------------

/// Commands the GUI sends to a running sidecar over its stdin,
/// one per line, each prefixed with `OX_CMD ` and serialized as
/// JSON. Non-OX_CMD lines (and the EOF case) keep their existing
/// behavior in `main::watch_parent_via_stdin`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum CliCommand {
    /// Push a text message to the active chat outbox.
    #[serde(rename = "chat_send")]
    ChatSend { body: String },
    /// Close the active chat with a Bye frame.
    #[serde(rename = "chat_stop")]
    ChatStop,
    /// Begin graceful shutdown of the send sidecar. Currently
    /// equivalent to ctrl-c: the sidecar exits, ending blob serving
    /// and any active chat together. (v0.1.86 may add a path that
    /// closes only the blob ALPN, leaving the chat alive.)
    #[serde(rename = "stop_send")]
    StopSend,
    /// Begin graceful shutdown of the receive sidecar. Currently
    /// equivalent to ctrl-c.
    #[serde(rename = "stop_receive")]
    StopReceive,
}

/// Spawn the stdin watcher as a tokio task. Reads stdin line by
/// line, parses `OX_CMD ` lines into `CliCommand`s, and forwards
/// them through the provided sender. On EOF (parent died / terminal
/// closed) the task calls `std::process::exit(0)` — preserves the
/// v0.1.83+ parent-death behavior unchanged.
pub fn spawn_stdin_command_reader(cmd_tx: mpsc::UnboundedSender<CliCommand>) {
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut reader = BufReader::new(tokio::io::stdin());
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    eprintln!(
                        "[orbitxfer-iroh-cli] stdin closed (parent or terminal gone); exiting."
                    );
                    std::process::exit(0);
                }
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if let Some(rest) = trimmed.strip_prefix("OX_CMD ") {
                        match serde_json::from_str::<CliCommand>(rest) {
                            Ok(cmd) => {
                                if cmd_tx.send(cmd).is_err() {
                                    // Receiver dropped — nothing more to do
                                    return;
                                }
                            }
                            Err(e) => {
                                eprintln!("[orbitxfer-iroh-cli] bad OX_CMD JSON: {}", e);
                            }
                        }
                    }
                    // Non-OX_CMD lines are silently ignored (preserves
                    // backward compat with any pipe that wasn't aware
                    // of the new protocol).
                }
                Err(_) => {
                    eprintln!("[orbitxfer-iroh-cli] stdin read failed; exiting.");
                    std::process::exit(0);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_message_roundtrips_hello() {
        let msg = ChatMessage::Hello {
            proto_version: 1,
            label: Some("Alice".to_string()),
        };
        let bytes = serde_json::to_vec(&msg).unwrap();
        let decoded: ChatMessage = serde_json::from_slice(&bytes).unwrap();
        matches!(decoded, ChatMessage::Hello { proto_version: 1, .. });
    }

    #[test]
    fn chat_message_roundtrips_text() {
        let msg = ChatMessage::Text {
            body: "hello world".to_string(),
            sent_at_unix_ms: 1700000000000,
        };
        let bytes = serde_json::to_vec(&msg).unwrap();
        let decoded: ChatMessage = serde_json::from_slice(&bytes).unwrap();
        match decoded {
            ChatMessage::Text { body, sent_at_unix_ms } => {
                assert_eq!(body, "hello world");
                assert_eq!(sent_at_unix_ms, 1700000000000);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn chat_message_roundtrips_bye() {
        let msg = ChatMessage::Bye;
        let bytes = serde_json::to_vec(&msg).unwrap();
        let decoded: ChatMessage = serde_json::from_slice(&bytes).unwrap();
        matches!(decoded, ChatMessage::Bye);
    }

    #[test]
    fn sanitize_strips_control_chars_except_newline() {
        let dirty = "hello\u{0007}world\nnext\u{001b}line";
        let clean = sanitize_text(dirty);
        assert_eq!(clean, "helloworld\nnextline");
    }

    #[test]
    fn sanitize_truncates_oversized_input() {
        let huge = "a".repeat(MAX_BODY_BYTES + 100);
        let clean = sanitize_text(&huge);
        assert_eq!(clean.len(), MAX_BODY_BYTES);
    }

    #[test]
    fn cli_command_parses_chat_send() {
        let raw = r#"{"type":"chat_send","body":"hi"}"#;
        let cmd: CliCommand = serde_json::from_str(raw).unwrap();
        match cmd {
            CliCommand::ChatSend { body } => assert_eq!(body, "hi"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn cli_command_parses_chat_stop() {
        let raw = r#"{"type":"chat_stop"}"#;
        let cmd: CliCommand = serde_json::from_str(raw).unwrap();
        matches!(cmd, CliCommand::ChatStop);
    }

    #[test]
    fn cli_command_parses_stop_send() {
        let raw = r#"{"type":"stop_send"}"#;
        let cmd: CliCommand = serde_json::from_str(raw).unwrap();
        matches!(cmd, CliCommand::StopSend);
    }
}
