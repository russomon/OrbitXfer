# Releases

## v0.1.76 - 2026-05-29
- **One universal Mac DMG instead of two arch-specific ones.** CI now produces a single `OrbitXfer_<version>_universal.dmg` that runs natively on both Apple Silicon and Intel Macs — same signed/notarized DMG works everywhere. Eliminates the dependency on GitHub's `macos-13` Intel runner pool, which had become unreliable (multi-hour queues, sometimes days). No app code changes from v0.1.75.
- **How it works:** the (Apple Silicon) `macos-latest` runner now also installs the `x86_64-apple-darwin` Rust target, builds the CLI sidecar for both archs, lipo-merges them into a `universal-apple-darwin` fat binary, then runs `tauri build --target universal-apple-darwin` for a universal2 .app. Single codesign + notarization pass. Slightly larger DMG (~1.5–2× since both archs' code is included) in exchange for one-DMG simplicity.
- **CI matrix back to three entries** (`macos-latest`, `windows-latest`, `ubuntu-latest`); no more `macos-13`. The Intel runner queue purgatory is over.

## v0.1.75 - 2026-05-28
- **CI now builds a signed Intel Mac DMG** alongside the existing Apple Silicon one. GitHub's `macos-latest` is now Apple Silicon (macos-14), so every release through v0.1.74 shipped arm64-Mac-only. The build matrix now includes `macos-13` (Intel) too, with the same signing + notarization path, producing a second signed/notarized DMG per tag release (`OrbitXfer_<version>_x64.dmg`).
- Artifact names are arch-aware (`OrbitXfer-macOS-ARM64` vs `OrbitXfer-macOS-X64`) so the two Mac matrix entries don't collide in the release job.
- **No app code changes from v0.1.74** — this is a CI-only release to deliver the first signed Intel build. If you're on Apple Silicon, the v0.1.74 and v0.1.75 DMGs are functionally identical.

## v0.1.74 - 2026-05-28
- **Fix premature "✓ Transfer Complete" on the Send window.** iroh fires `RequestUpdate::Completed` PER CHILD BLOB during a HashSeq (folder) send — root → meta → file₁ → file₂ → … — and the v0.1.73 frontend unconditionally treated the first one as the end. With the root blob completing in microseconds, the summary box flashed on as soon as the transfer began. The CLI's `upload_complete` event now carries both `bytes` (running `completed_bytes`) and `total`, and the frontend only flips to "complete" + locks in the summary stats when `bytes ≥ total`. Intermediate per-blob completions are silent no-ops. Single-file (Raw) sends still hit completion on their lone Completed (`bytes == total`).
- **Per-receiver ETA** on the Sender's "Receivers" panel — mirrors the Receive window's ETA on the per-row meta line, computed from each receiver's rolling speed + remaining bytes.
- **Send-side completion summary moved down.** The "✓ Transfer Complete" block now appears just above the Send logs (after the Receivers panel) instead of up by the status line — keeps the ticket and live receiver rows in their natural reading flow during the transfer and uses the summary as a closing note.

## v0.1.73 - 2026-05-24
- **Send progress bar no longer resets per file during a folder upload.** The CLI's `spawn_updates` now aggregates `RequestUpdate::Progress.end_offset` across all blobs in a HashSeq, so the sender's bar climbs monotonically across the whole folder instead of snapping back to 0 each time iroh advances to the next child blob. Single-file (Raw) sends are unchanged. Receive-side progress was already aggregate (iroh's downloader reports cumulative bytes) — this brings the send side into parity.
- **"Transfer Complete" summary** on both Send and Receive windows. When a transfer finishes, the bare `Status: complete` line is replaced by a green-accented block listing the file/folder name (with file count for folders), total size, average speed (= size / elapsed), and total time. For multi-receiver sends, stats reflect the first receiver's completion; per-receiver speed/time stays accurate in the Receivers panel.
- **"Don't close this window" warning** under the share textarea — amber left-border so it stands out from the normal hint text. Wording: *"Don't close this window. The file is only available to download while this window stays open."*
- **Softer close-window warning.** Replaced the three variants of "A send/receive/transfer is in progress…" with a single unified line: *"A transfer may be in progress. Closing this window will stop the transfer. Close anyway?"* — matches the recent quit-dialog wording.

## v0.1.72 - 2026-05-24
- **Folder receives now show what's inside.** Two additions for folder transfers:
  - **During download:** the receiver pre-fetches just the tiny collection metadata (root + names blob) up front, so it can show "Folder · N files" plus an expandable file list *while the data is still transferring*. Best-effort and isolated — if the prefetch fails it's logged and the normal download proceeds unaffected. The list is capped at 500 names for very large folders (with an "…and X more" note); the count is always exact.
  - **During finalize:** the "Writing to disk" phase now shows the current file — "Writing file 12 of 240: photos/IMG_0042.jpg" — driven by a new per-file `export_file_start` event.
- Note: live "currently downloading file K" *during the network transfer* is intentionally not shown — iroh's high-level downloader reports only aggregate bytes and child sizes aren't known up front, so per-file network progress would require dropping the robust retry/fallback downloader. The file list during download + per-file during finalize covers the visibility without that tradeoff.
- CLI: new `collection_files` event (prefetched names/count) and `export_file_start` event. Uses a targeted `GetRequest` (root + child 0) to fetch only the collection structure.

## v0.1.71 - 2026-05-23
- **See who's downloading (opt-in receiver labels + per-receiver rows).** The sender now shows a "Receivers" panel listing everyone currently pulling the file, each with its own progress bar, %, bytes, and speed. Multiple simultaneous receivers are tracked independently (replacing the single jumpy upload bar during the upload phase).
  - **Receivers can volunteer a nickname.** The Receive panel has a new optional "Your label" field. If filled in, the name shows up on the sender's row for that receiver (e.g. "Bob's MacBook"); left blank, nothing is sent. Empty by default — fully opt-in — and persisted across launches.
  - **How it works:** a new side-channel ALPN (`orbitxfer/label/0`) registered on the sender's router. The receiver opens a short connection and sends the label; the sender correlates it to the receiver's cryptographically-authenticated NodeID, so a peer can only label *itself*, not impersonate another. Best-effort and backward-compatible — an older sender without the protocol just declines, and the download proceeds normally.
  - **Privacy/trust notes:** labels are self-asserted and unverified (the panel says so), receiver identities remain ephemeral, and the label travels only to the one sender over an encrypted connection. The CLI sanitizes labels (control chars stripped, capped at 64 chars).
- **CLI events** now tag `upload_started` / `upload_progress` / `upload_complete` and `receiver_connected` / `receiver_disconnected` with a `connection_id` so the UI can maintain per-receiver rows, plus a new `receiver_label` event.

## v0.1.70 - 2026-05-23
- **Send folders, not just files (Phase 2).** A new "Pick folder…" button (right after "Pick file…") sends an entire directory. Under the hood the folder becomes an iroh-blobs **collection** (`BlobFormat::HashSeq`): every file is added as its own content-addressed blob, bundled under a small metadata blob that carries the relative paths. The recipient downloads the whole collection in one transfer and extracts it, recreating the folder's structure (nested subfolders included).
  - **CLI:** `run_send` now branches — a path that's a directory is walked recursively (symlinks skipped), each file hashed and added, then bundled via `Collection::store`. `run_receive` reads the ticket's format: a HashSeq ticket is extracted file-by-file into the chosen destination folder (`export_collection`), a Raw ticket stays the single-file path. The download/fetch code already recursed for HashSeq, so only export needed changing.
  - **Security:** collection entry names are sanitized on extract — absolute paths and `..` components are rejected to prevent writing outside the destination folder (zip-slip).
  - **Progress stays aligned:** the canonical total for a folder is the **sum of all file sizes**, embedded in the share line's `# size=` just like single files, so the sender and receiver denominators match. For folders the provider `observe()` size check is skipped (it only sees the tiny root metadata blob), relying on the summed total instead.
- **Folder share lines use a trailing slash.** A folder ticket reads `… MyFolder/  # size=N` — the trailing slash tells the recipient's UI to show a destination-folder picker and label things "folder" instead of "file." The CLI remains authoritative (it reads file-vs-folder from the ticket format itself), so a hint-less paste still works.
- **Send panel shows the file count** for a folder once hashing reports it (e.g. "MyFolder · 240 files").
- **Known limitations (MVP):** empty directories, symlinks, and POSIX permissions/xattrs are not preserved.

## v0.1.69 - 2026-05-23
- **One-step send.** Picking a file now starts the send immediately — the separate "Start Send" button is gone. Pick a file, get a ticket. (Stop is still there to cancel an in-flight send, and changing the connection mode still regenerates the displayed ticket instantly.)
- **Clearer send status.** While the file is being hashed and the ticket is being minted, the status now reads `creating_ticket` instead of the misleading `sending` (nothing is sent until a recipient connects). Internally the `"sending"` send-state was renamed `"creating_ticket"`.
- **Share-box copy.** The share area now leads with a short heading **"Your Share Ticket:"** followed by smaller instructional text — *"Share this Ticket with the recipient to start the file transfer. They just need to paste it into Receive and click Start Receive."* The previous connection-mode hint line was removed.
- Groundwork release ahead of folder-send support (Phase 2).

## v0.1.68 - 2026-05-22
- **Connection mode always defaults to "Direct + Relay fallback (recommended)".** Every launch and every new window now starts on the recommended mode. The selection is no longer persisted to localStorage — each new window/session begins from the safe default instead of inheriting a previous Relay-only / Direct-only choice.
- **Clearer quit warning.** The "transfers in progress" quit dialog now reads *"Transfer(s) may be in progress…"* instead of *"Transfers are still in progress…"* — the app can't always be certain a transfer is mid-flight, so the softer wording is more accurate.
- **Share-box copy tidy-up.** The heading is now *"Send this "Share" Ticket to the recipient:"* and the helper line is trimmed to the essential: *"This ticket reflects the connection mode you picked above; switch the radio button to regenerate it instantly."* (The `# size=…` shell-comment explanation was removed from the UI — it's an implementation detail users don't need.)

## v0.1.67 - 2026-05-20
- **Connection mode is now three choices and actually changes the shared ticket.** The Send panel's radios are now: *Direct + Relay fallback (recommended)*, *Relay only (no direct IPs)*, and *Direct only (no relay)*. Previously the radio only ever produced the full ticket regardless of selection — the mode was effectively a no-op for what you shared. Now the main share line renders the variant matching the selected mode, and switching the radio updates it **instantly** (no re-send): the CLI already emits all three address variants with every send, so this is a pure client-side pick.
  - If the preferred variant isn't available (e.g. no direct IPs behind certain NATs), the share line falls back to the full ticket and shows a note explaining why.
- **Auto-shown mode descriptions.** The explanatory text for whichever mode is currently selected appears beneath that radio (the other two stay hidden). No click-to-expand. A persistent footer reminds the user all three modes are end-to-end encrypted — the relay can never read file contents, it only routes the connection.
- **Removed the bare/direct/relay ticket disclosure fields.** With the share line now reflecting the chosen mode directly, the three "just the bare ticket / direct ticket / relay ticket" expandable textareas under the share box are gone — they were a manual workaround for the bug above and are now redundant.

## v0.1.66 - 2026-05-20
- **Send-side progress bar no longer freezes on fast transfers.** The CLI's `upload_progress` emit path now uses the same `ProgressThrottle` (4 MB / 500 ms gate) we already had on the receive side. Background: at multi-Gbit/s, iroh's `RequestUpdate::Progress` fires per chunk/packet — tens of thousands of events per second — which drowned the Tauri webview's JS thread and stalled the Send window's progress UI partway through (the actual transfer kept running fine; the receiver still finished). Same root cause as the v0.1.64 receive-side freeze; we just hadn't applied the throttle to the send loop too. `RequestUpdate::Completed` is unthrottled so the final 100% snap always lands.

## v0.1.65 - 2026-05-20
- **Sender and receiver progress denominators are now identical.** The share line now carries a `# size=<bytes>` shell-comment suffix encoding the file's canonical payload size (from `std::fs::metadata().len()` at hashing time). The receiver's UI parses that suffix on paste and seeds its progress total instantly — before `Start Receive` is clicked, before the sidecar is spawned, before `observe()` round-trips to the provider. Both sides now compute `bytes / total` against the exact same denominator, so the two progress bars stay visually aligned through the whole transfer instead of drifting. Backward-compatible: bare tickets (without the suffix) still work, just without the instant seed.
- **CLI gets `expected_size` plumbed end-to-end.** Tauri's `start_receive` command now takes an optional `expectedSize` parameter and forwards it as `ORBITXFER_EXPECTED_SIZE` to the sidecar. The CLI already honored that env var (since pre-v0.1.64); we just hadn't been setting it. The CLI emits `download_size` immediately from the seed and only re-emits it if the provider's `observe()` returns a different number.
- **Upload progress denominator stays pinned.** Previously `RequestUpdate::Started.size` from iroh could clobber the canonical metadata size mid-upload, which (when iroh's view diverged by chunk-padding/encoding details) made the sender bar use a slightly different total than the receiver bar. Now the sender holds the metadata size in a once-set `AtomicU64` and emits it as `total` on every `upload_progress`. `started.size` is still surfaced as `iroh_size` in the `upload_started` event for transparency.
- **`start_receive` accepts an explicit `store_dir` override.** Optional `storeDir` parameter (no UI yet — forward-compat for resume / advanced flows). When set, it forwards as `ORBITXFER_STORE_DIR` to the sidecar; the CLI honors the path verbatim and skips the default auto-cleanup. The default behavior (fresh receive, no override) is unchanged: `<destination>.orbitxfer-pieces/` next to the chosen destination, auto-cleaned on success.
- **Receive-side phase separation is unchanged but now confirmed-correct.** Download progress counts payload bytes only; export/finalization runs as a distinct phase with its own bar starting at 0 — exactly like the Electron version. Hitting 100% on download then watching "Writing to disk" tick up to 100% is the expected pattern, not a counter that double-counts.

## v0.1.64 - 2026-05-20
- **CLI now throttles receive-side progress events.** `download_progress` and `export_progress` previously fired on every iroh progress notification — at multi-Gbit/s speeds that's thousands of events per second, which drowned the Tauri webview's JS thread and locked up the Receive window mid-transfer. Now gated at 4 MB or 500 ms (whichever first), matching the existing send-side hashing/upload throttling. Same fix prevents the same crash on Windows and Linux too.
- **Receive cache returns to the v0.1.55 design.** The Tauri sidecar no longer sets `ORBITXFER_STORE_DIR` for Receive invocations — only for Send, where per-window FsStore isolation actually matters. As a result, receives now cache in `<destination>.orbitxfer-pieces/` next to the file you're saving (visible, not hidden in `<app-data>`) AND the CLI's existing auto-cleanup deletes that folder after the export completes. No more multi-GB cached copies lingering in `<app-data>` after every receive.
- **Received file always keeps the original filename.** If the share ticket includes a filename and you picked a destination with a different name (e.g. "Untitled" because the save dialog defaulted before you pasted the ticket), the CLI now writes the file with the ticket's filename in the folder you chose. You pick where; OrbitXfer fills in what.
- **Indeterminate-progress hint on Receive.** While the total file size is still unknown (the receive phase, before the export phase reveals it), a small italic note appears under the progress bar — "Total size becomes known once the download finishes — the bar shows activity until then." — so users know the animated bar is expected behavior, not a bug.

## v0.1.63 - 2026-05-20
- **Sleep inhibitor while transferring.** OrbitXfer now holds a cross-platform wake lock for as long as any window in the app has an active send or receive in flight. macOS: `IOKit IOPMAssertionCreateWithName` with `kIOPMAssertionTypeNoIdleSleep` (equivalent to `caffeinate -i`). Windows: `SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)`. Linux: systemd-logind `Inhibit("sleep:idle", …)`. Display sleep is NOT prevented — your screen can still dim — only system idle-sleep is held off, which is the kind that breaks the network.
- A small ☕ badge appears in the header while the lock is held. Text is platform-aware: "Keeping Mac awake" on macOS, "Keeping PC awake" on Windows, "Keeping computer awake" on Linux/other.
- Refcounted: multiple concurrent transfers across multiple windows share one wake lock; the lock is released the moment the count drops back to zero.
- Internal: new `acquire_keep_awake()` / `release_keep_awake()` helpers in `lib.rs`; new `transfer:active` / `transfer:idle` events broadcast to every window so the badge stays consistent across windows. New deps: `keepawake = "0.5"` (Rust), `tauri-plugin-os = "2"` (Rust + JS).

## v0.1.62 - 2026-05-19
- **Full menu bar.** Adds File, View, and Window menus to the OrbitXfer / Edit pair we already had.
  - **File**: New Transfer Window (⌘N), Resume Last Send Transfer, Close Window (⌘W).
  - **View**: Enter Full Screen (^⌘F), Actual Size (⌘0), Zoom In (⌘=), Zoom Out (⌘-).
  - **Window**: Minimize (⌘M), Zoom, plus a dynamic list of every currently-open OrbitXfer window. Each entry is `<title> (<n>)` so windows sharing a title can still be told apart. Selecting an entry brings that window to the front. The list rebuilds automatically when windows open or close.
  - "Resume Last Send Transfer" is always enabled — clicking it when there's no previously saved send shows a friendly "No previous send to resume" banner instead of failing silently.
- **Connection mode** is back. The Send panel now has two radio buttons — "Direct + relay fallback (recommended)" and "Direct only (no relay)" — matching the Electron app's behavior. Selection persists across launches (and across windows) via localStorage. Plumbed through to the sidecar via `ORBITXFER_TICKET_MODE`. The explanatory copy under the radios matches the Electron version: *"Transfers are end-to-end encrypted in both modes. Direct-only disables relay fallback, and is true peer-to-peer with no relay server used."*
- **Real progress counters.** Both Send and Receive panels now show a styled progress box with:
  - phase label ("Hashing" / "Uploading" for sends; "Downloading" / "Writing to disk" for receives),
  - percentage,
  - progress bar (indeterminate when total isn't yet known),
  - `<current> / <total>` bytes with tabular numerals so digits don't dance,
  - transfer speed (bytes/sec) computed over a 5-second rolling window,
  - ETA when the total is known and speed is meaningful.
- New CLI behavior: `start_send` Tauri command now accepts an optional `connection_mode` parameter and forwards it via the `ORBITXFER_TICKET_MODE` env var on the sidecar. Receive sidecars continue to ignore this env var.
- Internal: `build_menu()` extracted as a standalone function so it can be re-invoked on window-open / window-destroy to refresh the Window submenu's dynamic list. `open_new_window` Tauri command added so the frontend's "+ New Window" button goes through Rust (which also triggers the menu rebuild).

## v0.1.61 - 2026-05-19
- **Per-file persistent identity** replaces v0.1.60's single global identity. Every file you send now gets its own iroh identity key, stored under `<app-data>/file-identities/<content-hash>.key`. Same file → same identity → same share ticket (re-send the same file weeks later, get the identical ticket). Different file → *different* identity, so two recipients of different files cannot cross-link to each other through your Node ID.
- Receives stay fully ephemeral as before — receivers don't need a stable identity, and not having one means no fingerprint exposure on the receiving side.
- Reset Identity… dialog text updated to reflect the new behavior — bullets now describe wiping every per-file identity rather than rotating a single global identity. The action itself wipes `<app-data>/file-identities/` entirely.
- One-time cleanup of v0.1.60's `<app-data>/identity.key` on app startup. Existing v0.1.60 users won't have a stale file sitting around after upgrading.
- CLI: new `ORBITXFER_PER_FILE_IDENTITY_DIR` env var. When set, the send flow uses the file's BLAKE3 hash to derive `<dir>/<hash>.key` as the identity location, falling back to legacy `ORBITXFER_KEY_PATH` / ephemeral if not set. Standalone terminal CLI usage without this env var is unchanged (still fully ephemeral by default).

## v0.1.60 - 2026-05-19
- Persistent OrbitXfer identity. The iroh identity key is now stored at `<app-data>/identity.key` and reused across every send. Same file → same share ticket. Old tickets stay live as long as you're actively serving that file in the current session; the FsStore is still wiped between sessions, so old tickets can only fetch blobs you re-pick this session.
- New **OrbitXfer → Reset Identity…** menu item. Confirms via dialog, then: kills every in-flight transfer in every window, deletes `identity.key`, and wipes every per-window store. The next launch generates a fresh Node ID. After a reset:
  - Iroh discovery for the OLD Node ID returns "not found" (after a brief TTL).
  - Any QUIC dial against the OLD Node ID fails at the handshake — the matching private key has been deleted.
  - Recipients holding old tickets can neither probe whether your Mac is on iroh nor reach your endpoint.
- Each window now shows a one-time orange banner after a reset confirming the wipe completed.
- Internal: Tauri sidecar spawns set `ORBITXFER_KEY_PATH=<app-data>/identity.key` so the CLI loads the persistent key instead of generating an ephemeral one each run.

## v0.1.59 - 2026-05-13
- CI macOS notarization fix: `.github/workflows/build.yml` was setting `APPLE_API_KEY` to the .p8 file path (electron-builder convention), but Tauri's bundler uses that env var for the 10-char Key ID and expects the path in `APPLE_API_KEY_PATH`. The workflow now maps the existing repo secrets to Tauri's expected names. Signing already worked in CI; notarization was silently skipping, which made `verify:mac:release` fail at the stapler check.
- CI Windows fix: the "Verify RELEASES.md" step lacked `shell: bash`, so Windows runners (which default to PowerShell) died on bash variable assignment syntax. Now explicitly bash on that step.
- CI macOS signing prep is gated on tag pushes only (`startsWith(github.ref, 'refs/tags/v')`). Regular pushes and PRs skip the Apple notary round-trip and produce ad-hoc-signed builds in ~2 minutes; only tagged releases pay the notarization wait.
- No app or CLI behavior changes vs v0.1.58. First fully CI-built signed + notarized release of the Tauri version.

## v0.1.58 - 2026-05-13
- Desktop GUI rebuilt on Tauri 2 + React + TypeScript, replacing the Electron-based GUI shipped through v0.1.57. App bundle drops from ~150–200 MB to ~33 MB; the runtime no longer carries Chromium; cold start is noticeably faster.
- Sidecar CLI is now isolated per window — each transfer window gets its own `<app-data>/store-<window-label>/` so concurrent transfers across windows can't collide on the shared FsStore. Stale per-window stores from previous app sessions are cleared at startup.
- Behavior preserved across the migration: lenient share-ticket parser (accepts the full `orbitxfer-iroh-cli receive blob… /path` line, not just the bare token), share-line filename preservation with auto-fill destination in the Receive panel, resumable last-send and last-receive (persisted to localStorage, surfaced as Resume pills), quit warnings on Cmd-W and Cmd-Q while a transfer is active, per-window Send/Receive mode switch.
- macOS bundles are signed with the project's Developer ID and notarized by Apple — Gatekeeper accepts the DMG without any bypass on the receiving Mac. Build/sign/notarize flow documented in `OrbitXfer-iroh-tauri/README.md`; per-build env config in `tauri.env.example`.
- Internal: CI workflow (`.github/workflows/build.yml`) ported to Tauri's bundler; existing GitHub Actions secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) carry over and are mapped to Tauri's expected env var names inside the workflow. `scripts/new-release.sh` now validates the Tauri version files.
- Bonus CLI fix bundled in (originally v0.1.57): the standalone `orbitxfer-iroh-cli` watches stdin for EOF and exits when its parent dies. Eliminates the "ticket_hashing_start hangs forever" class of bugs caused by orphan sidecars holding `~/.orbitxfer-store`'s exclusive flock.

## v0.1.57 - 2026-05-08
- CLI now exits when its parent (Electron, Tauri, or terminal) goes away, instead of orphaning and holding the FsStore lock indefinitely. A background thread watches stdin for EOF or read errors and exits the process when the pipe breaks.
- Fixes the recurring "ticket_hashing_start hang" caused by previous orphans still holding `~/.orbitxfer-store/blobs.db` (or any explicit `ORBITXFER_STORE_DIR`).
- Behavior change: piping `</dev/null` into the CLI, or sending Ctrl+D in an interactive terminal, now causes a graceful exit. Send and receive don't read stdin themselves, so this only affects scripted usages that explicitly close stdin.

## v0.1.56 - 2026-04-18
- Configured macOS release builds for hardened runtime, nested CLI signing, and notarization-ready Electron packaging.
- Added a repeatable macOS signing/notarization guide, a local `electron-builder.env.example`, and a `verify:mac:release` check script.
- Updated GitHub Actions so tagged macOS releases now require signing/notarization secrets and validate the finished app before publishing.

## v0.1.55 - 2026-04-17
- Renamed the managed receive store from the hidden `.orbitxfer-store` folder to a visible per-destination folder named `<filename>.orbitxfer-pieces`.
- Updated receive status messaging so the app explicitly says `Downloading into temporary transfer data…` and `Finalizing into destination file…`.
- Kept the existing resume/integrity model intact while making the temporary receive data easier for users to see on disk.

## v0.1.54 - 2026-04-16
- Made receive parsing more forgiving so OrbitXfer can recover wrapped or embedded share tokens from surrounding text instead of rejecting them outright.
- Added renderer-side receive diagnostics so validation failures now explain what was parsed, what destination was selected, and why startup was blocked.
- Expanded receive startup logging with ticket, destination, and store details once the CLI handoff begins.

## v0.1.53 - 2026-04-15
- Added quit/close warnings for active transfers, covering both app quit and individual transfer-window close.
- Added resumable last-send and last-receive recovery with menu actions, in-view buttons, launch-time resume prompts, and persisted token/destination state.
- Fixed resumed transfer counters so OrbitXfer restores saved progress in the UI and the receiver now reports already-downloaded local bytes before download resumes.

## v0.1.52 - 2026-04-14
- Moved the new-window action into `File > New Transfer Window` and removed it from the main interface.
- Added a per-window Send/Receive mode switch so each transfer window shows only one workflow at a time.
- Aligned the Rust crate metadata with the app version and tightened release validation to cover the crate manifest too.

## v0.1.51 - 2026-04-14
- Added multi-window sessions so separate OrbitXfer windows can send and receive files in parallel.
- Routed transfer processes, logs, dialogs, and cleanup state per window instead of sharing one global session.
- Packaging now auto-syncs the latest built CLI into the GUI bundle, the setup docs were refreshed, and release tooling now creates rollback-friendly tagged versions.

## v0.1.50 - 2026-04-13
- Added MB/s counters to upload/download progress.
- Added completion stats (connected time, average speed, total duration).
- Added collapsible log panels and updated connection mode hint.
- Renamed Receive "Output path" label to "Choose Destination".

## v0.1.49 - 2026-04-13
- Added connection mode toggle: Direct-only or Direct + Relay fallback.
- Share tokens now respect the selected mode (ox2 for direct+relay, ox1 for direct-only).
- UI now warns when Direct-only is unavailable due to missing IPs.

## v0.1.48 - 2026-04-12
- Dual-ticket share tokens (ox2) with direct-first and relay fallback.
- Receiver automatically retries with relay when direct fails.
- Per-ticket receive stores with poisoned-store cleanup on failure.

## v0.1.42-binary - 2026-04-13
- Legacy binary-only release (source unavailable).
