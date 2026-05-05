# Releases

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
