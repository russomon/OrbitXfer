//! Shareable Code (pairing) protocol — v0.1.84 Phase 1.
//!
//! Lets a sender publish a 4-word code that a receiver enters to start
//! a transfer, replacing the need to share a ~240-character blob ticket
//! out-of-band. ALPN: `orbitxfer/pair/1`.
//!
//! Phase 1 scope (this file): the pairing protocol itself — code
//! generation, NodeID derivation from code, the CPace PAKE handshake
//! gated by Argon2id, AEAD-sealed transfer-offer exchange. Two new
//! subcommands wired into main.rs (`pair-host`, `pair-join`). All
//! state-change events emitted as OX_EVENT lines so a later UI layer
//! can consume them without touching the protocol code.
//!
//! Phase 1 explicitly does NOT do:
//!   - bundle the actual blob transfer (run_pair_host stops after
//!     sending the TransferOffer; receiver acknowledges and exits)
//!   - frontend wiring
//!   - persistence (codes live only in memory)
//!
//! Phase 2 will join the pairing handshake to the existing send/
//! receive code paths so the file actually moves after the handshake.

use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use blake3::Hasher;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key as AeadKey, Nonce,
};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr,
};
use iroh_base::SecretKey;
use pake_cpace::{CPace, Step1Out, STEP1_PACKET_BYTES, STEP2_PACKET_BYTES};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::time::timeout;

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

/// ALPN for the pairing protocol. The receiver dials the sender's
/// (code-derived) ephemeral NodeID on this ALPN; the sender's Router
/// registers `PairProtocol` against it.
pub const PAIR_ALPN: &[u8] = b"orbitxfer/pair/1";

/// Wire-format version. v1 is what Phase 1 ships.
const PROTO_VERSION: u8 = 1;

/// Domain-separation string for BLAKE3 key derivation: distinguishes
/// our derived secret key from any other use of BLAKE3 on the same code.
const KDF_CONTEXT_IDENTITY: &str = "orbitxfer-pair-v1-identity";

/// CPace identity labels — sender = responder, receiver = initiator.
/// These must agree on both ends.
const CPACE_ID_A: &str = "orbitxfer-receiver";
const CPACE_ID_B: &str = "orbitxfer-sender";

/// Associated data fed into CPace (binds the handshake to this protocol).
const CPACE_AD: &[u8] = b"orbitxfer-pair/1";

// Argon2id parameters. Calibrated to ~1 s per attempt on a 2026-era
// laptop. ARGON2_MEM_KB is per-attempt RAM cost; set high enough to
// make GPU/ASIC parallelization expensive.
const ARGON2_MEM_KB: u32 = 64 * 1024; // 64 MiB
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const ARGON2_OUTPUT_LEN: usize = 32;

/// Per-source short-window rate limit: max 5 attempts per 60 s.
const RL_WINDOW: Duration = Duration::from_secs(60);
const RL_MAX_PER_WINDOW: usize = 5;

/// Phase 1 code shape: 4 EFF words separated by hyphens.
/// Entropy: 4 × log₂(7776) ≈ 51.7 bits. With Argon2id at 1 s/attempt
/// and the per-source rate limit, this is comfortably forever-grade.
const CODE_WORDS: usize = 4;
const CODE_SEPARATOR: char = '-';

/// Hard ceiling for any single postcard-framed message we receive
/// over the pairing wire. Protects against memory-exhaustion attacks.
const MAX_MSG_BYTES: usize = 64 * 1024;

// ----------------------------------------------------------------
// Wire messages (postcard-encoded; length-prefixed on the stream)
// ----------------------------------------------------------------

/// M1 — receiver → sender. Carries the receiver's nonce + the CPace
/// step1 packet (which embeds CPace's own session ID).
#[derive(Debug, Serialize, Deserialize)]
struct PairHello {
    proto_version: u8,
    nonce_r: [u8; 16],
    // STEP1_PACKET_BYTES = 48 in pake-cpace 0.1.
    cpace_step1: Vec<u8>,
}

/// M2 — sender → receiver. Sender's CPace step2 packet + sender's
/// key-confirmation MAC.
#[derive(Debug, Serialize, Deserialize)]
struct PairResponse {
    // STEP2_PACKET_BYTES = 32 in pake-cpace 0.1.
    cpace_step2: Vec<u8>,
    key_confirm_b: [u8; 32],
}

/// M3 — receiver → sender. Receiver's key-confirmation MAC (proves
/// the receiver successfully derived the same session key).
#[derive(Debug, Serialize, Deserialize)]
struct PairKeyConfirm {
    key_confirm_a: [u8; 32],
}

/// M4 — sender → receiver, AEAD-sealed under the derived session key.
/// Tells the receiver what's on offer.
#[derive(Debug, Serialize, Deserialize)]
pub struct TransferOffer {
    pub hash: [u8; 32],
    pub format: u8, // 0 = Raw, 1 = HashSeq
    pub size: u64,
    pub name: String,
    pub is_folder: bool,
    pub file_count: Option<u32>,
}

/// M5 — receiver → sender, AEAD-sealed. Optional receiver-volunteered
/// metadata (e.g. nickname). Piggybacks the v0.1.71 label feature so
/// we skip the separate `orbitxfer/label/0` round-trip.
#[derive(Debug, Serialize, Deserialize)]
pub struct TransferAccept {
    pub receiver_label: Option<String>,
}

// ----------------------------------------------------------------
// Code generation, validation, and identity derivation
// ----------------------------------------------------------------

/// Generate a fresh 4-word pairing code from the EFF Long Wordlist
/// using a CSPRNG.
///
/// The EFF list contains 4 hyphen-bearing entries ("drop-down",
/// "felt-tip", "t-shirt", "yo-yo") which would corrupt our hyphen-
/// separated code format. We skip them during generation; that drops
/// us from 7776 → 7772 candidates per slot, an entropy loss of
/// <0.001 bits per word — well below the noise floor.
pub fn generate_code() -> String {
    use eff_wordlist::large::LIST;
    let mut rng = OsRng;
    let mut words: Vec<&'static str> = Vec::with_capacity(CODE_WORDS);
    let n = LIST.len() as u32;
    while words.len() < CODE_WORDS {
        let idx = (rng.next_u32() % n) as usize;
        let candidate = LIST[idx].1;
        if !candidate.contains(CODE_SEPARATOR) {
            words.push(candidate);
        }
    }
    words.join(&CODE_SEPARATOR.to_string())
}

/// Validate that a code parses as exactly CODE_WORDS hyphen-separated
/// words, each of which appears in the EFF Long Wordlist.
pub fn validate_code(code: &str) -> Result<()> {
    use eff_wordlist::large::LIST;
    let parts: Vec<&str> = code.split(CODE_SEPARATOR).collect();
    if parts.len() != CODE_WORDS {
        bail!(
            "code must be exactly {} hyphen-separated words (got {})",
            CODE_WORDS,
            parts.len()
        );
    }
    for (i, word) in parts.iter().enumerate() {
        let trimmed = word.trim().to_ascii_lowercase();
        if !LIST.iter().any(|(_, w)| *w == trimmed) {
            bail!(
                "word {} ({:?}) is not in the EFF Long Wordlist",
                i + 1,
                word
            );
        }
    }
    Ok(())
}

/// Normalize a user-typed code: lowercase, hyphen-joined, trimmed of
/// whitespace around each word. The PAKE then operates on the
/// normalized form so cosmetic variations don't cause mismatches.
pub fn normalize_code(code: &str) -> String {
    code.split(CODE_SEPARATOR)
        .map(|w| w.trim().to_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(&CODE_SEPARATOR.to_string())
}

/// Derive the ephemeral ed25519 SecretKey deterministically from the
/// code. Both sides run this; the sender keeps the secret, the
/// receiver only needs the derived public key (the NodeID) to dial.
pub fn derive_ephemeral_secret_key(code: &str) -> SecretKey {
    let normalized = normalize_code(code);
    let mut hasher = Hasher::new_derive_key(KDF_CONTEXT_IDENTITY);
    hasher.update(normalized.as_bytes());
    let mut bytes = [0u8; 32];
    hasher.finalize_xof().fill(&mut bytes);
    SecretKey::from_bytes(&bytes)
}

// ----------------------------------------------------------------
// Wire codec — postcard with a 4-byte big-endian length prefix
// ----------------------------------------------------------------

async fn send_message<T: Serialize>(stream: &mut SendStream, msg: &T) -> Result<()> {
    let bytes = postcard::to_stdvec(msg)?;
    if bytes.len() > MAX_MSG_BYTES {
        bail!("outgoing message too large: {}", bytes.len());
    }
    let len = (bytes.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

async fn recv_message<T: for<'a> Deserialize<'a>>(stream: &mut RecvStream) -> Result<T> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| anyhow!("read length: {:?}", e))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_MSG_BYTES {
        bail!("incoming message claims length {} (max {})", len, MAX_MSG_BYTES);
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(|e| anyhow!("read body: {:?}", e))?;
    Ok(postcard::from_bytes(&buf)?)
}

// ----------------------------------------------------------------
// AEAD seal / open over the derived session key
// ----------------------------------------------------------------

/// Construct a deterministic 12-byte nonce from a counter. The session
/// key is fresh per handshake, and each direction uses its own
/// counter, so collisions are impossible inside a session.
fn nonce_from_counter(direction: &[u8], counter: u64) -> Nonce {
    let mut bytes = [0u8; 12];
    let take = direction.len().min(4);
    bytes[..take].copy_from_slice(&direction[..take]);
    bytes[4..12].copy_from_slice(&counter.to_be_bytes());
    *Nonce::from_slice(&bytes)
}

async fn send_sealed<T: Serialize>(
    stream: &mut SendStream,
    key: &[u8; 32],
    direction: &[u8],
    counter: u64,
    payload: &T,
) -> Result<()> {
    let plain = postcard::to_stdvec(payload)?;
    let aead = ChaCha20Poly1305::new(AeadKey::from_slice(key));
    let nonce = nonce_from_counter(direction, counter);
    let ciphertext = aead
        .encrypt(&nonce, plain.as_ref())
        .map_err(|_| anyhow!("aead encrypt failed"))?;
    let len = (ciphertext.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&ciphertext).await?;
    Ok(())
}

async fn recv_sealed<T: for<'a> Deserialize<'a>>(
    stream: &mut RecvStream,
    key: &[u8; 32],
    direction: &[u8],
    counter: u64,
) -> Result<T> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| anyhow!("{:?}", e))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_MSG_BYTES {
        bail!("sealed message length {} too large", len);
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(|e| anyhow!("{:?}", e))?;
    let aead = ChaCha20Poly1305::new(AeadKey::from_slice(key));
    let nonce = nonce_from_counter(direction, counter);
    let plain = aead
        .decrypt(&nonce, buf.as_ref())
        .map_err(|_| anyhow!("aead decrypt failed (wrong key or tampered ciphertext)"))?;
    Ok(postcard::from_bytes(&plain)?)
}

// ----------------------------------------------------------------
// Argon2id-gated password derivation for CPace
// ----------------------------------------------------------------

/// Wrap the bare code in Argon2id BEFORE feeding it into CPace. This
/// makes every PAKE attempt — legitimate or attacker — pay a ~1 s
/// memory-hard cost. The salt is the receiver's nonce, so precomputed
/// rainbow tables don't help an attacker who passively observes
/// the wire.
///
/// Returns the hex-encoded Argon2 output as a string — pake-cpace's
/// step1/step2 take `&str` for the password.
fn argon2_password(code: &str, nonce_r: &[u8; 16]) -> Result<String> {
    let params = Params::new(
        ARGON2_MEM_KB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(ARGON2_OUTPUT_LEN),
    )
    .map_err(|e| anyhow!("argon2 params: {}", e))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; ARGON2_OUTPUT_LEN];
    argon
        .hash_password_into(code.as_bytes(), nonce_r, &mut out)
        .map_err(|e| anyhow!("argon2 hash: {}", e))?;
    let mut hex = String::with_capacity(ARGON2_OUTPUT_LEN * 2);
    for b in &out {
        hex.push_str(&format!("{:02x}", b));
    }
    Ok(hex)
}

/// Key-confirmation MAC. Both sides compute their own and exchange.
/// Matching MACs prove both sides arrived at the same session key.
fn key_confirm(role: &[u8], session_key: &[u8; 32]) -> [u8; 32] {
    let mut h = Hasher::new_keyed(session_key);
    h.update(role);
    let mut out = [0u8; 32];
    h.finalize_xof().fill(&mut out);
    out
}

// ----------------------------------------------------------------
// Rate-limit state per remote source
// ----------------------------------------------------------------

#[derive(Debug, Default)]
struct RateLimiter {
    failures: Mutex<HashMap<String, Vec<Instant>>>,
}

impl RateLimiter {
    fn check(&self, remote: &str) -> Result<()> {
        let mut map = self.failures.lock().unwrap();
        let entries = map.entry(remote.to_string()).or_default();
        let cutoff = Instant::now() - RL_WINDOW;
        entries.retain(|t| *t > cutoff);
        if entries.len() >= RL_MAX_PER_WINDOW {
            bail!(
                "rate-limit: {} failed attempts in the last {}s",
                entries.len(),
                RL_WINDOW.as_secs()
            );
        }
        Ok(())
    }

    fn record_failure(&self, remote: &str) -> usize {
        let mut map = self.failures.lock().unwrap();
        let entries = map.entry(remote.to_string()).or_default();
        entries.push(Instant::now());
        entries.len()
    }
}

// ----------------------------------------------------------------
// PairSession + PairProtocol — sender-side ALPN handler
// ----------------------------------------------------------------

/// State the sender's CLI keeps while publishing a code. The Tauri
/// sidecar holds an `Arc<PairSession>` and registers a
/// `PairProtocol(session.clone())` on the Router.
#[derive(Debug)]
pub struct PairSession {
    code: String,
    offer: TransferOffer,
    rate_limiter: RateLimiter,
}

impl PairSession {
    pub fn new(code: String, offer: TransferOffer) -> Self {
        Self {
            code,
            offer,
            rate_limiter: RateLimiter::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PairProtocol {
    inner: Arc<PairSession>,
}

impl PairProtocol {
    pub fn new(session: Arc<PairSession>) -> Self {
        Self { inner: session }
    }
}

impl ProtocolHandler for PairProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let remote = connection.remote_id().to_string();

        // Layer 2 defense: short-window rate limit. Reject without
        // running CPace so attackers can't burn the server's CPU.
        if let Err(e) = self.inner.rate_limiter.check(&remote) {
            crate::emit_event(json!({
                "type": "pairing_attempt_rejected",
                "endpoint_id": remote,
                "reason": format!("{}", e),
            }));
            return Ok(());
        }

        crate::emit_event(json!({
            "type": "pairing_attempt_started",
            "endpoint_id": remote,
        }));

        match self.run_session(&connection, &remote).await {
            Ok(()) => {}
            Err(e) => {
                let count = self.inner.rate_limiter.record_failure(&remote);
                crate::emit_event(json!({
                    "type": "pairing_attempt_failed",
                    "endpoint_id": remote,
                    "reason": format!("{}", e),
                }));
                if count >= RL_MAX_PER_WINDOW {
                    crate::emit_event(json!({
                        "type": "pairing_attack_warning",
                        "endpoint_id": remote,
                        "failed_count": count,
                        "window_seconds": RL_WINDOW.as_secs(),
                    }));
                }
            }
        }

        connection.closed().await;
        Ok(())
    }
}

impl PairProtocol {
    async fn run_session(&self, conn: &Connection, remote: &str) -> Result<()> {
        let (mut send, mut recv) = conn
            .accept_bi()
            .await
            .map_err(|e| anyhow!("accept_bi: {:?}", e))?;

        // ---- M1: receive PairHello ----
        let m1: PairHello = recv_message(&mut recv).await?;
        if m1.proto_version != PROTO_VERSION {
            bail!("unsupported proto_version: {}", m1.proto_version);
        }
        if m1.cpace_step1.len() != STEP1_PACKET_BYTES {
            bail!(
                "cpace_step1 wrong length: {} (want {})",
                m1.cpace_step1.len(),
                STEP1_PACKET_BYTES
            );
        }
        let mut step1_packet = [0u8; STEP1_PACKET_BYTES];
        step1_packet.copy_from_slice(&m1.cpace_step1);

        // CPace step2 = responder. We derive the password identically
        // to the receiver (same code, same nonce_r) and feed it in.
        let password = argon2_password(&self.inner.code, &m1.nonce_r)?;
        let step2_out = CPace::step2(
            &step1_packet,
            &password,
            CPACE_ID_A,
            CPACE_ID_B,
            Some(CPACE_AD),
        )
        .map_err(|e| anyhow!("cpace step2: {:?}", e))?;
        let session_key = step2_out.shared_keys().k1;
        let step2_packet = step2_out.packet();

        // ---- M2: send PairResponse ----
        let key_confirm_b = key_confirm(b"sender", &session_key);
        let m2 = PairResponse {
            cpace_step2: step2_packet.to_vec(),
            key_confirm_b,
        };
        send_message(&mut send, &m2).await?;

        // ---- M3: receive PairKeyConfirm ----
        let m3: PairKeyConfirm = recv_message(&mut recv).await?;
        let expected_a = key_confirm(b"receiver", &session_key);
        if m3.key_confirm_a != expected_a {
            bail!("key confirmation mismatch — wrong code or MITM");
        }

        crate::emit_event(json!({
            "type": "pairing_attempt_succeeded",
            "endpoint_id": remote,
        }));

        // ---- M4: send TransferOffer, AEAD-sealed ----
        send_sealed(&mut send, &session_key, b"s2r", 0, &self.inner.offer).await?;
        crate::emit_event(json!({
            "type": "pairing_offer_sent",
            "endpoint_id": remote,
        }));

        // ---- M5: receive TransferAccept, AEAD-sealed ----
        let accept: TransferAccept = recv_sealed(&mut recv, &session_key, b"r2s", 0).await?;
        if let Some(label) = accept.receiver_label.as_ref() {
            // Piggyback the v0.1.71 receiver-label feature: emit the
            // same event the dedicated label ALPN would emit, so the
            // sender UI's Receivers panel sees the name without an
            // extra connection.
            let trimmed: String = label.chars().filter(|c| !c.is_control()).collect();
            let trimmed = trimmed.trim().chars().take(64).collect::<String>();
            if !trimmed.is_empty() {
                crate::emit_event(json!({
                    "type": "receiver_label",
                    "endpoint_id": remote,
                    "label": trimmed,
                }));
            }
        }

        // Phase 1 stops here. Phase 2 will follow this with the actual
        // blob handoff (the receiver opens an iroh_blobs::ALPN
        // connection to the same NodeID and pulls the file).
        crate::emit_event(json!({
            "type": "pairing_session_ready",
            "endpoint_id": remote,
        }));

        Ok(())
    }
}

// ----------------------------------------------------------------
// Subcommand entry points
// ----------------------------------------------------------------

/// `orbitxfer-iroh-cli pair-host <file>`
///
/// Phase 1: hash the file (raw BLAKE3, not yet stored in iroh-blobs),
/// generate a code, derive the ephemeral identity, stand up an
/// endpoint with PairProtocol registered, wait for Ctrl-C. After the
/// handshake completes with a receiver, the pairing flow ends — Phase
/// 2 will hand off to the actual blob transfer here.
pub async fn run_pair_host(file_path: PathBuf) -> Result<()> {
    let abs_path = crate::abs_path(&file_path)?;
    let meta = std::fs::metadata(&abs_path).context("stat file")?;

    let mut hasher = blake3::Hasher::new();
    if meta.is_file() {
        let mut file = std::fs::File::open(&abs_path).context("open file")?;
        std::io::copy(&mut file, &mut hasher).context("hash file")?;
    } else {
        // Folder placeholder hash: BLAKE3 of the absolute path. Phase 2
        // will replace this with the iroh-blobs HashSeq root hash.
        hasher.update(abs_path.to_string_lossy().as_bytes());
    }
    let hash = *hasher.finalize().as_bytes();

    let name = abs_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let is_folder = meta.is_dir();
    let offer = TransferOffer {
        hash,
        format: if is_folder { 1 } else { 0 },
        size: if is_folder { 0 } else { meta.len() },
        name: name.clone(),
        is_folder,
        file_count: None,
    };

    let code = generate_code();
    let secret = derive_ephemeral_secret_key(&code);
    let ephemeral_node_id = secret.public();

    crate::emit_line(&format!(
        "Shareable code: {} (point your receiver at it)",
        code
    ));
    crate::emit_event(json!({
        "type": "pairing_code_ready",
        "code": code,
        "endpoint_id": ephemeral_node_id.to_string(),
        "file_name": name,
        "total_size": offer.size,
        "is_folder": is_folder,
    }));

    let endpoint = Endpoint::builder().secret_key(secret).bind().await?;
    let _ = endpoint.online().await;

    let session = Arc::new(PairSession::new(code.clone(), offer));
    let pair_proto = PairProtocol::new(session);

    let router = Router::builder(endpoint)
        .accept(PAIR_ALPN, pair_proto)
        .spawn();

    crate::emit_line("Pair-host running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    crate::emit_line("Shutting down.");
    router.shutdown().await?;
    Ok(())
}

/// `orbitxfer-iroh-cli pair-join <code> <output-path>`
///
/// Phase 1: derive the sender's ephemeral NodeID from the code, dial
/// it on PAIR_ALPN, run the CPace handshake (Argon2-gated), decrypt
/// the offer, send back an accept. Phase 2 will then hand off to the
/// existing blob-receive flow to actually download the file.
pub async fn run_pair_join(code: String, output_path: PathBuf) -> Result<()> {
    validate_code(&code)?;
    let code = normalize_code(&code);

    let sender_secret = derive_ephemeral_secret_key(&code);
    let sender_node_id = sender_secret.public();

    crate::emit_event(json!({
        "type": "pairing_lookup_started",
        "endpoint_id": sender_node_id.to_string(),
    }));

    let endpoint = Endpoint::builder().bind().await?;
    let _ = endpoint.online().await;

    // Receiver = CPace initiator. Pick a fresh nonce, run step1 with
    // the Argon2-stretched password.
    let mut nonce_r = [0u8; 16];
    OsRng.fill_bytes(&mut nonce_r);
    let password = argon2_password(&code, &nonce_r)?;
    let step1_out: Step1Out = CPace::step1(&password, CPACE_ID_A, CPACE_ID_B, Some(CPACE_AD))
        .map_err(|e| anyhow!("cpace step1: {:?}", e))?;
    let step1_packet = step1_out.packet();

    let addr = EndpointAddr::new(sender_node_id);
    let conn = match timeout(Duration::from_secs(15), endpoint.connect(addr, PAIR_ALPN)).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(e)) => {
            crate::emit_event(json!({
                "type": "pairing_lookup_failed",
                "reason": format!("{:?}", e),
                "hint": "Sender may not be online, or the code may be wrong.",
            }));
            return Err(anyhow!("pairing connect: {:?}", e));
        }
        Err(_) => {
            crate::emit_event(json!({
                "type": "pairing_lookup_failed",
                "reason": "timeout",
                "hint": "Sender may not be online, or the code may be wrong.",
            }));
            return Err(anyhow!("pairing lookup timed out"));
        }
    };

    crate::emit_event(json!({ "type": "pairing_handshake_started" }));

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| anyhow!("open_bi: {:?}", e))?;

    // ---- M1: send PairHello ----
    let m1 = PairHello {
        proto_version: PROTO_VERSION,
        nonce_r,
        cpace_step1: step1_packet.to_vec(),
    };
    send_message(&mut send, &m1).await?;

    // ---- M2: receive PairResponse ----
    let m2: PairResponse = recv_message(&mut recv).await?;
    if m2.cpace_step2.len() != STEP2_PACKET_BYTES {
        bail!(
            "cpace_step2 wrong length: {} (want {})",
            m2.cpace_step2.len(),
            STEP2_PACKET_BYTES
        );
    }
    let mut step2_packet = [0u8; STEP2_PACKET_BYTES];
    step2_packet.copy_from_slice(&m2.cpace_step2);

    let shared_keys = step1_out
        .step3(&step2_packet)
        .map_err(|e| anyhow!("cpace step3: {:?}", e))?;
    let session_key = shared_keys.k1;

    let expected_b = key_confirm(b"sender", &session_key);
    if m2.key_confirm_b != expected_b {
        crate::emit_event(json!({
            "type": "pairing_handshake_failed",
            "reason": "wrong_code",
        }));
        bail!("sender's key-confirmation didn't match — likely wrong code");
    }

    // ---- M3: send PairKeyConfirm ----
    let m3 = PairKeyConfirm {
        key_confirm_a: key_confirm(b"receiver", &session_key),
    };
    send_message(&mut send, &m3).await?;

    crate::emit_event(json!({ "type": "pairing_handshake_succeeded" }));

    // ---- M4: receive TransferOffer ----
    let offer: TransferOffer = recv_sealed(&mut recv, &session_key, b"s2r", 0).await?;
    crate::emit_event(json!({
        "type": "pairing_offer_received",
        "name": offer.name,
        "size": offer.size,
        "is_folder": offer.is_folder,
        "file_count": offer.file_count,
    }));

    // ---- M5: send TransferAccept ----
    let label = std::env::var("ORBITXFER_RECEIVER_LABEL").ok();
    let label = label
        .as_deref()
        .map(|s| {
            s.trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect::<String>()
        })
        .filter(|s| !s.is_empty());
    let accept = TransferAccept {
        receiver_label: label,
    };
    send_sealed(&mut send, &session_key, b"r2s", 0, &accept).await?;

    crate::emit_event(json!({
        "type": "pairing_session_ready",
        "output_path": output_path.to_string_lossy(),
    }));

    // Phase 1 stops here. Phase 2 will continue with the actual blob
    // download using `offer.hash`, `offer.format`, etc., dialing the
    // same sender NodeID on iroh_blobs::ALPN.

    drop(conn);
    Ok(())
}

// ----------------------------------------------------------------
// Unit tests
// ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_code_validates() {
        for _ in 0..100 {
            let code = generate_code();
            assert!(
                validate_code(&code).is_ok(),
                "generated code did not validate: {}",
                code
            );
            assert_eq!(code.split(CODE_SEPARATOR).count(), CODE_WORDS);
        }
    }

    #[test]
    fn validate_rejects_wrong_count() {
        assert!(validate_code("foo-bar-baz").is_err());
        assert!(validate_code("foo-bar-baz-qux-quux").is_err());
    }

    #[test]
    fn validate_rejects_unknown_word() {
        assert!(validate_code("zzz-zzz-zzz-zzz").is_err());
    }

    #[test]
    fn normalize_idempotent() {
        let code = generate_code();
        assert_eq!(
            normalize_code(&code),
            normalize_code(&normalize_code(&code))
        );
    }

    #[test]
    fn normalize_handles_whitespace_and_case() {
        let raw = "Violet- Puzzle - River-Cathedral";
        let normalized = normalize_code(raw);
        assert_eq!(normalized, "violet-puzzle-river-cathedral");
    }

    #[test]
    fn derive_same_secret_for_same_code() {
        let code = generate_code();
        let k1 = derive_ephemeral_secret_key(&code);
        let k2 = derive_ephemeral_secret_key(&code);
        assert_eq!(k1.to_bytes(), k2.to_bytes());
    }

    #[test]
    fn derive_different_secret_for_different_code() {
        let c1 = generate_code();
        let c2 = generate_code();
        if c1 == c2 {
            return; // collision; vanishingly rare
        }
        let k1 = derive_ephemeral_secret_key(&c1);
        let k2 = derive_ephemeral_secret_key(&c2);
        assert_ne!(k1.to_bytes(), k2.to_bytes());
    }

    #[test]
    fn key_confirm_distinguishes_roles() {
        let k = [42u8; 32];
        let a = key_confirm(b"sender", &k);
        let b = key_confirm(b"receiver", &k);
        assert_ne!(a, b);
    }

    /// End-to-end CPace round-trip: receiver does step1+step3, sender
    /// does step2, both arrive at the same session key without ever
    /// transmitting the password.
    #[test]
    fn cpace_roundtrip_with_argon2_password() {
        // Skip by default — Argon2id @ 64 MiB × 3 iters is slow.
        if std::env::var("ORBITXFER_PAIR_SLOW_TESTS").is_err() {
            return;
        }
        let code = "violet-puzzle-river-cathedral";
        let nonce_r = [7u8; 16];
        let password = argon2_password(code, &nonce_r).unwrap();

        let s1 = CPace::step1(&password, CPACE_ID_A, CPACE_ID_B, Some(CPACE_AD)).unwrap();
        let packet1 = s1.packet();
        let s2 = CPace::step2(&packet1, &password, CPACE_ID_A, CPACE_ID_B, Some(CPACE_AD))
            .unwrap();
        let packet2 = s2.packet();
        let receiver_keys = s1.step3(&packet2).unwrap();
        let sender_keys = s2.shared_keys();
        assert_eq!(receiver_keys.k1, sender_keys.k1);
        assert_eq!(receiver_keys.k2, sender_keys.k2);
    }
}
