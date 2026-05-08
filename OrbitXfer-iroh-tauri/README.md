# OrbitXfer — Tauri GUI (in-progress migration)

This is the Tauri 2 + React + TypeScript replacement for the Electron GUI in `../OrbitXfer-iroh-gui/`.

The Electron version remains the shipping app on `main`. This Tauri version is being built up phase-by-phase on the `tauri-migration` branch. See `RELEASES.md` (repo root) for status.

## Setup

The Tauri app spawns the Rust CLI as a Tauri sidecar. Build the CLI first, then sync it into the bundler's expected slot:

```sh
npm install
npm run build:cli:release   # cargo build --release in ../OrbitXfer-iroh-cli
npm run sync:cli             # copies into src-tauri/binaries/orbitxfer-iroh-cli-<triple>
```

`npm run prepare:bundle` does all three plus the frontend build in one shot.

## Run in dev

```sh
npm run tauri dev
```

`beforeDevCommand` automatically runs `sync:cli` first, so as long as the CLI release binary exists, the sidecar is in place when the dev binary launches.

## Build (unsigned)

```sh
npm run tauri build
```

Produces `src-tauri/target/release/bundle/macos/OrbitXfer.app` and `bundle/dmg/OrbitXfer_<version>_<arch>.dmg`. Without signing env vars set, the bundle is ad-hoc-signed only — fine for local testing, will trigger Gatekeeper warnings on other machines.

## Build (signed + notarized macOS)

One-time setup:

```sh
cp tauri.env.example tauri.env
# fill in tauri.env with your real Developer ID identity, App Store
# Connect API key path/ID/issuer. tauri.env is gitignored.
```

Then for each build:

```sh
npm run build:mac:signed       # sources tauri.env, runs tauri build
npm run verify:mac:release     # codesign + spctl + stapler checks
```

`tauri.env` uses the same `APPLE_API_*` env var names as electron-builder, so existing CI secrets carry over with no rename. See `tauri.env.example` for the full list.

## Migration phase status

- [x] **Phase 1** — Scaffold, sidecar wiring, send flow (file picker → ticket).
- [x] **Phase 2** — Receive flow with progress + export tracking.
- [x] **Phase 3a/b/c** — Lenient parser, multi-window, per-window mode switch, resumable transfers, quit warnings, per-window store isolation.
- [x] **Phase 4a** — Bundler config + sidecar sync script + verified unsigned macOS build.
- [x] **Phase 4b** — macOS Developer ID signing + notarization config (entitlements, tauri.env, verify script).
- [ ] Phase 4c — CI workflow port.
- [ ] Phase 4d — Retire Electron app.
