# Shared Coding Workflow

Use this routine when moving OrbitXfer between computers, Codex, and Claude Code.

## Start On A Computer

```sh
cd /Users/Shared/Orbit/Code/OrbitXfer
git fetch origin
git status --short --branch
git pull --ff-only origin main
```

Then ask the coding agent to read:

- `AGENTS.md`
- `CLAUDE.md` when using Claude Code
- `CURRENT_WORK.md`
- `NEXT_STEPS.md`
- `DECISIONS.md`
- `RELEASES.md` when the task touches releases

Fresh-machine checks:

```sh
cd OrbitXfer-iroh-cli
cargo build --release
cd ../OrbitXfer-iroh-tauri
npm install
npm run prepare:bundle
```

## Handoff Before Switching

1. Update `CURRENT_WORK.md` with what changed, what was validated, and the exact next step.
2. Update `NEXT_STEPS.md` if the queue changed.
3. Update `DECISIONS.md` if a durable project decision was made.
4. Run the relevant check for the work.
5. Commit and push.

```sh
git status --short
git add AGENTS.md CLAUDE.md CURRENT_WORK.md NEXT_STEPS.md DECISIONS.md SHARED_CODING_WORKFLOW.md
git add <changed-source-files>
git commit -m "Describe the completed work"
git push origin main
```

## Branch Discipline

- Use `main` for sequential work when only one computer is active.
- Use a named branch for parallel or risky work.
- Before switching machines, make sure the current branch is pushed.
- On the next machine, pull before opening a coding agent.

## Secrets

Keep tokens, API keys, `.env` files, `tauri.env`, certificates, private keys, notarization assets, dependency folders, and build artifacts out of Git.
