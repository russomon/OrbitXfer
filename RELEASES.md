# Releases

## v0.1.49 - 2026-04-13
- Added connection mode toggle: Direct-only or Direct + Relay fallback.
- Share tokens now respect the selected mode (ox2 for direct+relay, ox1 for direct-only).
- UI now warns when Direct-only is unavailable due to missing IPs.

## v0.1.48 - 2026-04-12
- Dual-ticket share tokens (ox2) with direct-first and relay fallback.
- Receiver automatically retries with relay when direct fails.
- Per-ticket receive stores with poisoned-store cleanup on failure.

## v0.1.42-binary - 2026-04-13
- Legacy binary-only release (source unavailable).
