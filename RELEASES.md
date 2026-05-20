# Releases

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
