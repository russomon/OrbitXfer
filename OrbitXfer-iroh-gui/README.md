# OrbitXfer Iroh GUI

A desktop GUI wrapper around `orbitxfer-iroh-cli`.

## Setup

1. Build the CLI first:

```bash
cd ../OrbitXfer-iroh-cli
cargo build --release
```

2. Install GUI dependencies:

```bash
cd ../OrbitXfer-iroh-gui
npm install
```

3. Run the GUI:

```bash
npm start
```

4. Build a desktop package:

```bash
npm run build:mac
```

## Notes

- The GUI auto-detects the CLI in `../OrbitXfer-iroh-cli/target/{release,debug}/orbitxfer-iroh-cli`.
- Packaging auto-syncs the newest built CLI into `bin/` before `electron-builder` runs.
- Copy `electron-builder.env.example` to `electron-builder.env` if you want a locally signed and notarized macOS release build.
- Use `npm run verify:mac:release` after a signed mac build to check `codesign`, Gatekeeper, and the notarization staple.
- Use `File > New Transfer Window` to open a separate OrbitXfer window for parallel transfers.
- Each window has a Send/Receive mode switch so you can dedicate that window to one role at a time.
- OrbitXfer now warns before quitting or closing a transfer window if a send or receive is still active.
- Resume actions are available both in the app menu and inside the Send/Receive views for the most recent interrupted transfer.
- Downloads use a visible temporary transfer-data folder next to the chosen output path: `<filename>.orbitxfer-pieces`.
- The store directory is passed via `ORBITXFER_STORE_DIR`.
- Full macOS signing and notarization setup lives in `../docs/macos-signing-notarization.md`.
