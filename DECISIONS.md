# Decisions

Repo: OrbitXfer

Use this file to record durable project decisions so they do not live only in chat threads.

### 2026-07-18 - OrbitXfer supersedes orelay

- Context: The older `orelay` project evolved into OrbitXfer.
- Decision: Treat OrbitXfer as the active project for peer-to-peer file transfer work.
- Why: This keeps future development, releases, and AI handoffs focused on the maintained codebase.
- Follow-up: Archive or remove `orelay` only after confirming there is no unique state left that should be preserved.

### 2026-07-18 - Use GitHub plus repo-local handoff files

- Context: Work needs to move across multiple local computers and multiple AI coding agents.
- Decision: Use the private GitHub repository as the source of truth, with `AGENTS.md`, `CLAUDE.md`, `CURRENT_WORK.md`, `NEXT_STEPS.md`, and `DECISIONS.md` committed to the repo.
- Why: Git keeps source state exact, while repo-local notes keep Codex and Claude aligned without relying on chat history or consumer file sync.
- Follow-up: Before switching computers or agents, update the handoff files, commit, and push.
