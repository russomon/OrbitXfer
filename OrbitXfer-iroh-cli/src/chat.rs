//! Chat protocol (`orbitxfer/chat/1`) — v0.1.85, made bidirectional
//! and transfer-independent in v0.1.90.
//!
//! Implements a small 1:1 chat protocol that runs as a SECOND ALPN on
//! the same iroh endpoints that carry the `iroh_blobs` transfer. As of
//! v0.1.90 BOTH sides register a `ChatCoordinator` (so either can
//! accept a dial) AND can dial the other (so either side's Reconnect
//! Chat re-establishes a dropped session). The chat ALPN's lifetime is
//! independent of the transfer: chat outlives Stop Send / Stop Receive
//! and a completed download; the process exits only when chat is
//! closed (Stop Chat) or the window closes.
//!
//! Design highlights:
//!   - **No PAKE.** Authentication is implicit: only someone with the
//!     ticket can derive the sender's NodeID and dial it; once
//!     connected, each side knows the other's authenticated id. iroh's
//!     QUIC TLS layer encrypts the channel.
//!   - **Length-prefixed JSON frames.** 4-byte big-endian length +
//!     body. Max 4 KiB body (bounds memory; chat is text).
//!   - **One session at a time.** The session slot is claimed
//!     atomically when a connection is established (dial OR accept) and
//!     released when it ends; the loser of a simultaneous-connect race
//!     closes its connection, so the peers converge on one chat.
//!   - **Bidirectional message exchange.** After both sides exchange
//!     `Hello`, either may send `Text` at any time. Either side may
//!     send `Bye` to close gracefully.

use anyhow::{anyhow, bail, Result};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler},
    Endpoint, EndpointAddr,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex, Notify};
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

/// v0.1.93 — heartbeat cadence and the idle window after which a silent
/// peer is treated as gone. PING_INTERVAL well under IDLE_TIMEOUT so a
/// healthy peer always refreshes liveness with room to spare.
const PING_INTERVAL: Duration = Duration::from_secs(3);
const IDLE_TIMEOUT: Duration = Duration::from_secs(8);

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
    /// v0.1.93 — heartbeat. Sent every few seconds; carries no payload.
    /// Its job is to prove the connection is alive so a dead peer is
    /// detected within seconds (and the one-session slot freed for a
    /// quick reconnect) instead of waiting on the QUIC idle timeout.
    Ping,
    /// Graceful shutdown signal. The recipient should not send more
    /// messages after seeing this.
    Bye,
}

/// v0.1.90 — the unified, bidirectional chat coordinator.
///
/// Earlier versions split chat into two halves: a sender-side
/// `ChatProtocol` (accept-only) and a receiver-side manager
/// (dial-only). v0.1.90 makes chat **symmetric** and **independent of
/// the transfer**:
///   - **Both** sides register a `ChatCoordinator` on their Router, so
///     either peer can ACCEPT an incoming chat dial.
///   - **Both** sides can DIAL the other — the receiver knows the
///     sender from the ticket; the sender learns the receiver's
///     address from the first connection — so either side's Reconnect
///     Chat button can re-establish a dropped chat.
///   - Chat **outlives the transfer**: Stop Send / Stop Receive cancel
///     the transfer but the coordinator (and the process) stay alive
///     so the conversation continues. The process exits when chat is
///     closed (Stop Chat) or the window closes (stdin EOF).
///
/// One session at a time: the session slot (`active`) is claimed
/// atomically the moment a connection is established — whether we
/// dialed or accepted — and released when it ends. If both sides dial
/// at once, the loser of the claim closes its connection without
/// opening a session, so the peers converge on a single conversation.
#[derive(Clone)]
pub struct ChatCoordinator {
    inner: Arc<CoordInner>,
}

impl std::fmt::Debug for ChatCoordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatCoordinator")
            .field("self_label", &self.inner.self_label)
            .finish()
    }
}

struct CoordInner {
    /// Label to send in our Hello frame so the peer can render us
    /// with a friendly name.
    self_label: String,
    /// The shared iroh endpoint (same one the transfer uses). The chat
    /// rides it on the chat ALPN but is otherwise independent. Held here
    /// so the accept path can look up the peer's full address via
    /// `remote_info` (the "initial connection push" — v0.1.92).
    endpoint: Endpoint,
    /// One-session-at-a-time claim. Set true (atomically) when a
    /// connection is established — dial-success OR accept — and false
    /// when the session ends. The CAS loser closes its connection
    /// without opening a session.
    active: AtomicBool,
    /// `Some(tx)` while a chat session is live; `None` otherwise. The
    /// stdin dispatcher's ChatSend reaches the live session through it.
    outbox: Mutex<Option<mpsc::Sender<ChatMessage>>>,
    /// The peer we dial for (re)connection. Seeded on the receiver from
    /// the ticket; on the sender it's captured from the first inbound
    /// connection as a FULL routable address via `remote_info` (relay +
    /// direct), so the Send side can reliably dial back (v0.1.92 — was a
    /// bare NodeID before, which couldn't be dialed).
    peer: std::sync::Mutex<Option<EndpointAddr>>,
    /// A dialer is actively trying to (re)connect right now. Together
    /// with `ever_connected` this tells the post-transfer keepalive to
    /// hold the process open while chat is still live or fighting to
    /// be. Written only by the side's single dialer task.
    connecting: AtomicBool,
    /// True once a chat has connected at least once (sticky). Lets the
    /// keepalive linger for a dropped-but-recoverable chat so Reconnect
    /// still has a process to run in.
    ever_connected: AtomicBool,
    /// Pulsed whenever a session ends or the dialer's `connecting`
    /// state changes — wakes the keepalive (re-checks `should_linger`).
    chat_ended: Notify,
    /// Reconnect Chat: dial the peer now (or wake a parked dialer).
    manual_reconnect: Notify,
}

/// Result of attempting to run one chat session over a connection.
enum SessionOutcome {
    /// A session ran and ended for this reason.
    Ended(ChatEndReason),
    /// Another session was already active (CAS lost) — the connection
    /// was closed without opening a session. Not a failure.
    Busy,
    /// We connected but the handshake/session errored — treat as a
    /// failed attempt (backoff + retry on the auto-dialer).
    Failed,
}

impl ChatCoordinator {
    pub fn new(self_label: String, endpoint: Endpoint) -> Self {
        Self {
            inner: Arc::new(CoordInner {
                self_label,
                endpoint,
                active: AtomicBool::new(false),
                outbox: Mutex::new(None),
                peer: std::sync::Mutex::new(None),
                connecting: AtomicBool::new(false),
                ever_connected: AtomicBool::new(false),
                chat_ended: Notify::new(),
                manual_reconnect: Notify::new(),
            }),
        }
    }

    /// Seed the peer address (receiver: the sender's ticket addr).
    /// Does not overwrite an address we already have.
    pub fn set_peer(&self, addr: EndpointAddr) {
        let mut p = self.inner.peer.lock().unwrap();
        if p.is_none() {
            *p = Some(addr);
        }
    }

    /// Queue an outbound text message to the live chat session.
    /// Returns an error if no chat is currently connected.
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

    /// Stop Chat — v0.1.92: REVERSIBLE. Close the live session with a
    /// `Bye`, but keep the coordinator alive so Reconnect Chat can
    /// re-establish it. We do NOT stop the dialers for good and do NOT
    /// exit — the session ends as an intentional close, the dialers park
    /// waiting for a manual Reconnect, and the process keeps lingering
    /// (it exits only when the window closes). This is what lets the
    /// side that clicked Stop Chat get a working Reconnect button.
    pub async fn close(&self) -> Result<()> {
        let outbox = self.inner.outbox.lock().await;
        if let Some(sender) = outbox.as_ref() {
            let _ = sender.send(ChatMessage::Bye).await;
        }
        // NOTE: deliberately do NOT pulse manual_reconnect here — that
        // would make the auto-dialer immediately redial. We want it to
        // wait for an EXPLICIT Reconnect. chat_ended wakes the keepalive
        // to re-evaluate (it keeps lingering on `ever_connected`).
        self.inner.chat_ended.notify_waiters();
        Ok(())
    }

    /// Reconnect Chat — try to (re)establish a chat session now.
    pub fn request_reconnect(&self) {
        self.inner.manual_reconnect.notify_waiters();
    }

    /// Whether the process should keep lingering for chat after the
    /// transfer ends. True while a session is live, a dialer is trying,
    /// or a chat has connected at least once. v0.1.92 — once a chat has
    /// ever connected this stays true until the window closes (Stop Chat
    /// is reversible now, so it no longer forces an exit); a transfer
    /// that finishes with no chat ever established still exits promptly.
    pub fn should_linger(&self) -> bool {
        self.inner.active.load(SeqCst)
            || self.inner.connecting.load(SeqCst)
            || self.inner.ever_connected.load(SeqCst)
    }

    /// Await the next chat-lifecycle change (session end / dialer
    /// state change / Stop Chat). The keepalive races this against a
    /// periodic tick and ctrl-c.
    pub async fn wait_ended(&self) {
        self.inner.chat_ended.notified().await;
    }

    /// Spawn the receiver-side AUTO-dialer: actively dials the peer,
    /// runs the session, and self-heals through drops with backoff
    /// (real drops reconnect quickly; intentional closes wait for a
    /// manual Reconnect; dial/handshake failures back off to a streak
    /// cap then wait). Independent of the transfer — it keeps healing
    /// chat after Stop Receive; it stops only on Stop Chat.
    pub fn spawn_auto_dialer(&self, initial_conn: Option<Connection>) {
        let inner = self.inner.clone();
        inner.connecting.store(true, SeqCst);
        tokio::spawn(async move {
            // v0.1.92 — snappier reconnect: shorter dial timeout and a
            // lower backoff cap, still ramping gradually. Runs until the
            // process exits (window close); Stop Chat no longer stops it
            // for good — it just parks until a manual Reconnect.
            const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
            const MAX_FAIL_STREAK: u32 = 5;
            let mut pending = initial_conn;
            let mut first = true;
            let mut fail_streak: u32 = 0;

            loop {
                // ---- acquire a connection ----
                let conn = if let Some(c) = pending.take() {
                    Some(c)
                } else {
                    if !first {
                        crate::emit_event(json!({ "type": "chat_reconnecting" }));
                    }
                    inner.connecting.store(true, SeqCst);
                    let addr = inner.peer.lock().unwrap().clone();
                    match addr {
                        Some(a) => {
                            match timeout(DIAL_TIMEOUT, inner.endpoint.connect(a, CHAT_ALPN))
                                .await
                            {
                                Ok(Ok(c)) => Some(c),
                                Ok(Err(e)) => {
                                    crate::emit_event(json!({
                                        "type": if first { "chat_unavailable" } else { "chat_reconnect_failed" },
                                        "reason": format!("{}", e),
                                    }));
                                    None
                                }
                                Err(_) => {
                                    crate::emit_event(json!({
                                        "type": if first { "chat_unavailable" } else { "chat_reconnect_failed" },
                                        "reason": "timeout",
                                    }));
                                    None
                                }
                            }
                        }
                        None => None,
                    }
                };

                // ---- run the session (or record the failed attempt) ----
                let outcome = match conn {
                    Some(c) => run_session_claimed(&inner, c, ChatSide::Receiver).await,
                    None => SessionOutcome::Failed,
                };
                first = false;

                // ---- decide what to do next ----
                match outcome {
                    // Real drop → reconnect quickly (stay "connecting").
                    SessionOutcome::Ended(r) if r.is_drop() => {
                        fail_streak = 0;
                        inner.connecting.store(true, SeqCst);
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                            _ = inner.manual_reconnect.notified() => {}
                        }
                        continue;
                    }
                    // Intentional close (PeerBye / LocalBye) → stop auto-
                    // dialing; park until a manual Reconnect.
                    SessionOutcome::Ended(_) => {
                        fail_streak = 0;
                        inner.connecting.store(false, SeqCst);
                        inner.chat_ended.notify_waiters();
                        inner.manual_reconnect.notified().await;
                        continue;
                    }
                    // A session is already running via the accept path
                    // (the sender dialed us). Wait for it to end.
                    SessionOutcome::Busy => {
                        inner.connecting.store(false, SeqCst);
                        inner.chat_ended.notify_waiters();
                        tokio::select! {
                            _ = inner.chat_ended.notified() => {}
                            _ = inner.manual_reconnect.notified() => {}
                            // Re-check periodically so a missed wake (the
                            // accept session can end before we register the
                            // notified() above, in the rare both-sides-dial
                            // race) can't strand us — we just re-dial.
                            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                        }
                        continue;
                    }
                    // Dial/handshake failed → backoff, then park for a
                    // manual Reconnect after the streak cap.
                    SessionOutcome::Failed => {
                        fail_streak += 1;
                        if fail_streak >= MAX_FAIL_STREAK {
                            crate::emit_event(json!({
                                "type": "chat_gave_up",
                                "attempts": fail_streak,
                            }));
                            inner.connecting.store(false, SeqCst);
                            inner.chat_ended.notify_waiters();
                            inner.manual_reconnect.notified().await;
                            fail_streak = 0;
                            continue;
                        }
                        let secs = (1u64 << fail_streak.min(3)).min(8);
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
                            _ = inner.manual_reconnect.notified() => { fail_streak = 0; }
                        }
                        continue;
                    }
                }
            }
        });
    }

    /// Spawn the sender-side MANUAL dialer: it parks until the user
    /// hits Reconnect Chat, then dials the receiver (learned from the
    /// first inbound connection). It does NOT auto-dial on drops —
    /// the receiver's auto-dialer heals those by re-dialing us (which
    /// our accept path serves) — so the two sides don't fight over who
    /// dials. Lets the Send side's Reconnect Chat button re-initiate
    /// chat even when the receiver isn't auto-dialing (e.g. after an
    /// intentional close).
    pub fn spawn_manual_dialer(&self) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
            loop {
                inner.manual_reconnect.notified().await;
                // Already chatting (or a session is establishing)? The
                // poke is a harmless no-op.
                if inner.active.load(SeqCst) {
                    continue;
                }
                let addr = inner.peer.lock().unwrap().clone();
                let Some(addr) = addr else {
                    crate::emit_event(json!({
                        "type": "chat_reconnect_failed",
                        "reason": "peer not yet known",
                    }));
                    continue;
                };
                crate::emit_event(json!({ "type": "chat_reconnecting" }));
                inner.connecting.store(true, SeqCst);
                match timeout(DIAL_TIMEOUT, inner.endpoint.connect(addr, CHAT_ALPN)).await {
                    Ok(Ok(c)) => {
                        let _ = run_session_claimed(&inner, c, ChatSide::Receiver).await;
                    }
                    Ok(Err(e)) => {
                        crate::emit_event(json!({
                            "type": "chat_reconnect_failed",
                            "reason": format!("{}", e),
                        }));
                    }
                    Err(_) => {
                        crate::emit_event(json!({
                            "type": "chat_reconnect_failed",
                            "reason": "timeout",
                        }));
                    }
                }
                inner.connecting.store(false, SeqCst);
                inner.chat_ended.notify_waiters();
            }
        });
    }
}

/// Claim the single session slot (CAS), learn the peer if unknown,
/// run one chat session, then release the slot. Used by both the
/// accept path and the dialers so they share one conversation.
async fn run_session_claimed(
    inner: &Arc<CoordInner>,
    connection: Connection,
    role: ChatSide,
) -> SessionOutcome {
    // One session at a time. The loser of a simultaneous-connect race
    // closes its connection without opening a session.
    if inner
        .active
        .compare_exchange(false, true, SeqCst, SeqCst)
        .is_err()
    {
        connection.close(0u32.into(), b"chat busy");
        return SessionOutcome::Busy;
    }

    // v0.1.92 — the "initial connection push". Learn the peer's FULL
    // routable address (relay + direct paths) via remote_info, so the
    // sender can reliably dial the receiver back later. Only when we
    // don't already have one — the receiver keeps its rich ticket addr.
    // (remote_info is async, so we don't hold the std mutex across it.)
    let need_peer = inner.peer.lock().unwrap().is_none();
    if need_peer {
        let id = connection.remote_id();
        let addr = match inner.endpoint.remote_info(id).await {
            Some(info) => {
                EndpointAddr::from_parts(info.id(), info.into_addrs().map(|a| a.into_addr()))
            }
            None => EndpointAddr::new(id),
        };
        let mut p = inner.peer.lock().unwrap();
        if p.is_none() {
            *p = Some(addr);
        }
    }

    let (tx, rx) = mpsc::channel::<ChatMessage>(64);
    {
        *inner.outbox.lock().await = Some(tx);
    }
    let result = run_chat_session(connection, role, inner.self_label.clone(), rx).await;
    {
        *inner.outbox.lock().await = None;
    }
    inner.active.store(false, SeqCst);

    match result {
        Ok(reason) => {
            inner.ever_connected.store(true, SeqCst);
            SessionOutcome::Ended(reason)
        }
        Err(e) => {
            crate::emit_event(json!({
                "type": "chat_session_error",
                "error": format!("{}", e),
            }));
            SessionOutcome::Failed
        }
    }
}

impl ProtocolHandler for ChatCoordinator {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let remote_id = connection.remote_id().to_string();

        // Fast-path reject if a session is already live (the CAS in
        // run_session_claimed is the real guard; this avoids spawning
        // a task we'd immediately tear down and emits a useful event).
        if self.inner.active.load(SeqCst) {
            crate::emit_event(json!({
                "type": "chat_attempt_rejected",
                "reason": "chat_busy",
                "endpoint_id": remote_id,
            }));
            connection.close(0u32.into(), b"chat busy");
            return Ok(());
        }

        let inner = self.inner.clone();
        // Spawn the session as a task so accept() can return; the iroh
        // router keeps the connection alive via the task. We use the
        // accept (server) stream role here.
        tokio::spawn(async move {
            let _ = run_session_claimed(&inner, connection, ChatSide::Sender).await;
            // Accept path doesn't loop; wake the keepalive so it can
            // re-evaluate (ever_connected keeps it lingering if a real
            // chat happened; the receiver's auto-dialer or a manual
            // Reconnect can re-establish).
            inner.chat_ended.notify_waiters();
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
/// v0.1.89 — why a chat session ended. The receiver-side chat manager
/// uses this to decide whether to auto-reconnect: a real DROP
/// (`StreamClosed` / `SendError`) self-heals with backoff, while an
/// intentional `PeerBye` / `LocalBye` does not (the chat was closed on
/// purpose; the user can still hit Reconnect Chat manually).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatEndReason {
    /// The peer sent a Bye frame (they closed chat).
    PeerBye,
    /// We sent a Bye frame (this side closed chat — Stop Chat / Stop
    /// Receive, or the outbox was dropped).
    LocalBye,
    /// The stream ended without a Bye (EOF / connection lost) — a
    /// drop, e.g. the sender bounced. Reconnectable.
    StreamClosed,
    /// An outbound write failed. Reconnectable.
    SendError,
}

impl ChatEndReason {
    /// True for the reasons the manager should auto-reconnect on.
    pub fn is_drop(self) -> bool {
        matches!(self, ChatEndReason::StreamClosed | ChatEndReason::SendError)
    }
}

pub async fn run_chat_session(
    connection: Connection,
    side: ChatSide,
    self_label: String,
    mut outbox_rx: mpsc::Receiver<ChatMessage>,
) -> Result<ChatEndReason> {
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

    // v0.1.93 — the message loop. The WRITE half stays in this loop
    // (so outbound text, heartbeat pings, and Bye all serialize on the
    // single send stream). The READ half runs in a dedicated task and
    // forwards decoded frames over a channel — this matters because a
    // `select!` would otherwise cancel `recv_frame` mid-frame whenever
    // the outbound/ping branch fires, corrupting the stream. mpsc recv
    // is cancellation-safe, so the channel hop fixes that.
    let (frame_tx, mut frame_rx) =
        mpsc::channel::<std::result::Result<ChatMessage, ()>>(16);
    let mut reader_recv = recv;
    let reader = tokio::spawn(async move {
        loop {
            match recv_frame(&mut reader_recv).await {
                Ok(msg) => {
                    if frame_tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = frame_tx.send(Err(())).await;
                    break;
                }
            }
        }
    });

    // Heartbeat: ping every PING_INTERVAL, and on each tick check that a
    // frame (ping OR message) has arrived within IDLE_TIMEOUT — if not,
    // the peer is gone, so end the session promptly to free the slot.
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await; // consume the immediate first tick
    let mut last_inbound = std::time::Instant::now();

    let mut we_sent_bye = false;
    let reason: ChatEndReason = loop {
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
                            break ChatEndReason::SendError;
                        }
                        if is_bye {
                            we_sent_bye = true;
                            break ChatEndReason::LocalBye;
                        }
                    }
                    None => {
                        // Outbox closed externally. Treat as an implicit
                        // Bye if we haven't already sent one.
                        if !we_sent_bye {
                            let _ = send_frame(&mut send, &ChatMessage::Bye).await;
                        }
                        break ChatEndReason::LocalBye;
                    }
                }
            }
            // Inbound: a decoded frame (or a read error) from the reader.
            inbound = frame_rx.recv() => {
                match inbound {
                    None | Some(Err(())) => break ChatEndReason::StreamClosed,
                    Some(Ok(msg)) => {
                        last_inbound = std::time::Instant::now();
                        match msg {
                            ChatMessage::Text { body, sent_at_unix_ms } => {
                                let body = sanitize_text(&body);
                                crate::emit_event(json!({
                                    "type": "chat_message_received",
                                    "body": body,
                                    "sent_at_unix_ms": sent_at_unix_ms,
                                }));
                            }
                            // Heartbeat — already refreshed last_inbound.
                            ChatMessage::Ping => {}
                            ChatMessage::Hello { .. } => {
                                eprintln!("[chat] unexpected Hello after handshake");
                            }
                            ChatMessage::Bye => {
                                if !we_sent_bye {
                                    let _ = send_frame(&mut send, &ChatMessage::Bye).await;
                                }
                                break ChatEndReason::PeerBye;
                            }
                        }
                    }
                }
            }
            // Heartbeat tick: detect a dead peer, then ping.
            _ = ping.tick() => {
                if last_inbound.elapsed() > IDLE_TIMEOUT {
                    break ChatEndReason::StreamClosed;
                }
                if send_frame(&mut send, &ChatMessage::Ping).await.is_err() {
                    break ChatEndReason::SendError;
                }
            }
        }
    };

    // Stop the reader and close our write side so the peer reads EOF.
    reader.abort();
    let _ = send.finish();

    crate::emit_event(json!({
        "type": "chat_disconnected",
        "endpoint_id": remote_id,
        "reason": format!("{:?}", reason),
    }));

    Ok(reason)
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
    /// v0.1.88 — re-dial the chat ALPN. Used when a chat connection
    /// dropped (e.g. the sender bounced) but the receive process is
    /// still alive. Starts a fresh chat session to the same sender.
    #[serde(rename = "reconnect_chat")]
    ReconnectChat,
    /// v0.1.93 — resume serving in the EXISTING send process (no
    /// respawn): re-pin the cached blob and clear the stop/abort flags.
    #[serde(rename = "resume_send")]
    ResumeSend,
    /// v0.1.93 — resume the download in the EXISTING receive process
    /// (no respawn): re-run the download loop from the partial store.
    #[serde(rename = "resume_receive")]
    ResumeReceive,
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
