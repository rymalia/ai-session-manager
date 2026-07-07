---
date: 2026-07-06
updated: 2026-07-07
type: next-steps
topic: ai-session-manager markdown export — remaining item F (Phase 1B)
project: ai-session-manager
related:
  - plan-asm-markdown-export-2026-06-12.md
  - adr-markdown-export-2026-07-01.md
  - session-summary-2026-07-02-export-loops-and-codex-doit.md
  - session-summary-2026-07-02-markdown-export-item-b-frontend.md
  - session-summary-2026-07-07-markdown-export-items-cde.md
---

# Next Steps

> **Snapshot of plan §13 as of 2026-07-07.** `docs/plan-asm-markdown-export-2026-06-12.md` §13 and the ADR log (`docs/adr-markdown-export-2026-07-01.md`) are authoritative — if this file disagrees with them, they win.

Based on the plan (§13) and the session summaries listed in `related:` above, items A–E are done and committed. Phase 1A is complete, hardened, and fixture-verified end-to-end. **The only remaining export item is F (Phase 1B)**:

**✅ C — DONE & committed (`3f9ca90`, 2026-07-07): Claude live-main index enrichment (ADR-0015).** `collectEvents` now loads `sessions-index.json` from the project-slug directory and populates the four renderer-visible header fields; the ADR-required overlapping-index fixture is golden-diffed across the full flag matrix plus 6 hermetic child-process variants (tests 102→104/0). Full completion notes in plan §13 item C.

**✅ D+E — DONE & committed (`c40d385`, 2026-07-07): verification fixtures + `ensure_ascii` fix.** `jsonAscii` closes ADR-0009 #2 (byte-verified vs CPython); new ADR-0009 **item 5** enumerates the structurally-unfixable float-formatting divergence; `claude-render-edges.jsonl` golden fixture (unicode/image/equal+missing-ts/clean-vs-verbatim/maxChars boundary); hermetic pins for every ADR-0009 exception; endpoint maxChars-clamp tests; parity matrix 10→12 combos; and a smoke-test `check` helper fix that un-vacuoused ~20 existing checks (tests 104→114/0). Full notes in plan §13 items D and E.

**✅ F1 — DONE & committed (`9fed1aa`, 2026-07-07): resolver + identity contract (ADR-0017, no 1B parsing).** `server/sources/claudeBundle.js` (fail-closed `v1:<slug>:<id>` codec + `resolveBundle()` era logic + `compositeSignature` with its F2 consumer contract pinned in comments), dual-scheme ref acceptance in `claude.js` `detail`/`collectEvents` (path branch byte-unchanged; `not_found` → 404 on both endpoints), and the one-shot versioned `ccv.starred.v1` envelope (`src/starred.js`). `list()` deliberately still emits path refs. Tests 114→127/0; golden parity re-verified. Full completion notes in plan §13.

**F — remaining: loops F2 + F3 (ADR-0017 + §7).**

- **F2 — listing/search integration:** `list()` flips to opaque refs atomically with one card per identity, folder-only/index-only cards, the Claude star-key rewrite (path key → `claude:v1:<slug>:<id>`, a `version: 1→2` bump inside `src/starred.js`), entries gain `cacheSignature: string|null` (`mtimeMs` stays the numeric sort key; search/list invalidate on `cacheSignature ?? mtimeMs` — contract pinned in claudeBundle.js). Constraint: the `list()` refactor must preserve the context-health computation living in `claude.js` (main-transcript-only per ADR-0017).
- **F3 — the 1B converter:** subagents, `history.jsonl` backfill, folder-only/index-only export with `{meta, events, resolvedOpts}`; flip Claude's `sidechains`/`history` capabilities to `supported`; golden diffs on real subagent/history sessions. The ADR-0012 gate is now satisfied — the resolver/identity contract has landed.

A few sequencing notes from the docs:

- **F is a multi-loop effort** — plan it as several `/codex-plan-review` cycles (resolver/identity first, per ADR-0017's hard gate; see the 2026-07-07 session summary's handoff section for a suggested loop breakdown).
- F touches the byte-parity surface, so it needs golden-diff verification via `scripts/export-parity.mjs` — and since ADR-0018 landed on 2026-07-06, any parity run or new fixture asserting rendered timestamps must run under `TZ=UTC`.
- The fuller handoff doc from the item-B session (`/tmp/asm-export-handoff-items-CDEF-2026-07-02.md`) is **gone** (verified 2026-07-06) — the plan doc + ADR log are the surviving sources.
- Current baseline: `main` at `9fed1aa` (loop F1), tracked tree clean, `npm test` 127/0 (verified 2026-07-07).
- **Upstream PR context (2026-07-06):** PRs [#1](https://github.com/daniel-farina/ai-session-manager/pull/1) (context-health, 5 commits) and [#2](https://github.com/daniel-farina/ai-session-manager/pull/2) (package-lock sync) are open against `daniel-farina/ai-session-manager`, cut from base `dfdbf0f` on branches `context-health` / `package-lock-sync`. **All export work is local-only on the fork's `main`** — keep it out of upstream-bound branches. When export is ready to ship upstream, cut it the same way (cherry-pick onto a branch from wherever `upstream/main` sits); conflicts shrink if PR #1 merges first, since context-health will then be in the base.
- **Browser-verification caveat:** port 5191 may be `vite preview` serving a frozen `dist/` (same port + API as dev). Source edits won't appear until `npm run build`; check with `ps -o command= -p $(lsof -nP -iTCP:5191 -sTCP:LISTEN -t)` before concluding a UI change doesn't work. Prefer claude-in-chrome over peekaboo for in-page interaction (per global CLAUDE.md).

Smaller tracked follow-ups (the only other known-open items; not export-blocking):

- **`getConversation`/`ADAPTERS` prototype-name 500 hole** (plan §9) — same class of bug as the fixed `EXPORTERS` dispatch one; left out of the endpoint-hygiene commit because it breaks no 400/500 contract, but explicitly "tracked as a follow-up".
- **Adopt the ADR-0005 clean-prompt split in Codex's `detail()` path** (`startsWith('<environment_context')`) — the ADR says "adopt the same split there eventually"; would also improve list previews.
- *(Optional scope)* the "save to a qmd collection dir" fast-follow (plan §1) — deliberately excluded from the export items since it's the only feature that would break ASM's no-write invariant; needs its own decision first.

If you want to start now, begin with loop F2 (listing/search integration) — the F1 resolver/identity contract landed in `9fed1aa`, so the ADR-0012 gate is open.
