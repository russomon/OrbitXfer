# OrbitXfer GUI

Tauri 2 + React + TypeScript desktop app. Spawns the Rust CLI (`../OrbitXfer-iroh-cli/`) as a Tauri sidecar.

## Setup

```sh
npm install
npm run prepare:bundle   # build CLI release + sync sidecar + frontend build
```

`prepare:bundle` is a one-shot for fresh clones. After that, the `beforeDevCommand` and `beforeBuildCommand` chains will keep the sidecar slot in sync automatically — you only need to re-run `npm run build:cli:release` if the CLI source changed.

## Run in dev

```sh
npm run tauri dev
```

## Build (unsigned)

```sh
npm run tauri build
```

Outputs:

- `src-tauri/target/release/bundle/macos/OrbitXfer.app`
- `src-tauri/target/release/bundle/dmg/OrbitXfer_<version>_<arch>.dmg`
- (or NSIS `.exe` / AppImage / `.deb` depending on the host)

Without signing env vars set, the macOS bundle is ad-hoc-signed only. That works for local testing but Gatekeeper will block it on other Macs.

## Build (signed + notarized macOS)

One-time:

```sh
cp tauri.env.example tauri.env
# fill in tauri.env with your Developer ID identity, App Store Connect API key
# path/ID/issuer. tauri.env is gitignored.
```

Per build:

```sh
npm run build:mac:signed       # sources tauri.env, runs tauri build
npm run verify:mac:release     # codesign + spctl + stapler checks
```

`tauri.env` uses the same `APPLE_API_*` env var names as electron-builder, so existing CI secrets carry over with no rename. CI maps `CSC_LINK / CSC_KEY_PASSWORD` to Tauri's `APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD` automatically.

## Architecture quick reference

- **Per-file persistent identity**: every file you send gets its own iroh identity key, stored at `<app-data>/file-identities/<content-hash>.key`. Same file → same identity → same share ticket forever (re-sending the same file produces the same ticket the first recipient got). Different file → *different* identity, no cross-linking between recipients of different files. Receives stay ephemeral — a receiver doesn't need a stable identity. Mechanism: the Tauri sidecar passes `ORBITXFER_PER_FILE_IDENTITY_DIR` on Send invocations; the CLI hashes the file first, then loads/creates the per-hash key.
- **Reset Identity… menu item**: under the OrbitXfer app menu. Confirms via dialog, then deletes the entire `file-identities/` directory, kills every active sidecar, and wipes every per-window store. After a reset, every ticket you've previously sent is dead — old recipients can no longer probe whether your Mac is online on iroh, and any attempt to dial an old Node ID fails at the QUIC handshake (matching private keys are gone).
- **Sidecar isolation**: each window's CLI process gets its own `<app-data>/store-<window-label>/` so concurrent transfers don't fight over `~/.orbitxfer-store`. Stale store dirs from previous app sessions are wiped at startup.
- **Quit warnings**: Cmd-W handled via `WindowEvent::CloseRequested`; Cmd-Q handled via a custom Quit menu item (default Tauri Cmd-Q bypasses cancellable events on macOS, so we own the menu).
- **Filename preservation**: tickets carry hash + node ID + relay info but NOT the original filename. Senders display a `orbitxfer-iroh-cli receive <ticket> <basename>` share line that the receiver's lenient parser extracts the filename from. The receive panel auto-fills `~/Downloads/<filename>` so Start Receive Just Works without picking a destination.
- **Resumable transfers**: most-recent send (filePath) and receive (ticketInput, outputPath) persist to `localStorage`, surfaced as "↻ Resume last X" buttons that pre-fill state and auto-start.
