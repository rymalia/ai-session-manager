---
date: 2026-07-06
type: adr-log
topic: ai-session-manager context-health badge — decisions
project: ai-session-manager
related:
  - plan-asm-context-health-2026-07-01.md
---

# ADRs: Per-Session Context Health

Decisions governing the context-health estimate (`server/contextUsage.js`).
The feature's original design record is the plan doc above; this log holds
decisions made after it shipped.

## ADR-CH-0001 — Claude window default is 1M since 2026-03-14 (Haiku stays 200k)

**Status:** Accepted (2026-07-06)

- **Decision:** For Claude sessions the estimated denominator resolves in this
  order:
  1. **Observed evidence** — a peak input side above 200k in the session's own
     usage history proves a 1M window ran (any model, any date) →
     `windowBasis: 'observed-1m'`.
  2. **Model + date default** — non-Haiku sessions (Opus, Sonnet, Fable) whose
     last valid assistant message is on/after **2026-03-14** assume 1M →
     `'assumed-1m'`. A missing timestamp is treated as current.
  3. **Legacy floor** — Haiku sessions (model id matches `/haiku/i`), and any
     session ending before the cutover, assume 200k → `'assumed-200k'`.
- **Why:** Claude Code's default context window became 1 million tokens on
  March 14, 2026 for all models except Haiku. The original conservative
  200k-unless-proven assumption (written before the cutover was confirmed)
  systematically understated remaining context — sessions showed "~20% left"
  that actually had ~84% of a 1M window free, defeating the badge's purpose of
  hinting whether a resume is worthwhile.
- **Consequence:** `windowBasis` gains the `'assumed-1m'` value; the UI tooltip
  distinguishes all three estimated bases, and the shape check in
  `scripts/smoke-test.mjs` accepts it. The date gate compares the Z-suffixed
  ISO `measuredAt` lexicographically against `'2026-03-14'`. Percentages remain
  `basis: 'estimated'` (with the `~` prefix) — this is still an assumption, not
  a recorded window; Codex remains the only source with a recorded window. If
  Anthropic changes defaults again, this is the one constant/table to update
  (`ONE_M_DEFAULT_SINCE` in `contextUsage.js`).
