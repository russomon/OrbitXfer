# Agent Guidance

## Project

OrbitXfer is a peer-to-peer file transfer app built on Iroh, QUIC, and BLAKE3 verified streaming. It has a Rust CLI in `OrbitXfer-iroh-cli/` and a Tauri 2 desktop GUI in `OrbitXfer-iroh-tauri/`.

## Start Here

- `README.md` for repo layout and release workflow.
- `RELEASES.md` for release history.
- `CURRENT_WORK.md` for the current handoff state.
- `NEXT_STEPS.md` for the short forward queue.
- `DECISIONS.md` for durable project decisions.
- `SHARED_CODING_WORKFLOW.md` for the cross-computer handoff routine.

## Project Rules

- Treat OrbitXfer as the active successor to `orelay`.
- Keep the CLI as the transfer engine and the Tauri GUI as a wrapper around that CLI sidecar.
- Do not commit packaged app output, copied CLI binaries, `node_modules`, Rust targets, signing credentials, notarization keys, or local `.env` files.
- Releasable changes should bump the app version, update `RELEASES.md`, commit through the release workflow when appropriate, and push tags with the release.

## Useful Commands

CLI:

```sh
cd OrbitXfer-iroh-cli
cargo build --release
```

GUI:

```sh
cd OrbitXfer-iroh-tauri
npm install
npm run prepare:bundle
npm run tauri dev
```

Release helpers:

```sh
scripts/new-release.sh <version>
scripts/rollback-to-version.sh <version>
```

## Done Means

- Keep changes scoped to CLI transfer behavior, GUI wrapping, release packaging, or docs as requested.
- Run the most relevant available check before handoff.
- Update `CURRENT_WORK.md`, `NEXT_STEPS.md`, `DECISIONS.md`, and affected docs before switching computers, agents, or branches.
