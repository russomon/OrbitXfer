# Releases

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
