// v0.1.85/90 — chat ALPN module. Holds the orbitxfer/chat/1 protocol:
// the bidirectional ChatCoordinator (v0.1.90), ChatMessage,
// run_chat_session, and the stdin command parser shared by run_send
// and run_receive.
mod chat;

use anyhow::{anyhow, bail, Context, Result};
use fs2::available_space;
use futures_lite::StreamExt;
use irpc::channel::mpsc;
use iroh::{
    address_lookup::MemoryLookup,
    endpoint::Connection,
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, EndpointAddr,
};
use iroh_base::SecretKey;
use iroh_blobs::{
    api::blobs::{
        AddPathOptions, AddProgressItem, ExportMode, ExportOptions, ExportProgressItem, ImportMode,
    },
    api::downloader::DownloadProgressItem,
    api::remote::GetProgressItem,
    api::TempTag,
    format::collection::Collection,
    provider::events::{AbortReason, EventMask, EventSender, ProviderMessage, RequestUpdate},
    store::fs::FsStore,
    ticket::BlobTicket,
    BlobFormat,
    BlobsProtocol,
    Hash,
};
use iroh_blobs::protocol::ObserveRequest;
use serde_json::json;
use getrandom::getrandom;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::time::{sleep, timeout, Duration};

const CLI_VERSION: &str = "0.1.93";

/// ALPN for the optional "receiver label" side-channel. A receiver may
/// open a short connection to the sender on this protocol and send a
/// free-text nickname so the sender can see who's downloading. This is
/// entirely separate from the iroh-blobs transfer ALPN; an older sender
/// that doesn't register it just refuses the connection and the receiver
/// proceeds with the download anyway.
const ORBITXFER_LABEL_ALPN: &[u8] = b"orbitxfer/label/0";

// v0.1.86 — Receive-side retry strategy (Option A).
//
// PHASE 1 = the existing fast 3-attempt download loop, catches
// transient network blips. After it fails, we enter PHASE 2:
// slow polling with exponential backoff, designed to handle the
// common "sender clicked Stop and is about to click Resume" case
// where a human-paced delay (seconds to several minutes) separates
// the disconnect from the reconnect.
// v0.1.92 — snappier reconnect. The backoff still ramps gradually, but
// starts and caps much lower so a returning sender is picked up in a
// few seconds, not tens of seconds.
const PHASE2_INITIAL_BACKOFF_SECS: u64 = 3;
const PHASE2_MAX_BACKOFF_SECS: u64 = 20;
const PHASE2_BUDGET_SECS: u64 = 300; // 5 minutes
const PHASE2_BACKOFF_MULTIPLIER: u32 = 2;

/// Clamp an attacker-controlled label to something safe to display: drop
/// control characters, trim, cap at 64 chars.
fn sanitize_label_text(s: &str) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    cleaned.trim().chars().take(64).collect()
}

/// Sender-side handler for the receiver-label side-channel. Reads one
/// short message (the receiver's self-chosen nickname) off a uni stream,
/// correlates it to the receiver's authenticated NodeID, and emits a
/// `receiver_label` event the UI can match to a download row.
#[derive(Debug, Clone)]
struct LabelProtocol;

impl ProtocolHandler for LabelProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        // The NodeID is cryptographically authenticated by iroh/QUIC, so
        // a peer can only set its OWN label, not impersonate another's.
        let endpoint_id = connection.remote_id();
        let mut recv = connection
            .accept_uni()
            .await
            .map_err(AcceptError::from_err)?;
        // Cap the read so a malicious peer can't stream forever.
        let bytes = recv
            .read_to_end(256)
            .await
            .map_err(AcceptError::from_err)?;
        let label = sanitize_label_text(&String::from_utf8_lossy(&bytes));
        if !label.is_empty() {
            emit_event(json!({
                "type": "receiver_label",
                "endpoint_id": endpoint_id.to_string(),
                "label": label
            }));
        }
        // Close from our side so the receiver's `closed()` await returns.
        connection.close(0u32.into(), b"ok");
        Ok(())
    }
}

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  orbitxfer-iroh-cli send <path-to-file>");
    eprintln!("  orbitxfer-iroh-cli receive <ticket> <output-path>");
}

fn abs_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn store_root() -> Result<PathBuf> {
    if let Ok(dir) = env::var("ORBITXFER_STORE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Ok(home) = env::var("HOME") {
        return Ok(PathBuf::from(home).join(".orbitxfer-store"));
    }
    if let Ok(profile) = env::var("USERPROFILE") {
        return Ok(PathBuf::from(profile).join(".orbitxfer-store"));
    }
    Ok(env::current_dir()?.join(".orbitxfer-store"))
}

/// Resolve a per-file identity key path. When `ORBITXFER_PER_FILE_IDENTITY_DIR`
/// is set, every file (keyed by its BLAKE3 content hash) gets its own
/// identity key at `<dir>/<hash>.key`. Same file content → same identity
/// → same share ticket on every send. Different file content → different
/// identity, no cross-linking.
///
/// Returns None when the env var isn't set, in which case the caller
/// should fall back to `resolve_identity_key_path()` (legacy single-key
/// flow) or finally to an ephemeral identity.
fn per_file_identity_key_path(hash_str: &str) -> Option<PathBuf> {
    if let Ok(dir) = env::var("ORBITXFER_PER_FILE_IDENTITY_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join(format!("{hash_str}.key")));
        }
    }
    None
}

fn resolve_identity_key_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("ORBITXFER_KEY_PATH") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    if env::var("ORBITXFER_RESUME").ok().as_deref() == Some("1") {
        if let Ok(root) = store_root() {
            return Some(root.join("identity.key"));
        }
    }
    None
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn hex_to_bytes(s: &str) -> Result<[u8; 32]> {
    let cleaned = s.trim();
    if cleaned.len() != 64 {
        bail!("invalid secret key length");
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let idx = i * 2;
        let byte = u8::from_str_radix(&cleaned[idx..idx + 2], 16)
            .context("invalid secret key hex")?;
        out[i] = byte;
    }
    Ok(out)
}

fn load_or_create_secret_key(path: &Path) -> Result<SecretKey> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.exists() {
        let contents = fs::read_to_string(path)?;
        let bytes = hex_to_bytes(&contents)?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes).map_err(|e| anyhow!("failed to generate identity key: {e}"))?;
    let key = SecretKey::from_bytes(&bytes);
    let hex = bytes_to_hex(&key.to_bytes());
    fs::write(path, hex)?;
    Ok(key)
}


fn store_root_for_receive(output_path: &Path) -> Result<(PathBuf, bool)> {
    if let Ok(dir) = env::var("ORBITXFER_STORE_DIR") {
        return Ok((PathBuf::from(dir), false));
    }
    let base_dir = if output_path.is_dir() {
        output_path.to_path_buf()
    } else {
        output_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(env::current_dir()?)
    };
    std::fs::create_dir_all(&base_dir)?;
    let output_name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let store_dir = base_dir.join(format!("{output_name}.orbitxfer-pieces"));
    Ok((store_dir, true))
}

/// v0.1.85 — recursively sum the size of every file under
/// `store_dir`. Used at the start of `run_receive` to compute a
/// resume baseline: how many bytes are already cached locally from a
/// previous interrupted receive.
///
/// This is an over-estimate (includes blobs.db's bookkeeping
/// overhead and per-blob outboard/sizes metadata), but the overhead
/// is single-digit MB even for multi-GB transfers, so the bar's
/// accuracy is within a fraction of a percent — much better than
/// always-from-zero.
fn estimate_cached_bytes(store_dir: &Path) -> u64 {
    fn walk(p: &Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(p) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&entry.path(), total);
            } else if meta.is_file() {
                *total = total.saturating_add(meta.len());
            }
        }
    }
    let mut total: u64 = 0;
    walk(store_dir, &mut total);
    total
}

fn import_mode_from_env() -> ImportMode {
    match env::var("ORBITXFER_IMPORT_MODE") {
        Ok(val) if val.eq_ignore_ascii_case("copy") => ImportMode::Copy,
        Ok(val) if val.eq_ignore_ascii_case("try_reference") => ImportMode::TryReference,
        _ => ImportMode::TryReference,
    }
}

fn expected_size_from_env() -> Option<u64> {
    env::var("ORBITXFER_EXPECTED_SIZE")
        .ok()
        .and_then(|val| val.parse::<u64>().ok())
}

fn ticket_mode_from_env() -> String {
    if let Ok(mode) = env::var("ORBITXFER_TICKET_MODE") {
        if !mode.is_empty() {
            return mode;
        }
    }
    if env::var("ORBITXFER_RESUME").ok().as_deref() == Some("1") {
        return "relay_only".to_string();
    }
    "full".to_string()
}

/// Rate-limits progress event emission so a fast transfer (or a download
/// at multi-Gbit speeds) doesn't drown the parent's stdin reader and the
/// UI thread in events. Emits when either 4 MB has accumulated OR 500 ms
/// has elapsed since the last emit, whichever comes first.
///
/// The send-side hashing/upload loops already use this same pattern
/// inline. This struct factors it out so the receive-side download and
/// export loops can apply identical throttling without copy-pasting.
/// Without it, a 26 GB receive at ~350 MB/s on loopback freezes the
/// webview because iroh's progress stream emits thousands of events
/// per second.
struct ProgressThrottle {
    last_emit_bytes: u64,
    last_emit_at: Instant,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit_bytes: 0,
            last_emit_at: Instant::now(),
        }
    }

    fn should_emit(&mut self, bytes: u64) -> bool {
        const STEP_BYTES: u64 = 4 * 1024 * 1024;
        const STEP_TIME: Duration = Duration::from_millis(500);
        let by_bytes = bytes.saturating_sub(self.last_emit_bytes) >= STEP_BYTES;
        let by_time = self.last_emit_at.elapsed() >= STEP_TIME;
        if by_bytes || by_time {
            self.last_emit_bytes = bytes;
            self.last_emit_at = Instant::now();
            true
        } else {
            false
        }
    }
}

fn emit_line(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn emit_event(event: serde_json::Value) {
    emit_line(&format!("OX_EVENT {}", event.to_string()));
}

fn emit_error(stage: &str, err: impl std::fmt::Display) {
    emit_event(json!({
        "type": "error",
        "stage": stage,
        "message": err.to_string()
    }));
}

fn describe_addr(addr: &EndpointAddr) -> String {
    let relays: Vec<String> = addr.relay_urls().map(|u| u.to_string()).collect();
    let ips: Vec<String> = addr.ip_addrs().map(|ip| ip.to_string()).collect();
    format!("relay=[{}] ip=[{}]", relays.join(", "), ips.join(", "))
}

fn format_bytes(bytes: u64) -> String {
    // Decimal (SI) units, base 1000 — matches the GUI's formatBytes() and
    // Finder/Explorer's reported file sizes. Pre-v0.1.82 used base 1024
    // (technically KiB/MiB/...) which read ~7% smaller than the OS's
    // reported size for the same file.
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut idx = 0usize;
    while value >= 1000.0 && idx < UNITS.len() - 1 {
        value /= 1000.0;
        idx += 1;
    }
    if idx == 0 {
        format!("{bytes} B")
    } else if value >= 10.0 {
        format!("{value:.0} {}", UNITS[idx])
    } else {
        format!("{value:.1} {}", UNITS[idx])
    }
}

// v0.1.85 — the original watch_parent_via_stdin (a thread that
// read-then-discarded stdin to detect parent-death) is replaced by
// `chat::spawn_stdin_command_reader`, which preserves the EOF→exit
// behavior AND parses OX_CMD lines into CliCommands. The
// subcommands take the receiver end of the command channel.

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn estimate_cached_bytes_empty_dir() {
        let tmp = tempdir_path();
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(estimate_cached_bytes(&tmp), 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn estimate_cached_bytes_nonexistent_dir() {
        let tmp = tempdir_path().join("does-not-exist");
        assert_eq!(estimate_cached_bytes(&tmp), 0);
    }

    #[test]
    fn estimate_cached_bytes_sums_top_level_files() {
        let tmp = tempdir_path();
        std::fs::create_dir_all(&tmp).unwrap();
        let mut f1 = std::fs::File::create(tmp.join("a.dat")).unwrap();
        f1.write_all(&vec![0u8; 1024]).unwrap();
        let mut f2 = std::fs::File::create(tmp.join("b.dat")).unwrap();
        f2.write_all(&vec![0u8; 2048]).unwrap();
        assert_eq!(estimate_cached_bytes(&tmp), 3072);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn estimate_cached_bytes_recurses_into_subdirs() {
        let tmp = tempdir_path();
        std::fs::create_dir_all(tmp.join("data")).unwrap();
        let mut f1 = std::fs::File::create(tmp.join("blobs.db")).unwrap();
        f1.write_all(&vec![0u8; 100]).unwrap();
        let mut f2 = std::fs::File::create(tmp.join("data").join("blob1.obao4"))
            .unwrap();
        f2.write_all(&vec![0u8; 4096]).unwrap();
        let mut f3 = std::fs::File::create(tmp.join("data").join("blob1.sizes4"))
            .unwrap();
        f3.write_all(&vec![0u8; 64]).unwrap();
        assert_eq!(estimate_cached_bytes(&tmp), 100 + 4096 + 64);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn tempdir_path() -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("orbitxfer-test-{}", nanos))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Stdin command bus: parent → sidecar control commands. The
    // sender half is owned by the stdin reader task; the receiver
    // half is moved into whichever subcommand runs below.
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<chat::CliCommand>();
    chat::spawn_stdin_command_reader(cmd_tx);

    let mut args = env::args().skip(1);
    let cmd = args.next().unwrap_or_default();

    match cmd.as_str() {
        "send" => {
            emit_line(&format!("OrbitXfer CLI {} (send)", CLI_VERSION));
            let file = args.next().context("missing file path")?;
            if args.next().is_some() {
                bail!("send takes exactly one argument");
            }
            run_send(PathBuf::from(file), cmd_rx).await?;
        }
        "receive" => {
            emit_line(&format!("OrbitXfer CLI {} (receive)", CLI_VERSION));
            let ticket = args.next().context("missing ticket")?;
            let output = args.next().context("missing output path")?;
            if args.next().is_some() {
                bail!("receive takes exactly two arguments");
            }
            run_receive(ticket, PathBuf::from(output), cmd_rx).await?;
        }
        _ => {
            print_usage();
        }
    }

    Ok(())
}

/// v0.1.88 (#5) — Resume fast path. If `ORBITXFER_REUSE_TICKET` is set
/// (the GUI sets it on Resume Last Send) and the persistent store
/// still holds that blob, return a protected handle to it so the
/// caller can skip re-hashing the source file.
///
/// Limited to single Raw blobs in v0.1.88: for a HashSeq folder,
/// `has(root)` only confirms the root metadata blob is present, not
/// every child, so we'd risk serving an incomplete collection.
/// Folders fall through to the normal re-hash path.
///
/// Returns None (→ caller re-hashes) when: the env var is unset, the
/// ticket doesn't parse, the format isn't Raw, the blob isn't in the
/// store (GC'd, app restarted, or a different window), or the temp
/// tag can't be created.
async fn try_reuse_cached_blob(
    store: &FsStore,
) -> Option<(Hash, BlobFormat, Option<u64>, Vec<TempTag>)> {
    let ticket_str = env::var("ORBITXFER_REUSE_TICKET").ok()?;
    let ticket: BlobTicket = ticket_str.parse().ok()?;
    let hf = ticket.hash_and_format();
    if !matches!(hf.format, BlobFormat::Raw) {
        return None;
    }
    // Is the blob still complete in the persistent store?
    match store.blobs().has(hf.hash).await {
        Ok(true) => {}
        _ => return None,
    }
    // Protect it with a fresh temp tag (the previous session's tag
    // dropped when its sidecar exited; GC may not have run yet, but
    // we re-protect to be safe for the new serving session). The
    // tags() temp_tag is GLOBAL-scoped — it lives until dropped,
    // which is exactly the lifetime we want (_keep_tags held until
    // run_send returns).
    let tag = store.tags().temp_tag(hf).await.ok()?;
    let size = env::var("ORBITXFER_REUSE_SIZE")
        .ok()
        .and_then(|s| s.parse::<u64>().ok());
    Some((hf.hash, hf.format, size, vec![tag]))
}

/// Add a single file to the store as one Raw blob (the original send
/// behavior). Emits the `ticket_hashing_*` progress events and returns the
/// blob's hash, format, total size, and the (leaked) temp tag.
async fn prepare_single_file(
    store: &FsStore,
    abs_path: &Path,
) -> Result<(Hash, BlobFormat, Option<u64>, Vec<TempTag>)> {
    let add_opts = AddPathOptions {
        path: abs_path.to_path_buf(),
        format: BlobFormat::Raw,
        mode: import_mode_from_env(),
    };

    let mut total_size: Option<u64> = std::fs::metadata(abs_path).map(|m| m.len()).ok();
    if let Some(size) = total_size {
        emit_event(json!({ "type": "ticket_hashing_size", "total": size }));
    }
    let mut stream = store.blobs().add_path_with_opts(add_opts).stream().await;
    let mut temp_tag = None;
    let mut last_emit_bytes = 0u64;
    let mut last_emit_at = Instant::now();
    let progress_step_bytes = 4 * 1024 * 1024;
    let progress_step_time = Duration::from_millis(500);
    while let Some(item) = stream.next().await {
        match item {
            AddProgressItem::Size(size) => {
                total_size = Some(size);
                emit_event(json!({ "type": "ticket_hashing_size", "total": size }));
                last_emit_bytes = 0;
                last_emit_at = Instant::now();
            }
            AddProgressItem::CopyProgress(bytes) => {
                let should_emit = bytes.saturating_sub(last_emit_bytes) >= progress_step_bytes
                    || last_emit_at.elapsed() >= progress_step_time;
                if should_emit {
                    last_emit_bytes = bytes;
                    last_emit_at = Instant::now();
                    emit_event(json!({
                        "type": "ticket_hashing_progress",
                        "phase": "copy",
                        "bytes": bytes,
                        "total": total_size
                    }));
                }
            }
            AddProgressItem::OutboardProgress(bytes) => {
                let should_emit = bytes.saturating_sub(last_emit_bytes) >= progress_step_bytes
                    || last_emit_at.elapsed() >= progress_step_time;
                if should_emit {
                    last_emit_bytes = bytes;
                    last_emit_at = Instant::now();
                    emit_event(json!({
                        "type": "ticket_hashing_progress",
                        "phase": "hash",
                        "bytes": bytes,
                        "total": total_size
                    }));
                }
            }
            AddProgressItem::CopyDone => {
                emit_event(json!({ "type": "ticket_hashing_phase", "phase": "hash" }));
            }
            AddProgressItem::Done(tt) => {
                temp_tag = Some(tt);
                emit_event(json!({ "type": "ticket_hashing_complete", "total": total_size }));
                break;
            }
            AddProgressItem::Error(e) => {
                emit_error("hashing", &e);
                return Err(e.into());
            }
        }
    }

    let mut temp_tag = temp_tag.ok_or_else(|| anyhow!("hashing stream ended unexpectedly"))?;
    temp_tag.leak();
    let hf = temp_tag.hash_and_format();
    Ok((hf.hash, hf.format, total_size, vec![temp_tag]))
}

/// Recursively collect every regular file under `root`, recording each as
/// `(name, absolute_path)` where `name` is the path relative to `base`
/// using forward slashes. Symlinks are skipped (MVP) to avoid cycles and
/// to keep a folder's contents from escaping its own tree.
fn collect_files(root: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            collect_files(&path, base, out)?;
        } else if ft.is_file() {
            let rel = path.strip_prefix(base).unwrap_or(&path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !rel_str.is_empty() {
                out.push((rel_str, path.clone()));
            }
        }
    }
    Ok(())
}

/// Add every file under a directory as its own Raw blob, then bundle them
/// into a HashSeq collection. Names are relative to the selected folder
/// (e.g. `a.txt`, `sub/b.txt`) — the top folder name is NOT included, so
/// the receiver extracts entries directly under the destination folder it
/// chose. Returns the collection root hash (HashSeq format), the summed
/// total size, and all temp tags (child blobs + root) to keep alive.
async fn prepare_folder(
    store: &FsStore,
    abs_path: &Path,
) -> Result<(Hash, BlobFormat, Option<u64>, Vec<TempTag>)> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(abs_path, abs_path, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    if files.is_empty() {
        bail!("the selected folder contains no files to send");
    }

    let total: u64 = files
        .iter()
        .map(|(_, p)| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .sum();
    let total_size = Some(total);
    let file_count = files.len();
    emit_event(json!({
        "type": "ticket_hashing_size",
        "total": total,
        "files": file_count
    }));

    let import_mode = import_mode_from_env();
    let mut collection = Collection::default();
    let mut tags: Vec<TempTag> = Vec::with_capacity(file_count + 1);
    let mut hashed_bytes: u64 = 0;
    let mut last_emit_bytes = 0u64;
    let mut last_emit_at = Instant::now();
    let progress_step_bytes = 4 * 1024 * 1024;
    let progress_step_time = Duration::from_millis(500);

    for (name, path) in &files {
        let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let add_opts = AddPathOptions {
            path: path.clone(),
            format: BlobFormat::Raw,
            mode: import_mode,
        };
        let mut stream = store.blobs().add_path_with_opts(add_opts).stream().await;
        let file_base = hashed_bytes;
        let mut tag = None;
        while let Some(item) = stream.next().await {
            match item {
                AddProgressItem::OutboardProgress(bytes) => {
                    // Aggregate hashing progress across the whole folder:
                    // bytes already hashed + this file's in-progress bytes.
                    let cum = file_base + bytes.min(file_size);
                    let should_emit = cum.saturating_sub(last_emit_bytes) >= progress_step_bytes
                        || last_emit_at.elapsed() >= progress_step_time;
                    if should_emit {
                        last_emit_bytes = cum;
                        last_emit_at = Instant::now();
                        emit_event(json!({
                            "type": "ticket_hashing_progress",
                            "phase": "hash",
                            "bytes": cum,
                            "total": total_size
                        }));
                    }
                }
                AddProgressItem::Done(tt) => {
                    tag = Some(tt);
                    break;
                }
                AddProgressItem::Error(e) => {
                    emit_error("hashing", &e);
                    return Err(e.into());
                }
                _ => {}
            }
        }
        let tag = tag.ok_or_else(|| anyhow!("hashing stream ended unexpectedly for {name}"))?;
        collection.push(name.clone(), tag.hash());
        tags.push(tag);
        hashed_bytes = file_base + file_size;
    }

    let root_tag = collection
        .store(store.as_ref())
        .await
        .map_err(|e| anyhow!("failed to store collection: {e}"))?;
    let hf = root_tag.hash_and_format();
    tags.push(root_tag);
    emit_event(json!({
        "type": "ticket_hashing_complete",
        "total": total_size,
        "files": file_count
    }));
    Ok((hf.hash, hf.format, total_size, tags))
}

/// v0.1.88 — Telemetry (#7). Classify a receive-side failure into a
/// short machine code + a human-readable explanation, so the GUI can
/// tell the user WHY a download is stuck retrying rather than just
/// "failed". Best-effort string matching against the underlying
/// iroh/quinn/DNS error text — imperfect, but covers the common cases
/// we've seen in testing. Returns (code, human_message).
fn categorize_receive_failure(err_text: &str) -> (&'static str, String) {
    let lower = err_text.to_ascii_lowercase();
    if lower.contains("no addressing information")
        || lower.contains("failed to resolve")
        || lower.contains("dns")
        || lower.contains("no calls succeeded")
    {
        (
            "sender_offline",
            "The sender appears to be offline — we can't find any way to \
             reach them right now. This usually means their Send window \
             was closed or their computer went to sleep. We'll keep \
             trying in case they come back."
                .to_string(),
        )
    } else if lower.contains("timed out") || lower.contains("timeout") {
        (
            "timeout",
            "The connection to the sender timed out. They may have a slow \
             or interrupted network. Retrying."
                .to_string(),
        )
    } else if lower.contains("refused") || lower.contains("reset") {
        (
            "refused",
            "The sender's computer is reachable but refused the connection \
             — their Send may have just stopped. Retrying in case it \
             resumes."
                .to_string(),
        )
    } else if lower.contains("connection lost") || lower.contains("closed") {
        (
            "connection_lost",
            "The connection to the sender dropped mid-transfer. Retrying."
                .to_string(),
        )
    } else {
        (
            "unknown",
            format!("The transfer hit a snag and is retrying. ({err_text})"),
        )
    }
}


/// Convert a collection entry name into a SAFE relative path under the
/// destination directory. Rejects absolute paths and any `..` component to
/// prevent a malicious sender from writing outside the chosen folder
/// (zip-slip style). Returns None if the name has no safe components.
fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in name.split(['/', '\\']) {
        match comp {
            "" | "." => continue,
            ".." => return None,
            _ => out.push(comp),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

async fn run_send(
    file_path: PathBuf,
    cmd_rx: tokio::sync::mpsc::UnboundedReceiver<chat::CliCommand>,
) -> Result<()> {
    let abs_path = abs_path(&file_path)?;

    let store_dir = store_root()?;
    std::fs::create_dir_all(&store_dir)?;
    let store = FsStore::load(store_dir.clone()).await?;
    let store_handle = store.as_ref().clone();
    // v0.1.91 — enable throttle INTERCEPT so Stop Send can abort an
    // in-flight serve. ALL_READONLY already sets throttle: Intercept;
    // v0.1.90 overrode it to None, which is why Stop Send couldn't
    // actually halt the transfer (it only unpinned the blob). The
    // throttle handler below checks `abort_serving` on each progress
    // tick and returns an abort when the user has stopped — tearing
    // down the blob request while the chat ALPN (a separate request
    // stream on the same endpoint) keeps running.
    let event_mask = EventMask::ALL_READONLY;
    let (events_tx, mut events_rx) = EventSender::channel(32, event_mask);
    let blobs = BlobsProtocol::new(&store, Some(events_tx));
    // Set true by Stop Send; read by the Throttle handler to abort the
    // in-flight blob serve.
    let abort_serving = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // v0.1.88 (#5) — Resume fast path. On "Resume Last Send", the GUI
    // passes the previous session's ticket via ORBITXFER_REUSE_TICKET.
    // If the persistent per-window store still has that blob, we
    // protect it with a fresh temp tag and skip re-hashing the file
    // entirely — which for a multi-GB file turns a multi-second
    // re-hash into an instant resume. This is also MORE correct for
    // resume: serving the cached hash preserves the receiver's
    // partial data and their original ticket. (v0.1.88 limits this
    // to single Raw blobs; folders still re-hash, with messaging.)
    let reuse = try_reuse_cached_blob(&store).await;

    // v0.1.90 — `keep_tags` is now mutable: Stop Send clears it to
    // release the temp tags (unpinning the served content) while the
    // process stays alive for chat.
    let (hash, format, total_size, mut keep_tags): (Hash, BlobFormat, Option<u64>, Vec<TempTag>) =
        if let Some(reused) = reuse {
            emit_line("Reusing cached file from a previous send (instant resume).");
            emit_event(json!({
                "type": "ticket_reused",
                "hash": reused.0.to_string(),
                "total": reused.2,
            }));
            reused
        } else {
            // Normal path: hash the file/folder into the store.
            if abs_path.is_dir() {
                emit_line("Verifying folder contents (this can take a while).");
            } else {
                emit_line("Hashing file (this can take a while for large files).");
            }
            emit_event(json!({ "type": "ticket_hashing_start" }));
            if abs_path.is_dir() {
                prepare_folder(&store, &abs_path).await?
            } else {
                prepare_single_file(&store, &abs_path).await?
            }
        };

    // Warmup/sanity check only applies to a single Raw blob. For a HashSeq
    // collection the root is a tiny metadata blob and export_chunk semantics
    // differ, so we skip it.
    if matches!(format, BlobFormat::Raw) {
        let status = store.blobs().status(hash).await?;
        if let Err(err) = store.blobs().export_chunk(hash, 0).await {
            emit_error("store_warmup", &err);
            return Err(err.into());
        }
        emit_event(json!({
            "type": "store_warmup_ok",
            "hash": hash.to_string()
        }));

        emit_event(json!({
            "type": "store_status",
            "hash": hash.to_string(),
            "status": format!("{:?}", status)
        }));
    }

    emit_line("Binding endpoint...");
    // Identity resolution priority:
    //   1. Per-file identity (ORBITXFER_PER_FILE_IDENTITY_DIR + hash.key) —
    //      same file = same identity = same ticket. Different file =
    //      different identity, no cross-linking. This is the Tauri app's
    //      default in v0.1.61+.
    //   2. Legacy single-key persistent identity (ORBITXFER_KEY_PATH or
    //      ORBITXFER_RESUME) — preserved for backward compatibility.
    //   3. Fully ephemeral — fresh identity every invocation (original
    //      standalone-CLI default).
    let identity_path =
        per_file_identity_key_path(&hash.to_string()).or_else(resolve_identity_key_path);
    let endpoint = if let Some(path) = identity_path {
        let key = load_or_create_secret_key(&path)?;
        emit_line(&format!("Using identity key: {}", path.display()));
        let bind = timeout(Duration::from_secs(15), Endpoint::builder().secret_key(key).bind())
            .await
            .context("endpoint bind timed out")??;
        bind
    } else {
        let bind = timeout(Duration::from_secs(15), Endpoint::bind())
            .await
            .context("endpoint bind timed out")??;
        bind
    };
    emit_line("Endpoint bound.");

    let _ = endpoint.online().await;
    let full_addr = endpoint.addr();
    emit_line(&format!("Sender endpoint addr: {}", describe_addr(&full_addr)));

    let relay_ticket = full_addr
        .relay_urls()
        .next()
        .cloned()
        .map(|relay| {
            let relay_addr = EndpointAddr::new(full_addr.id).with_relay_url(relay);
            BlobTicket::new(relay_addr, hash, format).to_string()
        });
    let mut direct_addr = EndpointAddr::new(full_addr.id);
    for ip in full_addr.ip_addrs().cloned() {
        direct_addr = direct_addr.with_ip_addr(ip);
    }
    let direct_ticket = if direct_addr.ip_addrs().next().is_some() {
        Some(BlobTicket::new(direct_addr, hash, format).to_string())
    } else {
        None
    };
    let full_ticket = BlobTicket::new(full_addr.clone(), hash, format).to_string();
    // `total` is the canonical payload size from `std::fs::metadata().len()`
    // at the start of hashing. We surface it here so the frontend can
    // append `# size=<N>` to the share line — the receiver parses that to
    // seed its progress total immediately on paste, before the CLI is even
    // spawned. Without it the receiver UI doesn't know the denominator
    // until the provider's `observe()` round-trip lands, which on a relay
    // path can be several seconds in.
    emit_event(json!({
        "type": "ticket_variants",
        "direct": direct_ticket,
        "relay": relay_ticket,
        "full": full_ticket,
        "total": total_size
    }));

    let mode = ticket_mode_from_env();
    let addr = match mode.as_str() {
        "relay_only" => {
            if let Some(relay) = full_addr.relay_urls().next().cloned() {
                emit_line("Ticket mode: relay_only");
                EndpointAddr::new(full_addr.id).with_relay_url(relay)
            } else {
                emit_line("WARNING: No relay URL available. Falling back to full address.");
                full_addr.clone()
            }
        }
        "direct_only" => {
            emit_line("Ticket mode: direct_only");
            let mut direct = EndpointAddr::new(full_addr.id);
            for ip in full_addr.ip_addrs().cloned() {
                direct = direct.with_ip_addr(ip);
            }
            direct
        }
        _ => {
            emit_line("Ticket mode: full (relay + ip)");
            full_addr.clone()
        }
    };

    emit_line(&format!("Ticket addr: {}", describe_addr(&addr)));

    let ticket = BlobTicket::new(addr, hash, format);

    emit_event(json!({
        "type": "ticket_created",
        "ticket": ticket.to_string(),
        "total": total_size
    }));

    // Canonical total is set once from the file's metadata length (the same
    // value emitted via `ticket_variants.total` and embedded in the share
    // line as `# size=<N>`). We deliberately do NOT overwrite this from
    // `RequestUpdate::Started.size` later — both sides need the exact same
    // denominator for their percentages to stay visually aligned during the
    // transfer, and `started.size` is iroh's view of the blob (which can
    // differ by chunk-padding/encoding details in some formats). The
    // `upload_started` event still carries `started.size` so logs can show
    // the protocol-level view if it ever diverges.
    let upload_total = Arc::new(AtomicU64::new(total_size.unwrap_or(0)));
    let upload_total_events = upload_total.clone();
    let spawn_updates = |mut rx: mpsc::Receiver<RequestUpdate>,
                         total: Arc<AtomicU64>,
                         connection_id: u64| {
        tokio::spawn(async move {
            // For a HashSeq (folder) send, iroh's `Progress.end_offset`
            // is the byte offset within the CURRENT blob and resets to 0
            // every time a new child blob starts streaming. Without
            // aggregation the sender's UI bar would snap back to 0 each
            // time we move to the next file. We track the sum of
            // already-finished blobs in `completed_bytes` and emit
            // `bytes = completed_bytes + end_offset` so the bar climbs
            // monotonically across the whole folder. A single-file (Raw)
            // send collapses to the old behavior (one Started, end_offset
            // == file size, one Completed). Throttling (4 MB / 500 ms)
            // still gates the event rate — applied to the aggregate so
            // we don't drown the webview at multi-Gbit/s.
            let mut last_progress = 0u64;
            let mut completed_bytes = 0u64;
            let mut current_blob_size: Option<u64> = None;
            let mut throttle = ProgressThrottle::new();
            while let Ok(Some(update)) = rx.recv().await {
                match update {
                    RequestUpdate::Started(started) => {
                        // A new blob is beginning. The previous blob (if
                        // any) implicitly finished — its end_offset reached
                        // its size — so promote it into completed_bytes
                        // before starting fresh.
                        if let Some(prev) = current_blob_size.take() {
                            completed_bytes = completed_bytes.saturating_add(prev);
                        }
                        current_blob_size = Some(started.size);
                        emit_event(json!({
                            "type": "upload_started",
                            "connection_id": connection_id,
                            "total": total.load(Ordering::Relaxed),
                            "iroh_size": started.size,
                            "completed_bytes": completed_bytes
                        }));
                    }
                    RequestUpdate::Progress(progress) => {
                        let aggregate = completed_bytes
                            .saturating_add(progress.end_offset);
                        if aggregate == last_progress {
                            continue;
                        }
                        last_progress = aggregate;
                        if !throttle.should_emit(aggregate) {
                            continue;
                        }
                        let total_val = total.load(Ordering::Relaxed);
                        let total_opt = if total_val > 0 { Some(total_val) } else { None };
                        emit_event(json!({
                            "type": "upload_progress",
                            "connection_id": connection_id,
                            "bytes": aggregate,
                            "total": total_opt
                        }));
                    }
                    RequestUpdate::Completed(_) => {
                        // For a HashSeq send, iroh fires Completed PER child
                        // blob, not once per request — so this branch runs
                        // for the root, the meta, and every file blob. Each
                        // emit carries the running `completed_bytes` and
                        // the canonical `total`, so the frontend can tell
                        // an intermediate per-blob completion (`bytes` <
                        // `total`) from the true final one (`bytes` covers
                        // the whole payload). Without that distinction the
                        // sender would flash "Transfer Complete" the moment
                        // the tiny root blob finishes.
                        if let Some(prev) = current_blob_size.take() {
                            completed_bytes = completed_bytes.saturating_add(prev);
                        }
                        let total_val = total.load(Ordering::Relaxed);
                        let total_opt = if total_val > 0 { Some(total_val) } else { None };
                        emit_event(json!({
                            "type": "upload_complete",
                            "connection_id": connection_id,
                            "bytes": completed_bytes,
                            "total": total_opt
                        }));
                    }
                    RequestUpdate::Aborted(aborted) => {
                        emit_line(&format!("Upload aborted payload={} other_sent={} other_read={}", aborted.stats.payload_bytes_sent, aborted.stats.other_bytes_sent, aborted.stats.other_bytes_read));
                        emit_event(json!({
                            "type": "upload_aborted",
                            "payload_bytes_sent": aborted.stats.payload_bytes_sent,
                            "other_bytes_sent": aborted.stats.other_bytes_sent,
                            "other_bytes_read": aborted.stats.other_bytes_read
                        }));
                    }
                }
            }
        });
    };

    let abort_serving_events = abort_serving.clone();
    tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            match event {
                ProviderMessage::ClientConnected(msg) => {
                    let id_str = msg.endpoint_id.map(|id| id.to_string());
                    emit_line(&format!("Receiver connected {:?}", id_str));
                    emit_event(json!({
                        "type": "receiver_connected",
                        "connection_id": msg.connection_id,
                        "endpoint_id": id_str
                    }));
                    let _ = msg.tx.send(Ok(())).await;
                }
                ProviderMessage::GetRequestReceived(msg) => {
                    if let Ok(status) = store_handle.blobs().status(msg.request.hash).await {
                        emit_line(&format!("Provider GET hash {} status {:?}", msg.request.hash, status));
                        emit_event(json!({
                            "type": "provider_get_request",
                            "hash": msg.request.hash.to_string(),
                            "status": format!("{:?}", status)
                        }));
                    }
                    let connection_id = msg.connection_id;
                    let _ = msg.tx.send(Ok(())).await;
                    spawn_updates(msg.rx, upload_total_events.clone(), connection_id);
                }
                ProviderMessage::GetRequestReceivedNotify(msg) => {
                    let connection_id = msg.connection_id;
                    spawn_updates(msg.rx, upload_total_events.clone(), connection_id);
                }
                ProviderMessage::GetManyRequestReceived(msg) => {
                    emit_event(json!({
                        "type": "provider_get_many_request",
                        "count": msg.request.hashes.len()
                    }));
                    let connection_id = msg.connection_id;
                    let _ = msg.tx.send(Ok(())).await;
                    spawn_updates(msg.rx, upload_total_events.clone(), connection_id);
                }
                ProviderMessage::GetManyRequestReceivedNotify(msg) => {
                    let connection_id = msg.connection_id;
                    spawn_updates(msg.rx, upload_total_events.clone(), connection_id);
                }
                ProviderMessage::ConnectionClosed(msg) => {
                    emit_line("Receiver disconnected");
                    emit_event(json!({
                        "type": "receiver_disconnected",
                        "connection_id": msg.connection_id
                    }));
                }
                ProviderMessage::Throttle(msg) => {
                    // v0.1.91 — the abort hook. Returning an error here
                    // aborts the in-flight blob request (Stop Send),
                    // leaving chat untouched. Otherwise allow the chunk.
                    let resp = if abort_serving_events
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        Err(AbortReason::Permission)
                    } else {
                        Ok(())
                    };
                    let _ = msg.tx.send(resp).await;
                }
                _ => {}
            }
        }
    });

    // v0.1.85/90 — register the chat ALPN alongside the blob and label
    // ALPNs on the same router. The first receiver who dials chat wins;
    // a second concurrent dialer is rejected (one chat at a time).
    //
    // v0.1.90 — the sender uses the SAME ChatCoordinator as the
    // receiver. It serves inbound dials (accept path) AND can dial the
    // receiver back when the Send-side Reconnect Chat button is pressed
    // (spawn_manual_dialer), so chat is bidirectional. It also outlives
    // the transfer: Stop Send ends serving but keeps chat + process
    // alive.
    let sender_label = std::env::var("ORBITXFER_SENDER_LABEL")
        .ok()
        .map(|s| sanitize_label_text(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Sender".to_string());
    let chat = chat::ChatCoordinator::new(sender_label, endpoint.clone());
    let router = Router::builder(endpoint.clone())
        .accept(iroh_blobs::ALPN, blobs)
        .accept(ORBITXFER_LABEL_ALPN, LabelProtocol)
        .accept(chat::CHAT_ALPN, chat.clone())
        .spawn();
    chat.spawn_manual_dialer();

    emit_line("Hashing complete.");
    emit_line("File analyzed. Fetch this file by running:");
    emit_line(&format!(
        "orbitxfer-iroh-cli receive {ticket} {}",
        file_path.display()
    ));
    emit_line("Press Ctrl+C to stop serving.");

    // v0.1.85/90 — command-dispatch loop. The sender process now stays
    // alive while EITHER it is serving the file OR chat is live:
    //   - StopSend → stop serving (release the temp tags so the content
    //     is unpinned) but KEEP chat + process alive; exit only once
    //     chat is also done.
    //   - ChatStop (Stop Chat) → close chat for good; exit once serving
    //     is also stopped.
    //   - ReconnectChat → dial the receiver (Send-side reconnect).
    //   - ctrl-c → close chat and exit.
    //   - stdin EOF (window closed) → process::exit(0) in
    //     spawn_stdin_command_reader.
    let mut cmd_rx = cmd_rx;
    let mut serving_stopped = false;
    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(chat::CliCommand::ChatSend { body }) => {
                        if let Err(e) = chat.send_text(body).await {
                            emit_event(json!({
                                "type": "chat_send_failed",
                                "error": format!("{}", e),
                            }));
                        }
                    }
                    Some(chat::CliCommand::ChatStop) => {
                        let _ = chat.close().await;
                    }
                    Some(chat::CliCommand::StopSend) => {
                        // v0.1.90/91 — stop serving the file, but keep
                        // chat (and this process) alive.
                        if !serving_stopped {
                            serving_stopped = true;
                            // v0.1.91 — actually ABORT the in-flight
                            // serve: the throttle handler returns an
                            // abort on the next progress tick, tearing
                            // down the active blob request. Chat is a
                            // separate request stream and survives.
                            abort_serving
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            // Release the temp tags so the content is
                            // unpinned (no new receiver can fetch it).
                            keep_tags.clear();
                            emit_event(json!({ "type": "send_stopped" }));
                            emit_line("Send stopped by user; chat remains available.");
                        }
                    }
                    Some(chat::CliCommand::StopReceive) => {
                        // Not applicable to a send sidecar; ignore.
                    }
                    Some(chat::CliCommand::ReconnectChat) => {
                        // v0.1.90 — Send-side reconnect: dial the receiver.
                        chat.request_reconnect();
                    }
                    Some(chat::CliCommand::ResumeSend) => {
                        // v0.1.93 — warm resume in THIS process (no
                        // respawn). Clear the stop/abort flags and
                        // re-pin the cached blob so serving picks back
                        // up; the receiver's next retry succeeds.
                        if serving_stopped {
                            serving_stopped = false;
                            abort_serving
                                .store(false, std::sync::atomic::Ordering::SeqCst);
                            match store.tags().temp_tag(ticket.hash_and_format()).await {
                                Ok(tag) => keep_tags.push(tag),
                                Err(e) => emit_line(&format!(
                                    "resume re-pin warning: {e}"
                                )),
                            }
                            emit_event(json!({ "type": "send_resumed" }));
                            emit_line("Send resumed by user.");
                        }
                    }
                    Some(chat::CliCommand::ResumeReceive) => {
                        // Not applicable to a send sidecar; ignore.
                    }
                    None => {
                        // Command bus closed — fall through to shutdown.
                        break;
                    }
                }
            }
            // Chat lifecycle changed — re-evaluate the exit condition.
            _ = chat.wait_ended() => {}
            _ = tokio::signal::ctrl_c() => {
                let _ = chat.close().await;
                break;
            }
        }

        // Exit once serving has been stopped AND chat is no longer
        // keeping the process alive. (Before any StopSend we keep
        // serving indefinitely, as before.)
        if serving_stopped && !chat.should_linger() {
            break;
        }
    }

    emit_line("Shutting down.");
    // `keep_tags` drops here (if not already cleared by StopSend),
    // releasing the temp tags that kept the served blob(s) alive.
    // v0.1.90 — exit decisively (bounded router shutdown, then force
    // exit) so the blocking stdin reader can't keep the process alive
    // once both serving and chat are done.
    let _ = tokio::time::timeout(Duration::from_secs(2), router.shutdown()).await;
    std::process::exit(0);
}

/// Best-effort: fetch ONLY the collection's root + metadata blob (offset 0
/// = root HashSeq, child 0 = the names metadata) — not the file data — so
/// the receiver UI can show the folder's file list while the full download
/// is still running. Returns the loaded Collection. Any failure is
/// non-fatal; the caller logs and proceeds with the normal download (the
/// root+meta it fetched here are simply re-used, since the main download
/// only pulls what's still missing).
async fn prefetch_collection_files(
    store: &FsStore,
    conn: &Connection,
    root: Hash,
) -> Result<Collection> {
    let request = iroh_blobs::protocol::GetRequest::builder()
        .root(iroh_blobs::protocol::ChunkRanges::all())
        .child(0, iroh_blobs::protocol::ChunkRanges::all())
        .build(root);
    let mut stream = store.remote().execute_get(conn.clone(), request).stream();
    while let Some(item) = stream.next().await {
        match item {
            GetProgressItem::Done(_) => break,
            GetProgressItem::Error(e) => return Err(anyhow!(e)),
            GetProgressItem::Progress(_) => {}
        }
    }
    Collection::load(root, store.as_ref())
        .await
        .map_err(|e| anyhow!("load collection metadata: {e}"))
}

/// Export a HashSeq collection: load the collection metadata from the
/// store, then export each child blob to `dest_dir/<safe-relative-name>`,
/// creating parent directories as needed. Progress is aggregated across all
/// files so the receiver's "writing to disk" bar matches the canonical
/// total. Entry names are sanitized to prevent writing outside `dest_dir`.
async fn export_collection(
    store: &FsStore,
    root: Hash,
    dest_dir: &Path,
    total_size: Option<u64>,
) -> Result<()> {
    let collection = Collection::load(root, store.as_ref())
        .await
        .map_err(|e| anyhow!("failed to load collection: {e}"))?;
    let file_count = collection.len();
    emit_event(json!({
        "type": "export_started",
        "total": total_size,
        "files": file_count
    }));

    std::fs::create_dir_all(dest_dir)?;
    let mut exported: u64 = 0;
    let mut throttle = ProgressThrottle::new();
    for (idx, (name, child_hash)) in collection.iter().enumerate() {
        let Some(rel) = safe_relative_path(name) else {
            emit_line(&format!("Skipping unsafe entry name: {name}"));
            continue;
        };
        let target = dest_dir.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        emit_event(json!({
            "type": "export_file_start",
            "name": name,
            "index": idx + 1,
            "files": file_count
        }));
        let mut export_stream = store
            .blobs()
            .export_with_opts(ExportOptions {
                hash: *child_hash,
                mode: ExportMode::TryReference,
                target: target.clone(),
            })
            .stream()
            .await;
        let file_base = exported;
        while let Some(item) = export_stream.next().await {
            match item {
                ExportProgressItem::Size(_) => {}
                ExportProgressItem::CopyProgress(bytes) => {
                    let cum = file_base + bytes;
                    if throttle.should_emit(cum) {
                        emit_event(json!({
                            "type": "export_progress",
                            "bytes": cum,
                            "total": total_size
                        }));
                    }
                }
                ExportProgressItem::Done => break,
                ExportProgressItem::Error(err) => {
                    emit_error("export", &err);
                    return Err(err.into());
                }
            }
        }
        exported += std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
        emit_event(json!({
            "type": "export_file_done",
            "name": name,
            "index": idx + 1,
            "files": file_count
        }));
    }

    emit_event(json!({ "type": "export_complete", "total": Some(exported) }));
    Ok(())
}

/// Receiver-side: open a short connection to the provider on the label
/// ALPN and send our chosen nickname. Best-effort — the caller wraps this
/// in a timeout and ignores failures (e.g. an older provider that doesn't
/// speak this protocol).
async fn send_receiver_label(
    endpoint: &Endpoint,
    addr: EndpointAddr,
    label: &str,
) -> Result<()> {
    let conn = endpoint.connect(addr, ORBITXFER_LABEL_ALPN).await?;
    let mut send = conn.open_uni().await?;
    send.write_all(label.as_bytes()).await?;
    send.finish()?;
    // The provider reads the label, then closes the connection; waiting for
    // that close confirms delivery before we drop the connection.
    conn.closed().await;
    Ok(())
}

async fn run_receive(
    ticket_str: String,
    output_path: PathBuf,
    cmd_rx: tokio::sync::mpsc::UnboundedReceiver<chat::CliCommand>,
) -> Result<()> {
    let ticket: BlobTicket = ticket_str.parse().context("invalid ticket")?;
    let ticket_addr = ticket.addr().clone();
    emit_line(&format!("Ticket addr: {}", describe_addr(&ticket_addr)));
    // A HashSeq ticket is a folder (collection); a Raw ticket is a single
    // file. The format is authoritative — it lives inside the ticket — so we
    // don't rely on any UI hint to decide how to write to disk.
    let is_collection = matches!(ticket.hash_and_format().format, BlobFormat::HashSeq);
    let mut abs_path = abs_path(&output_path)?;
    if is_collection {
        // For a folder, abs_path is the destination directory the collection
        // entries are extracted into. Don't synth a filename.
        emit_line(&format!("Receiving a folder into: {}", abs_path.display()));
        emit_event(json!({ "type": "receive_kind", "kind": "folder" }));
    } else if abs_path.is_dir() {
        // Single file targeted at an existing directory → synth a name.
        let hash_str = ticket.hash().to_string();
        let short = hash_str.chars().take(12).collect::<String>();
        abs_path = abs_path.join(format!("orbitxfer-{short}.blob"));
    }

    let mut lookup_addrs = vec![ticket_addr.clone()];
    if let Some(relay) = ticket_addr.relay_urls().next().cloned() {
        let relay_only = EndpointAddr::new(ticket_addr.id).with_relay_url(relay);
        lookup_addrs.push(relay_only);
    }
    let mut direct = EndpointAddr::new(ticket_addr.id);
    for ip in ticket_addr.ip_addrs().cloned() {
        direct = direct.with_ip_addr(ip);
    }
    if direct.ip_addrs().next().is_some() {
        lookup_addrs.push(direct);
    }

    let lookup = MemoryLookup::from_endpoint_info(lookup_addrs);
    let endpoint = Endpoint::builder().address_lookup(lookup).bind().await?;
    emit_event(json!({ "type": "connect_start" }));
    endpoint.online().await;
    let receiver_addr = endpoint.addr();
    emit_line(&format!("Receiver endpoint addr: {}", describe_addr(&receiver_addr)));

    // Optional: volunteer a label to the sender so they can see who's
    // downloading. Opt-in — only sent when the user provided one. Best
    // effort: a short timeout and any failure is ignored so the download
    // proceeds regardless (e.g. older provider without the label ALPN).
    if let Ok(label_raw) = env::var("ORBITXFER_RECEIVER_LABEL") {
        let label = sanitize_label_text(&label_raw);
        if !label.is_empty() {
            match timeout(
                Duration::from_secs(8),
                send_receiver_label(&endpoint, ticket_addr.clone(), &label),
            )
            .await
            {
                Ok(Ok(())) => emit_line(&format!("Sent receiver label: {label}")),
                Ok(Err(e)) => emit_line(&format!("Could not send receiver label: {e}")),
                Err(_) => emit_line("Receiver label send timed out (provider may not support it)."),
            }
        }
    }

    let (store_dir, auto_store_cleanup) = store_root_for_receive(&abs_path)?;
    std::fs::create_dir_all(&store_dir)?;

    // v0.1.85 — Resume baseline. If the user stopped a previous
    // receive (Stop button, sidecar kill, etc.) the `.orbitxfer-
    // pieces/` store directory may already contain partial blob
    // data for this hash. iroh-blobs IS resuming at the store
    // level (we don't wipe the store between sessions), but the
    // download_progress events from the downloader stream report
    // ONLY this session's network bytes — they don't know about
    // the bytes already on disk. Result: the progress bar starts
    // at 0% even though a chunk of the file is already there.
    //
    // The fix: walk the store dir, sum the file sizes as a
    // baseline, emit it as a `download_resume_baseline` event,
    // and add it to every subsequent `download_progress.bytes`
    // value so the bar reflects cumulative completion.
    //
    // CRITICAL ordering: we walk BEFORE `FsStore::load`. The load
    // step reorganizes / compacts the on-disk format (partial
    // data moves into blobs.db's internal layout), and by the
    // time `load` returns the simple "sum directory file sizes"
    // estimate undercounts wildly — first attempt at this had
    // 597 MB on disk pre-load reporting as 1.1 MB after load.
    //
    // The walk is an over-estimate (includes blobs.db's
    // SQLite-style overhead + per-blob .obao4/.sizes4 metadata),
    // but the metadata overhead is single-digit MB for a multi-GB
    // transfer. Good enough to make the bar honest.
    let baseline_bytes = estimate_cached_bytes(&store_dir);
    if baseline_bytes > 0 {
        emit_line(&format!(
            "Resuming with {} already cached.",
            format_bytes(baseline_bytes)
        ));
        emit_event(json!({
            "type": "download_resume_baseline",
            "bytes": baseline_bytes,
        }));
    }

    let store = FsStore::load(store_dir.clone()).await?;

    emit_line("Checking provider connectivity...");
    emit_event(json!({ "type": "connect_check_start" }));
    let mut preflight_conn: Option<iroh::endpoint::Connection> = None;
    match timeout(Duration::from_secs(8), endpoint.connect(ticket_addr.clone(), iroh_blobs::ALPN))
        .await
    {
        Ok(Ok(conn)) => {
            emit_line("Provider preflight connected.");
            emit_event(json!({ "type": "connect_check_ok" }));
            preflight_conn = Some(conn);
        }
        Ok(Err(err)) => {
            emit_line(&format!("Provider preflight failed: {err}"));
            emit_event(json!({
                "type": "connect_check_failed",
                "message": err.to_string()
            }));
        }
        Err(_) => {
            emit_line("Provider preflight timed out.");
            emit_event(json!({
                "type": "connect_check_failed",
                "message": "timeout"
            }));
        }
    }

    // v0.1.85/88/89/90 — chat over the separate `orbitxfer/chat/1`
    // ALPN. Best-effort: a chat failure never blocks the transfer.
    //
    // v0.1.90 — chat is bidirectional and independent of the transfer.
    // The receiver uses the SAME `ChatCoordinator` as the sender:
    //   - it AUTO-dials the sender and self-heals through drops
    //     (spawn_auto_dialer),
    //   - it also ACCEPTS inbound dials (a small Router on its own
    //     endpoint), so the sender's Reconnect Chat can dial it back,
    //   - it OUTLIVES the transfer: Stop Receive cancels the download
    //     but the coordinator + process stay alive for chat; the
    //     process exits when chat is closed (Stop Chat) or the window
    //     closes (stdin EOF).
    let chat_self_label = std::env::var("ORBITXFER_RECEIVER_LABEL")
        .ok()
        .map(|s| sanitize_label_text(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Receiver".to_string());

    // Shared stop signalling for the TRANSFER only (cancellable
    // download loops). Stop Receive trips these; chat is unaffected.
    let stop_signal = std::sync::Arc::new(tokio::sync::Notify::new());
    let stop_requested = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let chat = chat::ChatCoordinator::new(chat_self_label.clone(), endpoint.clone());
    // Seed the dial target: the sender (from the ticket).
    chat.set_peer(ticket_addr.clone());
    // Accept inbound chat dials so the sender can reconnect to us.
    let chat_router = Router::builder(endpoint.clone())
        .accept(chat::CHAT_ALPN, chat.clone())
        .spawn();
    // Auto-dial the sender (first attempt → chat_unavailable on
    // failure; later attempts → chat_reconnect_failed). Runs
    // concurrently with the download.
    chat.spawn_auto_dialer(None);

    // v0.1.85/86/88/89/90 — spawn the stdin command dispatcher.
    // Services ChatSend / ChatStop / ReconnectChat against the
    // coordinator, and signals StopReceive (transfer only) via the
    // stop Notify + AtomicBool. It KEEPS running after Stop Receive so
    // chat commands still work.
    let stop_signal_for_dispatch = stop_signal.clone();
    let stop_requested_for_dispatch = stop_requested.clone();
    let dispatch_chat = chat.clone();
    let cmd_dispatch_task = tokio::spawn(async move {
        let mut cmd_rx = cmd_rx;
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                chat::CliCommand::ChatSend { body } => {
                    if let Err(e) = dispatch_chat.send_text(body).await {
                        emit_event(json!({
                            "type": "chat_send_failed",
                            "error": format!("{}", e),
                        }));
                    }
                }
                chat::CliCommand::ChatStop => {
                    let _ = dispatch_chat.close().await;
                }
                chat::CliCommand::ReconnectChat => {
                    // Try a chat connection now (shortcuts a backoff
                    // sleep / wakes a parked dialer). No-op if already
                    // connected.
                    dispatch_chat.request_reconnect();
                }
                chat::CliCommand::StopReceive => {
                    // v0.1.90 — cancel the TRANSFER only. Do NOT close
                    // chat: the coordinator + process stay alive so the
                    // conversation continues and Reconnect Chat still
                    // works. (Stop Chat closes chat; closing the window
                    // exits the process.)
                    stop_requested_for_dispatch
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    stop_signal_for_dispatch.notify_waiters();
                    // Keep dispatching (no `return`) so chat commands
                    // keep being serviced after the transfer stops.
                }
                chat::CliCommand::StopSend => {
                    // Not applicable on the receive side.
                }
                chat::CliCommand::ResumeSend => {
                    // Not applicable on the receive side.
                }
                chat::CliCommand::ResumeReceive => {
                    // v0.1.94 (planned) — warm in-process resume. Until
                    // the download loop is made re-runnable, the GUI
                    // resumes the receive by respawning, so this is a
                    // no-op placeholder.
                }
            }
        }
    });

    let expected_size = expected_size_from_env();
    let mut total_size: Option<u64> = expected_size;
    if let Some(size) = expected_size {
        emit_line(&format!(
            "Using expected size: {} ({})",
            size,
            format_bytes(size)
        ));
        emit_event(json!({ "type": "download_size", "total": size }));
    }
    let mut free_space: Option<u64> = None;
    // observe() reports the bitfield/size of a SINGLE blob — for a HashSeq
    // collection that's just the tiny root metadata blob, not the aggregate
    // of all files. So we only use it to confirm/refine the total for single
    // files. For folders the authoritative total is the sender's summed
    // `# size=` value (ORBITXFER_EXPECTED_SIZE), already emitted above.
    if !is_collection {
        if let Some(conn) = preflight_conn.clone() {
            let mut observe = store
                .remote()
                .observe(conn, ObserveRequest::new(ticket.hash()));
            if let Ok(Some(Ok(bitfield))) = timeout(Duration::from_secs(6), observe.next()).await {
                let size = bitfield.size();
                total_size = Some(size);
                emit_line(&format!("Remote reported size: {} ({})", size, format_bytes(size)));
                if expected_size.map(|v| v != size).unwrap_or(true) {
                    emit_event(json!({ "type": "download_size", "total": size }));
                }
            }
        }
    }

    // For a folder, fetch just the tiny collection metadata up front so the
    // UI can show the folder's file list/count WHILE the file data is still
    // downloading. Best-effort: if it fails (older provider, transient
    // error), we log and carry on — the file list just won't appear until
    // the writing-to-disk phase.
    if is_collection {
        if let Some(conn) = preflight_conn.clone() {
            match timeout(
                Duration::from_secs(8),
                prefetch_collection_files(&store, &conn, ticket.hash()),
            )
            .await
            {
                Ok(Ok(collection)) => {
                    let total_files = collection.len();
                    let mut names: Vec<String> =
                        collection.iter().map(|(n, _)| n.clone()).collect();
                    // Bound the event size for folders with very many files.
                    let truncated = names.len() > 500;
                    names.truncate(500);
                    emit_line(&format!("Folder contains {total_files} files."));
                    emit_event(json!({
                        "type": "collection_files",
                        "files": total_files,
                        "names": names,
                        "truncated": truncated
                    }));
                }
                Ok(Err(e)) => {
                    emit_line(&format!("Could not prefetch folder file list: {e}"))
                }
                Err(_) => emit_line("Folder file-list prefetch timed out."),
            }
        }
    }

    if let Ok(local) = store.remote().local(ticket.hash_and_format()).await {
        let local_bytes = local.local_bytes();
        if local_bytes > 0 {
            emit_line(&format!(
                "Local resume data available: {} ({})",
                local_bytes,
                format_bytes(local_bytes)
            ));
            emit_event(json!({
                "type": "download_resume_state",
                "bytes": local_bytes,
                "total": total_size
            }));
        }
    }

    if let Ok(space) = available_space(&store_dir) {
        free_space = Some(space);
        emit_line(&format!(
            "Free space at store: {} ({})",
            space,
            format_bytes(space)
        ));
    }

    if let (Some(size), Some(space)) = (total_size, free_space) {
        let required = size + size / 20 + 64 * 1024 * 1024;
        if space < required
            && env::var("ORBITXFER_SKIP_SPACE_CHECK").ok().as_deref() != Some("1")
        {
            let msg = format!(
                "Not enough free space. Need about {} but only {} available.",
                format_bytes(required),
                format_bytes(space)
            );
            emit_error("disk_space", &msg);
            return Err(anyhow!(msg));
        }
    }

    emit_line("Downloading into temporary transfer data.");
    emit_event(json!({ "type": "download_started", "total": total_size }));

    let max_attempts: u32 = env::var("ORBITXFER_DOWNLOAD_ATTEMPTS")
        .ok()
        .and_then(|val| val.parse().ok())
        .unwrap_or(3);
    let mut last_err: Option<anyhow::Error> = None;

    // v0.1.86 — Phase 2 retry budget. The outer loop below wraps the
    // existing direct-fetch + 3-attempt download logic (Phase 1).
    // After Phase 1 exhausts without success, we sleep with
    // exponential backoff (capped at PHASE2_MAX_BACKOFF_SECS) and
    // retry until either success or PHASE2_BUDGET_SECS elapses.
    // StopReceive interrupts the sleep via the Notify signal.
    let phase2_deadline =
        Instant::now() + Duration::from_secs(PHASE2_BUDGET_SECS);
    let mut phase2_attempt: u32 = 0;
    let mut current_backoff = Duration::from_secs(PHASE2_INITIAL_BACKOFF_SECS);
    let mut overall_succeeded = false;
    // v0.1.88 — set when the user clicks Stop during the download.
    // The download loops select on the stop signal so a Stop is
    // near-instant instead of waiting for the GUI's 5s SIGKILL
    // fallback. When set, we skip export and exit cleanly with a
    // `receive_stopped` event (so the frontend shows "Stopped",
    // not "error / exited with code null").
    let mut user_stopped = false;

    let mut direct_completed = false;
    'phase2: loop {
        // Reset per-Phase-1-cycle state. `direct_completed` from a
        // prior iteration stays false (preflight_conn was consumed
        // on the first iteration); the downloader inner loop handles
        // its own connect attempts.
        last_err = None;
        direct_completed = false;
    if let Some(conn) = preflight_conn.take() {
        emit_line("Attempting direct fetch over preflight connection...");
        emit_event(json!({ "type": "download_direct_start" }));
        let mut stream = store
            .remote()
            .fetch(conn, ticket.hash_and_format())
            .stream();
        let mut connected = false;
        let mut throttle = ProgressThrottle::new();
        // v0.1.88 — cancellable: select stream progress against the
        // stop signal so Stop interrupts a live fetch immediately.
        let stop_notified = stop_signal.notified();
        tokio::pin!(stop_notified);
        loop {
            if stop_requested.load(std::sync::atomic::Ordering::SeqCst) {
                user_stopped = true;
                break;
            }
            tokio::select! {
                item = stream.next() => {
                    match item {
                        Some(GetProgressItem::Progress(bytes)) => {
                            if !connected {
                                connected = true;
                                emit_event(json!({ "type": "connect_success" }));
                            }
                            if throttle.should_emit(bytes) {
                                // v0.1.85 — `bytes` is session-local;
                                // add the resume baseline so the bar
                                // shows cumulative file completion.
                                emit_event(json!({
                                    "type": "download_progress",
                                    "bytes": baseline_bytes.saturating_add(bytes),
                                    "total": total_size
                                }));
                            }
                        }
                        Some(GetProgressItem::Done(_)) => {
                            if !connected {
                                emit_event(json!({ "type": "connect_success" }));
                            }
                            emit_line("Direct fetch complete.");
                            emit_event(json!({ "type": "download_complete", "total": total_size }));
                            direct_completed = true;
                            last_err = None;
                            break;
                        }
                        Some(GetProgressItem::Error(err)) => {
                            emit_line(&format!("Direct fetch error: {err:?}"));
                            last_err = Some(anyhow!(err));
                            break;
                        }
                        None => break,
                    }
                }
                _ = &mut stop_notified => {
                    user_stopped = true;
                    break;
                }
            }
        }
        if user_stopped {
            break 'phase2;
        }
        if direct_completed {
            emit_line("Finalizing into destination file.");
        }
    }

    if direct_completed {
        // Skip downloader fallback; proceed to export.
    } else {
    for attempt in 1..=max_attempts {
        emit_line(&format!("Download attempt {attempt}/{max_attempts}"));
        emit_event(json!({
            "type": "download_attempt",
            "attempt": attempt,
            "max": max_attempts
        }));

        let downloader = store.downloader(&endpoint);
        let request = iroh_blobs::protocol::GetRequest::from(ticket.hash_and_format());
        let mut stream = match downloader
            .download(request, vec![ticket_addr.id])
            .stream()
            .await
        {
            Ok(stream) => stream,
            Err(err) => {
                last_err = Some(err.into());
                emit_line("Failed to start download stream.");
                if attempt < max_attempts {
                    let delay = 2 * attempt;
                    emit_line(&format!("Retrying in {delay}s..."));
                    emit_event(json!({
                        "type": "download_retry",
                        "attempt": attempt,
                        "next_in_sec": delay
                    }));
                    sleep(Duration::from_secs(delay.into())).await;
                    continue;
                } else {
                    break;
                }
            }
        };

        let mut connected = false;
        let mut download_error: Option<anyhow::Error> = None;
        let mut providers_tried = 0u32;
        let mut providers_failed = 0u32;
        let mut downloader_throttle = ProgressThrottle::new();
        // v0.1.88 — cancellable downloader loop (see the direct-fetch
        // loop above for the pattern).
        let stop_notified = stop_signal.notified();
        tokio::pin!(stop_notified);
        loop {
            if stop_requested.load(std::sync::atomic::Ordering::SeqCst) {
                user_stopped = true;
                break;
            }
            let item = tokio::select! {
                item = stream.next() => item,
                _ = &mut stop_notified => {
                    user_stopped = true;
                    break;
                }
            };
            let Some(item) = item else { break };
            match item {
                DownloadProgressItem::TryProvider { id, .. } => {
                    providers_tried += 1;
                    emit_event(json!({
                        "type": "download_provider_try",
                        "endpoint_id": id.to_string()
                    }));
                    emit_line(&format!("Trying provider {id}"));
                }
                DownloadProgressItem::ProviderFailed { id, .. } => {
                    providers_failed += 1;
                    emit_event(json!({
                        "type": "download_provider_failed",
                        "endpoint_id": id.to_string()
                    }));
                    emit_line(&format!("Provider failed {id}"));
                    if !connected {
                        emit_event(json!({
                            "type": "connect_failed",
                            "message": "provider failed"
                        }));
                    }
                }
                DownloadProgressItem::PartComplete { .. } => {
                    if !connected {
                        connected = true;
                        emit_event(json!({ "type": "connect_success" }));
                    }
                }
                DownloadProgressItem::Progress(bytes) => {
                    if !connected {
                        connected = true;
                        emit_event(json!({ "type": "connect_success" }));
                    }
                    if downloader_throttle.should_emit(bytes) {
                        // v0.1.85 — see `download_resume_baseline`
                        // comment above. Same cumulative-bytes
                        // adjustment applied to the downloader path
                        // (used when the direct GET falls back to the
                        // multi-provider downloader).
                        emit_event(json!({
                            "type": "download_progress",
                            "bytes": baseline_bytes.saturating_add(bytes),
                            "total": total_size
                        }));
                    }
                }
                DownloadProgressItem::DownloadError => {
                    download_error = Some(anyhow!("download error"));
                    break;
                }
                DownloadProgressItem::Error(err) => {
                    download_error = Some(err.into());
                    break;
                }
            }
        }

        if user_stopped {
            break;
        }

        if let Some(err) = download_error {
            emit_line(&format!(
                "Download attempt {attempt} failed after trying {} providers ({} failed).",
                providers_tried, providers_failed
            ));
            last_err = Some(err);
            if attempt < max_attempts {
                let delay = 2 * attempt;
                emit_line(&format!("Retrying in {delay}s..."));
                emit_event(json!({
                    "type": "download_retry",
                    "attempt": attempt,
                    "next_in_sec": delay
                }));
                sleep(Duration::from_secs(delay.into())).await;
                continue;
            } else {
                break;
            }
        }

        if !connected {
            emit_event(json!({ "type": "connect_success" }));
        }

        emit_line("Finished download.");
        emit_event(json!({ "type": "download_complete", "total": total_size }));
        last_err = None;
        break;
    }
    }

    // v0.1.88 — user clicked Stop during the download. Exit the
    // retry loop immediately; `user_stopped` drives the clean-exit
    // path below. Checked BEFORE the success check because a Stop
    // mid-Progress leaves last_err == None, which would otherwise
    // look like success.
    if user_stopped {
        break 'phase2;
    }

    // v0.1.86 — Phase 1 cycle is done. Decide whether to retry.
    if last_err.is_none() {
        // Phase 1 succeeded (or direct fetch did) — exit the
        // outer retry loop.
        overall_succeeded = true;
        break 'phase2;
    }

    // Phase 1 exhausted without success. Decide on Phase 2.
    if stop_requested.load(std::sync::atomic::Ordering::SeqCst) {
        emit_event(json!({ "type": "download_retry_cancelled" }));
        emit_line("Retry loop cancelled by user.");
        break 'phase2;
    }
    // v0.1.88 — telemetry: classify why Phase 1 failed so the GUI can
    // explain the wait in plain language.
    let (fail_code, fail_message) = match &last_err {
        Some(e) => categorize_receive_failure(&format!("{e}")),
        None => ("unknown", "Retrying.".to_string()),
    };

    let remaining = phase2_deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        emit_event(json!({
            "type": "download_giving_up",
            "phase2_attempts": phase2_attempt,
            "budget_ms": PHASE2_BUDGET_SECS * 1000,
            "reason_code": fail_code,
            "reason": fail_message,
        }));
        emit_line(&format!(
            "Sender unreachable after Phase 2 retry budget ({} s). Giving up.",
            PHASE2_BUDGET_SECS
        ));
        break 'phase2;
    }

    phase2_attempt += 1;
    let sleep_for = current_backoff.min(remaining);
    emit_event(json!({
        "type": "download_waiting_for_sender",
        "phase2_attempt": phase2_attempt,
        "next_retry_in_ms": sleep_for.as_millis() as u64,
        "time_remaining_ms": remaining.as_millis() as u64,
        "budget_ms": PHASE2_BUDGET_SECS * 1000,
        "reason_code": fail_code,
        "reason": fail_message,
    }));
    emit_line(&format!(
        "Sender unreachable. Retry #{} in {} s (Phase 2 budget remaining: {} s).",
        phase2_attempt,
        sleep_for.as_secs(),
        remaining.as_secs()
    ));

    // Sleep until either the backoff elapses OR a StopReceive
    // command arrives. The Notify is woken by the dispatcher.
    let signal = stop_signal.clone();
    tokio::select! {
        _ = tokio::time::sleep(sleep_for) => {}
        _ = signal.notified() => {
            emit_event(json!({ "type": "download_retry_cancelled" }));
            emit_line("Retry sleep cancelled by user.");
            break 'phase2;
        }
    }

    // Grow backoff for the next iteration, capped at the max.
    current_backoff = (current_backoff
        * PHASE2_BACKOFF_MULTIPLIER)
        .min(Duration::from_secs(PHASE2_MAX_BACKOFF_SECS));

    }
    // End of 'phase2 loop.

    // v0.1.88/90 — clean user-initiated stop. Emit a dedicated
    // `receive_stopped` event (NOT an error) so the GUI shows
    // "Stopped" instead of "error / exited with code null". The
    // partial `.orbitxfer-pieces/` store is intentionally preserved so
    // Resume Last Receive still works.
    //
    // v0.1.90 — chat OUTLIVES Stop Receive. Instead of exiting, we
    // flush the partial store and then linger for chat (the dispatcher
    // stays alive so Reconnect Chat / Stop Chat keep working). The
    // process exits when chat closes (Stop Chat) or the window closes.
    if user_stopped {
        emit_event(json!({ "type": "receive_stopped" }));
        emit_line("Receive stopped by user; chat remains available.");
        // Flush the partial store to disk (but do NOT remove it) so
        // the cached chunks survive for Resume Last Receive. Chat uses
        // the endpoint, not the store, so this is safe.
        let _ = store.shutdown().await;
        chat_keepalive(&chat).await;
        cmd_dispatch_task.abort();
        // v0.1.90 — chat is fully done; exit decisively. A bounded
        // router shutdown closes the endpoint cleanly, then we force
        // exit: the blocking stdin reader thread (and a stuck router
        // shutdown) must not keep the process alive once the user has
        // closed both the transfer and chat.
        let _ = tokio::time::timeout(Duration::from_secs(2), chat_router.shutdown()).await;
        std::process::exit(0);
    }

    if !overall_succeeded {
        if let Some(err) = last_err {
            emit_error("download", &err);
            return Err(err);
        }
        // No error was captured but we also didn't succeed — this
        // happens on user-cancelled retry. Return a clean error so
        // the GUI shows the right state.
        let cancelled = anyhow!("download cancelled or budget exhausted");
        emit_error("download", &cancelled);
        return Err(cancelled);
    }

    if !direct_completed {
        emit_line(if is_collection {
            "Finalizing files into destination folder."
        } else {
            "Finalizing into destination file."
        });
    }

    if is_collection {
        export_collection(&store, ticket.hash(), &abs_path, total_size).await?;
    } else {
        emit_event(json!({ "type": "export_started", "total": total_size }));
        let mut export_stream = store
            .blobs()
            .export_with_opts(ExportOptions {
                hash: ticket.hash(),
                mode: ExportMode::TryReference,
                target: abs_path,
            })
            .stream()
            .await;
        let mut export_total: Option<u64> = None;
        let mut export_throttle = ProgressThrottle::new();
        while let Some(item) = export_stream.next().await {
            match item {
                ExportProgressItem::Size(size) => {
                    export_total = Some(size);
                    emit_event(json!({ "type": "export_size", "total": size }));
                }
                ExportProgressItem::CopyProgress(bytes) => {
                    if export_throttle.should_emit(bytes) {
                        emit_event(json!({
                            "type": "export_progress",
                            "bytes": bytes,
                            "total": export_total
                        }));
                    }
                }
                ExportProgressItem::Done => {
                    emit_event(json!({ "type": "export_complete", "total": export_total }));
                    break;
                }
                ExportProgressItem::Error(err) => {
                    emit_error("export", &err);
                    return Err(err.into());
                }
            }
        }
    }

    emit_line("Finished finalizing destination file.");

    // v0.1.85 — clean up the store BEFORE the chat-keepalive loop, so
    // the file appears in the destination immediately and the disk
    // footprint is gone. The chat keeps the iroh endpoint alive on
    // its own connection.
    store.shutdown().await?;
    if auto_store_cleanup {
        if let Err(err) = std::fs::remove_dir_all(&store_dir) {
            emit_line(&format!(
                "Warning: failed to remove temp store {}: {err}",
                store_dir.display()
            ));
        }
    }

    // v0.1.88/90 — keep the receiver process alive after the transfer
    // completes for as long as chat wants to live (see chat_keepalive).
    chat_keepalive(&chat).await;

    // Stop the dispatcher and shut down cleanly.
    cmd_dispatch_task.abort();

    emit_line("Shutting down.");
    // v0.1.90 — exit decisively (see the user_stopped path above): a
    // bounded router shutdown closes the endpoint, then force exit so
    // the blocking stdin reader can't keep the process alive.
    let _ = tokio::time::timeout(Duration::from_secs(2), chat_router.shutdown()).await;
    std::process::exit(0);
}

/// v0.1.90 — linger for chat after the transfer ends. The process
/// stays alive while the coordinator still wants to (a session is live,
/// a dialer is healing, or a chat connected at least once and the user
/// hasn't closed it). Exits when chat is done (Stop Chat / never
/// connected) or ctrl-c; the window closing trips stdin EOF, which
/// exits the process directly. Independent of the transfer's stop
/// signals — chat keeps working after Stop Receive.
async fn chat_keepalive(chat: &chat::ChatCoordinator) {
    if !chat.should_linger() {
        return;
    }
    emit_event(json!({ "type": "chat_keepalive_started" }));
    loop {
        if !chat.should_linger() {
            break;
        }
        tokio::select! {
            _ = chat.wait_ended() => {}
            // Periodic re-check: cheap insurance against a missed wake.
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    emit_event(json!({ "type": "chat_keepalive_ended" }));
}
