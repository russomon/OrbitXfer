# OrbitXfer Iroh GUI

A desktop GUI wrapper around `orbitxfer-iroh-cli`.

## Setup

1. Build the CLI first:

```bash
cd /Users/russoanastasio/Code/OrbitXfer-iroh-cli
cargo build --release
```

2. Install GUI dependencies:

```bash
cd /Users/russoanastasio/Code/OrbitXfer-iroh-gui
npm install
```

3. Run the GUI:

```bash
npm start
```

## Notes

- The GUI auto-detects the CLI in `../OrbitXfer-iroh-cli/target/{release,debug}/orbitxfer-iroh-cli`.
- Downloads use a hidden store folder next to the chosen output path: `.orbitxfer-store`.
- The store directory is passed via `ORBITXFER_STORE_DIR`.
