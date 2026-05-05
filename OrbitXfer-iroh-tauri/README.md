# OrbitXfer — Tauri GUI (in-progress migration)

This is the Tauri 2 + React + TypeScript replacement for the Electron GUI in `../OrbitXfer-iroh-gui/`.

The Electron version remains the shipping app on `main`. This Tauri version is being built up phase-by-phase on the `tauri-migration` branch. See `RELEASES.md` (repo root) for status.

## Setup

The Tauri app spawns the Rust CLI as a Tauri sidecar. Before running, place the CLI binary at:

```
src-tauri/binaries/orbitxfer-iroh-cli-<host-target-triple>
```

Find your host triple with `rustc -vV | grep host` (e.g. `aarch64-apple-darwin`).

Quickest setup on macOS (uses the binary already shipped with the Electron app):

```sh
cp ../OrbitXfer-iroh-gui/bin/orbitxfer-iroh-cli \
   src-tauri/binaries/orbitxfer-iroh-cli-$(rustc -vV | awk '/host:/ {print $2}')
chmod +x src-tauri/binaries/orbitxfer-iroh-cli-*
```

A proper sync script (matching `OrbitXfer-iroh-gui/scripts/sync-cli.js`) is planned for Phase 4 of the migration.

## Run in dev

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

Bundler config, signing, and CI integration land in Phase 4.

## Migration phase status

- [x] **Phase 1** — Scaffold, sidecar wiring, send flow (file picker → ticket).
- [ ] Phase 2 — Receive flow with progress events.
- [ ] Phase 3 — Multi-window, per-window mode switch, resumable transfers, lenient parser, quit warnings.
- [ ] Phase 4 — Bundler config, macOS signing/notarization, CI workflow, retire Electron app.
