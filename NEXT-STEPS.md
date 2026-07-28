---
date: 2026-07-06
updated: 2026-07-27
type: next-steps
topic: ai-session-manager — markdown export COMPLETE; backlog of UI/source follow-ups
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

## Backlog — UI + source requests (added 2026-07-27)

Five user-requested items, each with a first-pass assessment grounded in the
actual code/data (`file:line` cited; data claims verified against real local
transcripts). Sizes are implementation + smoke-test + verification, not
including a codex-plan-review loop (add ~45 min each where noted).

Suggested order: **4 → 1 → 3 → 2 → 5** (cheapest/highest-confidence first;
item 2 depends on nothing but is the widest blast radius of the four UI items).

---

### B1. Tooltips on every Export-popover option — ✅ **DONE 2026-07-27**

Shipped: `hint` per row in `FLAG_ROWS`, plus `FULL_HINT` / `HISTORY_HINT` /
`MAXCHARS_HINT`, composed with the pre-existing state note by `optTitle()`
(`"<definition> · <state>"`). Verified in-page: all 11 options carry a title, and
an unsupported flag reads e.g. *"…tagged [sidechain] · Not applicable to this
source"*. Stale `capNote`/`capTitle` "Phase 1B" strings replaced with
"not yet" / "Not implemented for this source yet". `npm test` 143/0.

<details><summary>Original assessment</summary>

*What:* hover definitions for Tools / Tool results / Thinking / Sidechains /
Verbatim / Raw / Embed images / History / Max chars, so the flags are
self-explanatory.

*Where:* `src/ExportMenu.jsx:13` (`FLAG_ROWS` — add a `hint` per row),
`ExportMenu.jsx:257` (the row's existing `title` attribute),
`ExportMenu.jsx:276+` (History `<select>` + maxChars field, currently untitled).

*Findings:*
- The `title` slot on each row is **already occupied** by capability messaging
  (`capTitle()`, `ExportMenu.jsx:33`) and by `'Included by Full'` when Full
  implies the flag. So this is a *composition* problem, not a new attribute:
  definition first, then the state note (e.g. `"Thinking — the model's internal
  reasoning blocks (💭). · Included by Full"`).
- Definitions must match what `server/export.js` actually renders, not what the
  labels suggest — `raw` is "body only, no session header", `verbatim` bypasses
  the `maxChars` truncation, `sidechains` = subagent transcripts. Source them
  from the `/replay` flag semantics in `docs/adr-markdown-export-2026-07-01.md`
  so the copy can't drift from behavior.
- **Free fix while in here:** `capTitle()`/`capNote()` still say
  *"A /replay feature coming in Phase 1B"* / `"in 1B"` (`ExportMenu.jsx:30-36`).
  Phase 1B (F3) shipped at `c3cc804`; for Claude those states no longer occur,
  but the strings are now misleading for any future `unavailable` capability.

*Risk:* none (presentational). No server change, no parity surface.
*Tests:* none required; `npm run build` + one visual check.

</details>

---

### B2. Show `model + thinking level` on each session stripe — **M, ~3–4 h**

*What:* a badge left of `N msgs` reading e.g. `Fable 5 xhigh`, `Opus 4.8 medium`,
`gpt-5.6-sol high`.

*Where:* new field through `makeEntry()` (`server/sources/_shared.js:117`) →
per-adapter extraction → new badge at `src/App.jsx:292` (before the msgs badge)
+ a `.badge.model` style in `src/index.css`.

*Data availability (verified locally):*
| Source | Model | Effort/thinking | Notes |
|---|---|---|---|
| Claude | `message.model` on `assistant` records (e.g. `claude-opus-5`, `claude-fable-5`) | **top-level `effort`** on `assistant` records (e.g. `"effort":"high"`) | `effort` is a *recent* field — present in 152 of ~9k local transcripts; older sessions will show model only |
| Codex | `turn_context.model` | `turn_context.effort` (also `reasoning_effort` in config records) | per-turn; `gpt-5.6-sol` / `high` confirmed |
| Kimi (see B5) | `llm.request.model` | `llm.request.thinkingEffort` | best-supported of all three |
| grok / cursor / opencode / gemini / copilot / goose / droid | varies, mostly unverified | mostly absent | treat as best-effort; null ⇒ no badge |

*Decided (2026-07-27):* **friendly label, last turn wins** — `claude-opus-5` →
`Opus 5`, rendered as `Opus 5 high`; the final assistant turn's model+effort is
authoritative when a session switches models mid-way. Friendly names come from a
small map in `_shared.js` with **raw-id passthrough for unknowns** (so a new
model degrades to `gpt-5.7-x high`, never to a blank badge); the raw id goes in
the badge's `title=` tooltip. Sessions with no `effort` record show the model
alone; sessions with neither show no badge.

*Risk:* moderate-*ish* only in cost — Claude's `readSession()`
(`server/sources/claude.js:68`) already streams every line, so both fields are
free to collect there; the mtime cache (`claude.js:105`) means no re-parse cost.
Codex needs the same treatment in its list scan. **Must not touch
`collectEvents`/`server/export.js`** — byte-parity surface.
*Tests:* extend the fixture sessions in `scripts/smoke-test.mjs` with a
model/effort assertion + a "no effort field" (older-session) case.
*Recommend a codex-plan review* — it's the only item that changes the shared
entry contract.

---

### B3. Show the session **rename** value on the stripe — **S, ~1 h**

*What:* surface a user-renamed session title.

*Findings:* Claude Code writes two distinct title records into the transcript —
`{"type":"ai-title","aiTitle":…}` (auto-generated) and
**`{"type":"custom-title","customTitle":…}` (the user's rename)**. Verified
locally: 7,503 `ai-title` records vs 760 `custom-title`. The adapter today reads
**only** `ai-title` (`server/sources/claude.js:83`) — so renames are invisible.

*Where:* `claude.js:83` (capture `custom-title` too, last-wins), then either
override `summary.title` or carry it as a separate `customTitle` entry field
through `makeEntry()` and render at `src/App.jsx:286`.

*Decided (2026-07-27):* **compose both into one card title** —
`"<customTitle> | <aiTitle>"`, then feed that combined string through the
existing title path unchanged (same `makeEntry` handling, same CSS truncation at
`src/App.jsx:286`). When only one of the two exists, use it alone — never emit a
dangling `|`. Rename wins the left/most-visible position.

*Constraint:* the export header's title comes from the index `summary`
(`claude.js:560`), **not** from this path — leave it alone or the golden parity
diffs break.
*Tests:* one fixture with `custom-title` after `ai-title`, asserting precedence.
Also worth confirming Kimi's equivalent (`state.json.isCustomTitle`, B5).

---

### B4. Stats: both horizontal bar charts render empty — ✅ **DONE 2026-07-27**

Fixed with two `display: block` declarations in `src/metrics.css`; verified live
at `localhost:5191` (Claude's bar full-width at 9,853, Codex a sliver at 306,
Top-projects bars proportional). Root cause below, kept because it's a trap that
recurs anywhere a `<span>` fill sits inside a blockified track.

<details><summary>Diagnosis</summary>

*Root cause:* the bar **fills** are `<span>`s that never get `display:block`.
`.mx-bar-track` / `.mx-proj-bar` are grid items (`src/metrics.css:73`, `:124`)
so CSS *blockifies* them — which is why the grey tracks are visible. Their
children `.mx-bar-fill` (`metrics.css:101`) and `.mx-proj-fill` (`:144`) are
plain inline spans, and `width`/`height`/`min-width` **do not apply to
non-replaced inline elements** — so every fill computes to zero size and
disappears. The vertical "Activity over time" chart is unaffected because it's
SVG `<rect>`s. This matches `docs/images/stats-panel.png` exactly: tracks drawn,
zero fill, all rows identical regardless of value.

*Fix:* add `display: block;` to `.mx-bar-fill` and `.mx-proj-fill`
(2 lines, `src/metrics.css`). No JS change — `Metrics.jsx` computes `pct`
correctly already.
*Tests:* visual only; confirm Claude's bar is full-width and opencode's is a sliver.

</details>

---

### B5. Add the **Kimi CLI** as a source adapter — **M, ~4–5 h**

*What:* `server/sources/kimi.js` + registry + `SOURCE_META`, per the documented
three-function adapter contract.

*On-disk format (verified at `~/.kimi-code/`):*
- `session_index.jsonl` — one line per session: `{sessionId, sessionDir, workDir}`.
  A ready-made discovery index (cheaper than a tree walk).
- `sessions/wd_<slug>_<hash>/session_<uuid>/state.json` — `createdAt`,
  `updatedAt`, `title`, **`isCustomTitle`**, `workDir`, `lastPrompt`, and an
  `agents` map (main + subagents, each with its own `homedir`).
- `…/agents/main/wire.jsonl` — the transcript. Relevant record types:
  `context.append_message` (`{role, content[], toolCalls[]}` — Anthropic-ish, so
  `flattenText()` should mostly work), `turn.prompt`, `llm.request`
  (`model`, `modelAlias`, `thinkingEffort` → feeds B2), `usage.record`
  (`inputOther`/`output`/`inputCacheRead`/`inputCacheCreation` → could feed the
  Usage panel as `kind:'consumed'`), `context.append_loop_event`.
- Resume command: `kimi -S <sessionId>` (`--session`), plus `-c` for
  "continue in this cwd".
- Scale here today: **37 sessions** — small, so no perf pressure.

*Work items:* adapter (`list`/`detail`) + `flattenText` wiring; `SOURCE_META`
entry (label/short/**color** — needs a pick); registry line
(`server/sources/index.js:16`); `isInside` containment against `~/.kimi-code`;
**smoke-test `SIBLING` map entry + the `*-evil` traversal case** (mandatory per
CLAUDE.md); optional `server/usage.js` entry.

*Decided (2026-07-27): full first-class integration, not a minimal adapter.* All
four sub-scopes are in: (a) list + detail, (b) **subagents folded in** (the
`agents` map in `state.json` is the resolver input — closer to Codex's shape than
to Claude's bundle/opaque-ref machinery, so model it on `codex.js`), (c) a
**Usage-panel entry** from `usage.record` (`kind:'consumed'` — tokens used, not
quota; Kimi stores no remaining-quota snapshot, so do not label it as one), and
(d) **Markdown export**.

> ⚠️ **Export caveat that changes the method, not the decision:** every existing
> exporter is validated by byte-diffing against an upstream oracle
> (`scripts/export-parity.mjs` vs `extract-session.py`). Kimi has **no `/replay`
> equivalent** — `kimi export <sessionId>` produces a ZIP archive, not the same
> Markdown. So there is nothing to be byte-identical *to*: Kimi's renderer would
> be a **new, self-defined** output pinned by golden snapshots in
> `scripts/fixtures/` rather than by a parity diff. That's a different (weaker)
> guarantee than ADR-0012/0018 give Claude and Codex, and it deserves its own ADR
> entry before code. Consider splitting Kimi into **K1** (list/detail/subagents/
> usage) and **K2** (export) so K1 isn't gated on that decision.

*Risk:* low for K1 — adapters are isolated by design and a throwing adapter is
caught (`index.js:28`). The security surface is the one thing that must not be
skipped. K2 carries the design risk above.
*Revised size:* K1 ~4–5 h, K2 ~4–6 h + ADR.

---

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
