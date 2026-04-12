# OrbitXfer

OrbitXfer is a peer‑to‑peer file transfer app built on Iroh, QUIC, and BLAKE3 verified streaming. It ships as a desktop GUI with a Rust CLI under the hood.

## Repo Layout
- `OrbitXfer-iroh-cli/` — Rust CLI responsible for hashing, tickets, and transfer.
- `OrbitXfer-iroh-gui/` — Electron GUI that wraps the CLI.

## Development
### CLI
```bash
cd OrbitXfer-iroh-cli
cargo build --release
```

### GUI
```bash
cd OrbitXfer-iroh-gui
npm ci
npm run build:mac
```

The GUI expects the CLI binary at:
- macOS/Linux: `OrbitXfer-iroh-gui/bin/orbitxfer-iroh-cli`
- Windows: `OrbitXfer-iroh-gui/bin/orbitxfer-iroh-cli.exe`

The GitHub Actions workflow handles this automatically for releases.

## Releases
Build artifacts are published via GitHub Actions (macOS DMG, Windows NSIS, Linux AppImage + .deb).

## License
MIT
