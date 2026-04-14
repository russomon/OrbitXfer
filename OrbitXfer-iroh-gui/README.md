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
- Use `New Window` to open a fully separate OrbitXfer session for parallel sends and downloads.
- Downloads use a hidden store folder next to the chosen output path: `.orbitxfer-store`.
- The store directory is passed via `ORBITXFER_STORE_DIR`.
