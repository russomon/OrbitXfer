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

The GUI build now auto-syncs the latest CLI binary from `../OrbitXfer-iroh-cli/target/{release,debug}` into `OrbitXfer-iroh-gui/bin/` before packaging.

Packaged builds expect the CLI binary at:
- macOS/Linux: `OrbitXfer-iroh-gui/bin/orbitxfer-iroh-cli`
- Windows: `OrbitXfer-iroh-gui/bin/orbitxfer-iroh-cli.exe`

The GitHub Actions workflow handles this automatically for releases.

## Versioning & Rollback
- Every releasable change should bump the app version and append an entry to `RELEASES.md`.
- `scripts/new-release.sh <version>` now validates the version files, stages the release, commits it, and creates an annotated `vX.Y.Z` tag.
- `scripts/rollback-to-version.sh <version>` restores any tagged release onto a safe rollback branch such as `rollback/0.1.51`.
- Push releases with tags using `git push origin main --follow-tags` so GitHub always has the rollback points.

## Releases
Build artifacts are published via GitHub Actions (macOS DMG, Windows NSIS, Linux AppImage + .deb).

## License
MIT
