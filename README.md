# OrbitXfer

OrbitXfer is a peer‑to‑peer file transfer app built on Iroh, QUIC, and BLAKE3 verified streaming. It ships as a desktop GUI with a Rust CLI under the hood.

## Repo Layout

- `OrbitXfer-iroh-cli/` — Rust CLI responsible for hashing, tickets, and transfer.
- `OrbitXfer-iroh-tauri/` — Tauri 2 desktop GUI (React + TypeScript). Wraps the CLI as a sidecar.

The GUI was migrated from Electron to Tauri across the `tauri-migration` branch; see commit history for the phased rollout. The shipping app on `main` is now the Tauri build.

## Development

### CLI

```bash
cd OrbitXfer-iroh-cli
cargo build --release
```

### GUI

```bash
cd OrbitXfer-iroh-tauri
npm install
npm run prepare:bundle      # builds CLI + syncs sidecar + frontend build, in one shot
npm run tauri dev           # or `npm run tauri build` for a release bundle
```

The GUI's `beforeBuildCommand` and `beforeDevCommand` automatically run `sync:cli` so the sidecar binary lands in `src-tauri/binaries/orbitxfer-iroh-cli-<host-target-triple>` before the Tauri bundler runs.

## Versioning & Rollback

- Every releasable change should bump the app version and append an entry to `RELEASES.md`.
- `scripts/new-release.sh <version>` validates the version files (Cargo.toml, src/main.rs, package.json, package-lock.json, tauri.conf.json), stages the release, commits it, and creates an annotated `vX.Y.Z` tag.
- `scripts/rollback-to-version.sh <version>` restores any tagged release onto a safe rollback branch such as `rollback/0.1.57`.
- Push releases with tags using `git push origin main --follow-tags` so GitHub always has the rollback points.

## macOS Release Signing

OrbitXfer macOS releases are configured for Developer ID signing, hardened runtime, and notarization via Tauri's bundler.

- Local signed builds: `cp OrbitXfer-iroh-tauri/tauri.env.example OrbitXfer-iroh-tauri/tauri.env`, fill in your real values, then `npm run build:mac:signed`.
- Verify: `npm run verify:mac:release` (runs `codesign --verify --deep --strict / spctl / xcrun stapler validate` against the bundled `OrbitXfer.app`).
- See `OrbitXfer-iroh-tauri/README.md` for the full setup.
- CI uses the same secret names as before (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); the workflow remaps `CSC_LINK / CSC_KEY_PASSWORD` to Tauri's `APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD` env vars internally.

## Releases

Build artifacts are published via GitHub Actions:

- macOS: signed + notarized DMG (arm64 / x86_64 depending on the runner)
- Windows: NSIS installer (`.exe`)
- Linux: AppImage + `.deb` (additionally `.rpm` if Tauri's bundler is configured for it)

## License

MIT
