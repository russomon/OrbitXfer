use anyhow::{anyhow, bail, Context, Result};
use fs2::available_space;
use futures_lite::StreamExt;
use irpc::channel::mpsc;
use iroh::{address_lookup::MemoryLookup, protocol::Router, Endpoint, EndpointAddr};
use iroh_base::SecretKey;
use iroh_blobs::{
    api::blobs::{
        AddPathOptions, AddProgressItem, ExportMode, ExportOptions, ExportProgressItem, ImportMode,
    },
    api::downloader::DownloadProgressItem,
    api::remote::GetProgressItem,
    provider::events::{EventMask, EventSender, ProviderMessage, RequestUpdate, ThrottleMode},
    store::fs::FsStore,
    ticket::BlobTicket,
    BlobFormat,
    BlobsProtocol,
};
use iroh_blobs::protocol::ObserveRequest;
use serde_json::json;
use getrandom::getrandom;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::time::{sleep, timeout, Duration};

const CLI_VERSION: &str = "0.1.51";

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
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let store_dir = base_dir.join(".orbitxfer-store").join(format!("rx-{ts}"));
    Ok((store_dir, true))
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
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut idx = 0usize;
    while value >= 1024.0 && idx < UNITS.len() - 1 {
        value /= 1024.0;
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

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let cmd = args.next().unwrap_or_default();

    match cmd.as_str() {
        "send" => {
            emit_line(&format!("OrbitXfer CLI {} (send)", CLI_VERSION));
            let file = args.next().context("missing file path")?;
            if args.next().is_some() {
                bail!("send takes exactly one argument");
            }
            run_send(PathBuf::from(file)).await?;
        }
        "receive" => {
            emit_line(&format!("OrbitXfer CLI {} (receive)", CLI_VERSION));
            let ticket = args.next().context("missing ticket")?;
            let output = args.next().context("missing output path")?;
            if args.next().is_some() {
                bail!("receive takes exactly two arguments");
            }
            run_receive(ticket, PathBuf::from(output)).await?;
        }
        _ => {
            print_usage();
        }
    }

    Ok(())
}

async fn run_send(file_path: PathBuf) -> Result<()> {
    let abs_path = abs_path(&file_path)?;

    emit_line("Hashing file (this can take a while for large files).");
    emit_event(json!({ "type": "ticket_hashing_start" }));
    let store_dir = store_root()?;
    std::fs::create_dir_all(&store_dir)?;
    let store = FsStore::load(store_dir.clone()).await?;
    let store_handle = store.as_ref().clone();
    let event_mask = EventMask {
        throttle: ThrottleMode::None,
        ..EventMask::ALL_READONLY
    };
    let (events_tx, mut events_rx) = EventSender::channel(32, event_mask);
    let blobs = BlobsProtocol::new(&store, Some(events_tx));

    let add_opts = AddPathOptions {
        path: abs_path.clone(),
        format: BlobFormat::Raw,
        mode: import_mode_from_env(),
    };

    let mut total_size: Option<u64> = std::fs::metadata(&abs_path).map(|m| m.len()).ok();
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
    let hash_and_format = temp_tag.hash_and_format();
    let hash = hash_and_format.hash;
    let format = hash_and_format.format;

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

    emit_line("Binding endpoint...");
    let endpoint = if let Some(path) = resolve_identity_key_path() {
        let key = load_or_create_secret_key(&path)?;
        emit_line(&format!("Using persistent identity key: {}", path.display()));
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
    emit_event(json!({
        "type": "ticket_variants",
        "direct": direct_ticket,
        "relay": relay_ticket,
        "full": full_ticket
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

    let upload_total = Arc::new(AtomicU64::new(total_size.unwrap_or(0)));
    let upload_total_events = upload_total.clone();
    let spawn_updates = |mut rx: mpsc::Receiver<RequestUpdate>, total: Arc<AtomicU64>| {
        tokio::spawn(async move {
            let mut last_progress = 0u64;
            while let Ok(Some(update)) = rx.recv().await {
                match update {
                    RequestUpdate::Started(started) => {
                        total.store(started.size, Ordering::Relaxed);
                        emit_event(json!({ "type": "upload_started", "total": started.size }));
                    }
                    RequestUpdate::Progress(progress) => {
                        let bytes = progress.end_offset;
                        if bytes == last_progress {
                            continue;
                        }
                        last_progress = bytes;
                        let total_val = total.load(Ordering::Relaxed);
                        let total_opt = if total_val > 0 { Some(total_val) } else { None };
                        emit_event(json!({
                            "type": "upload_progress",
                            "bytes": bytes,
                            "total": total_opt
                        }));
                    }
                    RequestUpdate::Completed(_) => {
                        emit_event(json!({ "type": "upload_complete" }));
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

    tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            match event {
                ProviderMessage::ClientConnected(msg) => {
                    let id_str = msg.endpoint_id.map(|id| id.to_string());
                    emit_line(&format!("Receiver connected {:?}", id_str));
                    emit_event(json!({
                        "type": "receiver_connected",
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
                    let _ = msg.tx.send(Ok(())).await;
                    spawn_updates(msg.rx, upload_total_events.clone());
                }
                ProviderMessage::GetRequestReceivedNotify(msg) => {
                    spawn_updates(msg.rx, upload_total_events.clone());
                }
                ProviderMessage::GetManyRequestReceived(msg) => {
                    emit_event(json!({
                        "type": "provider_get_many_request",
                        "count": msg.request.hashes.len()
                    }));
                    let _ = msg.tx.send(Ok(())).await;
                    spawn_updates(msg.rx, upload_total_events.clone());
                }
                ProviderMessage::GetManyRequestReceivedNotify(msg) => {
                    spawn_updates(msg.rx, upload_total_events.clone());
                }
                ProviderMessage::ConnectionClosed(_) => {
                    emit_line("Receiver disconnected");
                    emit_event(json!({ "type": "receiver_disconnected" }));
                }
                ProviderMessage::Throttle(msg) => {
                    let _ = msg.tx.send(Ok(())).await;
                }
                _ => {}
            }
        }
    });

    let router = Router::builder(endpoint)
        .accept(iroh_blobs::ALPN, blobs)
        .spawn();

    emit_line("Hashing complete.");
    emit_line("File analyzed. Fetch this file by running:");
    emit_line(&format!(
        "orbitxfer-iroh-cli receive {ticket} {}",
        file_path.display()
    ));
    emit_line("Press Ctrl+C to stop serving.");

    tokio::signal::ctrl_c().await?;

    emit_line("Shutting down.");
    router.shutdown().await?;
    drop(temp_tag);
    Ok(())
}

async fn run_receive(ticket_str: String, output_path: PathBuf) -> Result<()> {
    let ticket: BlobTicket = ticket_str.parse().context("invalid ticket")?;
    let ticket_addr = ticket.addr().clone();
    emit_line(&format!("Ticket addr: {}", describe_addr(&ticket_addr)));
    let mut abs_path = abs_path(&output_path)?;
    if abs_path.is_dir() {
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

    let (store_dir, auto_store_cleanup) = store_root_for_receive(&abs_path)?;
    std::fs::create_dir_all(&store_dir)?;
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

    emit_line("Starting download.");
    emit_event(json!({ "type": "download_started", "total": total_size }));

    let max_attempts: u32 = env::var("ORBITXFER_DOWNLOAD_ATTEMPTS")
        .ok()
        .and_then(|val| val.parse().ok())
        .unwrap_or(3);
    let mut last_err: Option<anyhow::Error> = None;

    let mut direct_completed = false;
    if let Some(conn) = preflight_conn.take() {
        emit_line("Attempting direct fetch over preflight connection...");
        emit_event(json!({ "type": "download_direct_start" }));
        let mut stream = store
            .remote()
            .fetch(conn, ticket.hash_and_format())
            .stream();
        let mut connected = false;
        while let Some(item) = stream.next().await {
            match item {
                GetProgressItem::Progress(bytes) => {
                    if !connected {
                        connected = true;
                        emit_event(json!({ "type": "connect_success" }));
                    }
                    emit_event(json!({
                        "type": "download_progress",
                        "bytes": bytes,
                        "total": total_size
                    }));
                }
                GetProgressItem::Done(_) => {
                    if !connected {
                        emit_event(json!({ "type": "connect_success" }));
                    }
                    emit_line("Direct fetch complete.");
                    emit_event(json!({ "type": "download_complete", "total": total_size }));
                    direct_completed = true;
                    last_err = None;
                    break;
                }
                GetProgressItem::Error(err) => {
                    emit_line(&format!("Direct fetch error: {err:?}"));
                    last_err = Some(anyhow!(err));
                    break;
                }
            }
        }
        if direct_completed {
            emit_line("Copying to destination.");
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
        while let Some(item) = stream.next().await {
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
                    emit_event(json!({
                        "type": "download_progress",
                        "bytes": bytes,
                        "total": total_size
                    }));
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

    if let Some(err) = last_err {
        emit_error("download", &err);
        return Err(err);
    }

    if !direct_completed {
        emit_line("Copying to destination.");
    }

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
    while let Some(item) = export_stream.next().await {
        match item {
            ExportProgressItem::Size(size) => {
                export_total = Some(size);
                emit_event(json!({ "type": "export_size", "total": size }));
            }
            ExportProgressItem::CopyProgress(bytes) => {
                emit_event(json!({
                    "type": "export_progress",
                    "bytes": bytes,
                    "total": export_total
                }));
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

    emit_line("Finished copying.");
    emit_line("Shutting down.");
    endpoint.close().await;
    store.shutdown().await?;
    if auto_store_cleanup {
        if let Err(err) = std::fs::remove_dir_all(&store_dir) {
            emit_line(&format!("Warning: failed to remove temp store {}: {err}", store_dir.display()));
        }
    }
    Ok(())
}
