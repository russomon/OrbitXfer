# Current Work

Repo: OrbitXfer
Updated: 2026-07-18T14:05:00-07:00
Machine: Mac M4 mini
Mode: active

Use this file for the active handoff state that should survive machine switches and chat history gaps.

## Focus

- Current branch: main
- Active task: Standardize the shared coding environment across computers and AI agents.
- Immediate next action: On the next feature or release task, pull `origin/main`, read `AGENTS.md`, `CLAUDE.md`, `CURRENT_WORK.md`, `NEXT_STEPS.md`, and `DECISIONS.md`, then proceed in OrbitXfer rather than `orelay`.

## Notes

- Latest remote state seen during this setup: `v0.1.98` work on `origin/main`, with release tags through `v0.1.84`.
- Current architecture: Rust CLI transfer engine plus Tauri 2 GUI sidecar wrapper.
- OrbitXfer is the active evolution path for the older `orelay` work.
- GitHub remote is configured at `https://github.com/russomon/OrbitXfer.git`.
- The local shared-agent docs commit was rebased onto the newer remote history before push.
- Shared agent guidance files were added on 2026-07-18.

## Handoff

- Safe stopping point: repo guidance and handoff files are ready for cross-computer use.
- Risks or open questions: confirm whether the obsolete `orelay` GitHub repo should be archived and whether its local checkout should be removed after any unique untracked notes are reviewed.
- Who should pick this up next: Current OrbitXfer maintainer
