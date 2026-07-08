---
date: 2026-07-06
updated: 2026-07-07
type: next-steps
topic: ai-session-manager — markdown export COMPLETE; remaining follow-ups
project: ai-session-manager
related:
  - plan-asm-markdown-export-2026-06-12.md
  - adr-markdown-export-2026-07-01.md
  - session-summary-2026-07-07-markdown-export-loops-f1-f2.md
---

# Next Steps

> **Snapshot of plan §13 as of 2026-07-07 (post-F3).** `docs/plan-asm-markdown-export-2026-06-12.md` §13 and the ADR log (`docs/adr-markdown-export-2026-07-01.md`) are authoritative — if this file disagrees with them, they win.

## 🎉 The markdown-export feature is COMPLETE

All plan items A–F shipped. The final loop, **F3 (the 1B converter), landed at
`c3cc804` (2026-07-07)**: bundle-wide Claude export — subagent sidechains,
`history.jsonl` backfill (tri-state, exact dedup-key order), folder-only /
index-only recovered-session export via `{meta, events, resolvedOpts}`
(ADR-0014), `sidechains`/`history` capabilities flipped to `supported`,
recovered cards exportable (menu returns via the existing guard). Path refs
mirror the reference's direct-file branch (main-only; subagent files become
sniffed-id bundles; stale paths → 404 on both endpoints). F1 (`9fed1aa`) and
F2 (`96a9ab3`) completion notes, and the full F3 entry, live in plan §13.

**Baseline:** `main` at `c3cc804`, `npm test` **143/0**, golden parity
byte-identical on 6 sessions × 15 flag combos (incl. `--history` /
`--no-history`) under TZ=UTC: pinned main-only (path mode), real
main+8-subagents (`v1:-Users-rymalia-projects-minutes:17279b0b-…`), real
folder-only 261-turn recovery
(`v1:-Users-rymalia-projects-open-asr-leaderboard:4c55e4e4-…`), real
index-only (`v1:-Users-rymalia-projects-claude-code-viewer:3dcc3e53-…`), real
history-heavy (`v1:-Users-rymalia-projects-watchlist:b98b6bd7-…`), plus the
staged adversarial dedup-matrix fixture (smoke-test F3a, snapshot HOME).

Verification commands:

```bash
npm test                                   # 143/0 baseline
node scripts/export-parity.mjs claude ~/.claude/projects/-Users-rymalia-projects/0af8a8ed-51cd-44f8-8afb-9dbd7f1d6337.jsonl
node scripts/export-parity.mjs claude 'v1:-Users-rymalia-projects-minutes:17279b0b-265a-4b18-87fa-6661125e349f'
node scripts/export-parity.mjs codex ~/.codex/sessions/2026/06/30/rollout-*019f1a6e*.jsonl ~/.codex/sessions/2026/06/11/rollout-*019eb994*.jsonl
npm run build
```

## Remaining tracked follow-ups (none export-blocking)

- **`getConversation`/`ADAPTERS` prototype-name 500 hole** (plan §9) — same class
  of bug as the fixed `EXPORTERS` dispatch one; breaks no 400/500 contract but is
  explicitly "tracked as a follow-up".
- **Adopt the ADR-0005 clean-prompt split in Codex's `detail()` path**
  (`startsWith('<environment_context')`) — the ADR says "adopt the same split
  there eventually"; would also improve list previews.
- **Recovered-session previews** (optional): `detail()` for folder-only sessions
  deliberately stays metadata-only (ADR-0017 F2 resolution, reaffirmed in F3) —
  rendering subagent messages in the expanded card would be a new decision.
- **`npm test` hard-requires the Python extractor** (ADR-0010 tension, documented
  in the items-CDE summary's watchdog addendum) — unchanged; the F3a golden check
  also needs `EXTRACT_PY` resolvable.
- *(Optional scope)* the "save to a qmd collection dir" fast-follow (plan §1) —
  deliberately excluded from the export items since it's the only feature that
  would break ASM's no-write invariant; needs its own decision first.

## Upstream / operational notes

- **Upstream PR context:** PRs
  [#1](https://github.com/daniel-farina/ai-session-manager/pull/1) (context-health)
  and [#2](https://github.com/daniel-farina/ai-session-manager/pull/2)
  (package-lock sync) are open against `daniel-farina/ai-session-manager`, cut
  from base `dfdbf0f`. **All export work is local-only on the fork's `main`** —
  keep it out of upstream-bound branches; when shipping export upstream,
  cherry-pick onto a branch from wherever `upstream/main` sits (conflicts shrink
  if PR #1 merges first).
- **Browser-verification caveat:** port 5191 may be `vite preview` serving a
  frozen `dist/` — check
  `ps -o command= -p $(lsof -nP -iTCP:5191 -sTCP:LISTEN -t)` before concluding a
  UI change doesn't work. Prefer claude-in-chrome over peekaboo for in-page
  interaction (per global CLAUDE.md).
- **History-parity determinism:** any parity run with history combos on a LIVE
  session should use a snapshot HOME (copy the project dir + `history.jsonl`
  into a temp HOME, set `HOME` for both sides, pass `EXTRACT_PY` explicitly) —
  the two sides run sequentially and a prompt landing between them would
  produce a false diff. Stale sessions are safe live (their history lines no
  longer grow); the smoke-test F3a golden is fully staged.
