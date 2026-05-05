# OrbitXfer Iroh CLI Prototype

A minimal CLI prototype that uses **iroh + iroh-blobs** (BLAKE3 verified streaming over QUIC) to transfer a file between two peers.

## Requirements

- Rust (latest stable recommended)

## Run

From this directory:

```bash
cargo run -- send ./path/to/file
```

The command prints a ticket. On another machine (or terminal):

```bash
cargo run -- receive <TICKET> ./output/file
```

## Storage

This prototype uses `FsStore` (disk-backed) instead of `MemStore`, so large files do not need to live in memory. OrbitXfer receives now default to a visible temporary transfer-data folder next to the chosen destination file: `<filename>.orbitxfer-pieces`. You can still override the store location with:

```bash
ORBITXFER_STORE_DIR=/path/to/store cargo run -- send ./path/to/file
```

## Notes

- `FsStore` requires the `fs-store` feature flag on `iroh-blobs`.
- Export uses `ExportMode::TryReference` for efficient handoff when possible.

## Next steps (if you want)

- Add progress reporting using the `DownloadProgress` stream.
- Add resumable transfers using range requests.
- Wrap this CLI in a small daemon to bridge into Electron later.
