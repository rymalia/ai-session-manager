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
  - kimi-k1-implementation-notes-2026-07-27.md
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

Remaining B-item order after B1/B4 shipped: **3 → 2 → 5/K1**. B3 and B2 both
touch Claude's list parser, so run them serially (or give them to the same
implementer). K2 is a later export phase, not the tail of K1.

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

### B2. Show `model + thinking level` on each session stripe — ✅ **DONE 2026-07-27**

Shipped across `_shared.js` (`makeEntry` gains nullable raw `model`/`effort`),
`claude.js` + `codex.js` (per-adapter extraction), `src/modelLabel.js` (new pure
formatter), `src/App.jsx` (`<ModelBadge>`) and `src/index.css` (`.badge.model`,
width-capped + ellipsized). Live on real data: **4,519 of 10,195** entries carry a
model; Codex sessions carry model+effort 100% of the time, Claude sessions are mostly
model-only exactly as predicted. `<synthetic>` never leaks to a badge.

**Amendment to the ratified decision (2026-07-27).** The B2 decision below placed the
friendly-name map in `server/sources/_shared.js`. It shipped instead as a pure
**`src/modelLabel.js`**, so the API keeps reporting raw values (the
`server/usage.js` honesty rule) and friendly renaming stays presentation-side. This
also matches the established pure-`src/` module pattern (`exportOptions.js`,
`sortConvos.js`, `starred.js`) that `scripts/smoke-test.mjs` already imports. A Codex
plan review judged the new placement "architecturally defensible and preferable" but
correctly flagged that a ratified decision must not be overridden silently — hence
this amendment.

Two further changes came out of that review:
- **Friendly names are a RULE, not a lookup table.** Anthropic ids are structured
  (`claude-<family>-<major>[-<minor>][-<datestamp>]`), so a table would go stale on
  every release. Unknown ids pass through raw, so a new model degrades to
  `gpt-5.7-x`, never to a blank badge.
- **Codex's qualifying record is `turn_context` alone** — the only record carrying
  model and effort together. `session_meta` has a model but never an effort, so it is
  a *fallback only*; letting it write the pair would clear a real effort if a second
  `session_meta` landed after a turn. No local rollout does that today (0 of 310), but
  56 carry more than one `session_meta`, so the ordering is reachable on resume.

<details><summary>Original assessment</summary>

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

*Implementation contract:*
- Replace model + effort as **one last-real-turn pair**. A final turn with a
  model but no effort clears an earlier effort; never carry stale effort across
  a model switch.
- Claude `model:"<synthetic>"` records do not replace the last real model.
- Make the shared entry field explicitly nullable, and keep friendly-name
  formatting pure so known names, unknown passthrough, model-only sessions, and
  synthetic suppression can be fixture-tested.
- Cap the badge width and ellipsize it; an unknown raw identifier must not take
  over the stripe. Recovered Claude cards remain model-less because their
  metadata-only path deliberately does not parse a main transcript.

*Risk:* moderate-*ish* only in cost — Claude's `readSession()`
(`server/sources/claude.js:68`) already streams every line, so both fields are
free to collect there; the mtime cache (`claude.js:105`) means no re-parse cost.
Codex needs the same treatment in its list scan. **Must not touch
`collectEvents`/`server/export.js`** — byte-parity surface.
*Tests:* extend the fixture sessions in `scripts/smoke-test.mjs` with a
model/effort assertion + a "no effort field" (older-session) case.
*Recommend a codex-plan review* — it's the only item that changes the shared
entry contract.

</details>

---

### B3. Show the session **rename** value on the stripe — ✅ **DONE 2026-07-27**

Shipped: `readSession()` now tracks `ai-title` and `custom-title` independently
(each last-wins) and composes them via `composeTitle()` in `server/sources/claude.js`.
The export header's title path (index `summary`) was deliberately left untouched, so
golden parity is unaffected.

**Discovery that changes the framing:** of 46 local sessions carrying a
`custom-title`, **none** also carries an `ai-title` — Claude Code stops emitting
automatic titles once a session is renamed. So `"<custom> | <ai>"` composition
essentially never fires on real data; renames simply now appear where before they
were dropped. The composition is retained as defence (and is fixture-tested with the
adversarial `ai A → custom C → ai B` ⇒ `C | B` order), not because it is the common
path.

<details><summary>Original assessment</summary>

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

</details>
*Tests:* use the adversarial order
`ai-title A → custom-title C → ai-title B` and assert `C | B`; this proves a
newer automatic title cannot erase the rename. Also cover custom-only and
AI-only. Kimi has one authoritative `state.title`; `isCustomTitle` records its
provenance but does not provide a second title to compose.

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

### B5. Add the **Kimi CLI** as a source adapter — ✅ **K1 DONE 2026-07-27**

`server/sources/kimi.js` + `scripts/kimi-adapter-test.mjs` were **implemented by
Kimi k3 itself** (`kimi-first` lanes — deliberate dogfooding), then reviewed and
corrected by Claude. Registered in `server/sources/index.js` with a `SOURCE_META`
entry (`Kimi Code`, cyan `#22d3ee` — the one hue the other nine didn't claim).
Verified live: **29 Kimi sessions** listed, the Stats source bar renders, and
`/api/sources` reports `exportable: false` — correct for K1, since the adapter
deliberately exports no `collectEvents`/`exportCapabilities`.

`npm test` **158/0** with Kimi registered, including the mandatory
`SIBLING`/`*-evil` traversal case. Kimi's own harness is **19/19**.

Bug found in review and fixed: `detail()` derived sidechain provenance from the
wire's sort *rank* (`rank !== 0`), but rank 0 is only the main agent when a main
agent exists — a main-less session would have promoted its first subagent to main
and dropped the provenance marker. Now keyed off the agent name.

**Usage + Agents** also landed (Kimi lane 2): `kind:'consumed'` with an honest
"no remaining-quota stored locally" note, aggregating `usage.record` **only**
(`step.end.usage` would double-count — asserted by fixture), and an Agents-panel
entry (detected `0.28.1`, `kimi upgrade`, 29 conversations). Kimi's totals were
cross-checked against an independent Python sum over the same wire set.

**Security fix found by the Codex adversarial review (Critical).** `isInside()` is
**lexical** — `path.resolve()` does not dereference symlinks, so a symlink planted
inside `~/.kimi-code` pointing outside it passed containment and the external file
was genuinely readable (verified experimentally, not assumed). Kimi's paths all come
from *stored metadata*, which makes this acute. Fixed with realpath-based containment
covering `sessionDir`, `state.json`, each agent `homedir`, and each `wire.jsonl`.
`server/usage.js` had a **second, independent copy** of the lexical check with the
same hole — it now imports the adapter's helper, so there is one implementation.
Three symlink regression tests were added that fail against the pre-fix code.

> ⚠️ **Repo-wide follow-up:** every other file-based adapter (`claude.js`,
> `codex.js`, …) uses the same lexical-only `path.resolve` + `isInside` pattern and
> is therefore open to the same symlink escape. Only Kimi was hardened here, because
> hardening nine adapters (and deciding whether `realpathSync` per file is acceptable
> on Claude's ~10k transcripts) is a deliberate change deserving its own pass. The
> threat requires local write access to the CLI's own state directory, which is why
> this is a follow-up and not a stop-ship.

Kimi's own judgement calls worth knowing: a grouped assistant step carries its
`step.begin` timestamp; refs are rejected on *shape* (`/`, `\`, NUL, leading `.`,
absolute) before any index lookup, with no charset allowlist so future id shapes
keep working; and `lastActivity` counts any valid wire timestamp (including a
trailing `usage.record`) while `firstActivity` counts only message-producing
records — a literal reading of the notes' asymmetric wording.

<details><summary>Original assessment</summary>

*What:* first-class Kimi list/detail/subagent/usage support. The implementation
contract and fixture matrix live in
[`docs/kimi-k1-implementation-notes-2026-07-27.md`](docs/kimi-k1-implementation-notes-2026-07-27.md);
this backlog controls scope/status, while that document carries the parser,
identity, security, caching, and acceptance guidance.

*On-disk format (verified at `~/.kimi-code/`):*
- `session_index.jsonl` — one line per session: `{sessionId, sessionDir, workDir}`.
  It is the discovery index; treat it as append-only input and resolve duplicate
  session ids last-wins.
- `sessions/wd_<slug>_<hash>/session_<uuid>/state.json` — `createdAt`,
  `updatedAt`, `title`, **`isCustomTitle`**, `workDir`, `lastPrompt`, and an
  `agents` map (main + subagents, each with an absolute `homedir`).
- `…/agents/<agent>/wire.jsonl` — canonical user prompts come from
  user-origin `turn.prompt` records; assistant text/thinking/tools come from
  `context.append_loop_event`. `context.append_message` also contains injected
  user-role context, so `flattenText()` alone is not a transcript parser.
- `llm.request` carries model + `thinkingEffort`; `usage.record` carries consumed
  token components. `state.updatedAt` trails live wire activity, so visible
  recency comes from validated wire timestamps, not state metadata alone.
- Resume command: `kimi -S <sessionId>` (`--session`), plus `-c` for
  "continue in this cwd".

*Work items:* adapter (`list`/`detail`) + deterministic subagent merge; source
metadata/registry + Agents-panel entry; model metadata via B2's shared contract;
Usage-panel aggregation as `kind:'consumed'`; search invalidation across every
wire; README/package metadata; hermetic fixtures and traversal tests. Validate
both index-provided `sessionDir` and state-provided agent `homedir` containment —
checking only the caller's `ref` is insufficient.

*Decided (2026-07-27): K1 is first-class integration, not a minimal adapter.*
Its three scopes are (a) list + detail, (b) **subagents folded in** with visible
provenance and deterministic ordering, and (c) a **Usage-panel entry** from
`usage.record` (`kind:'consumed'` — tokens used, not quota; Kimi stores no
remaining-quota snapshot, so do not label it as one).

> ⚠️ **Export caveat that changes the method, not the decision:** every existing
> exporter is validated by byte-diffing against an upstream oracle
> (`scripts/export-parity.mjs` vs `extract-session.py`). Kimi has **no `/replay`
> equivalent** — `kimi export <sessionId>` produces a ZIP archive, not the same
> Markdown. So there is nothing to be byte-identical *to*: Kimi's renderer would
> be a **new, self-defined** output pinned by golden snapshots in
> `scripts/fixtures/` rather than by a parity diff. That's a different (weaker)
> guarantee than ADR-0012/0018 give Claude and Codex, and it deserves its own ADR
> entry before code.

**Split confirmed by the user (2026-07-27):** ship Kimi as **K1** —
list / detail / subagents / usage-panel — and treat **K2 (Markdown export) as an
explicit phase 2**, gated on the golden-snapshot-vs-parity ADR decision above.
K1 is not blocked by it.

*Risk:* moderate for K1. Adapter failure isolation is good, but the transcript
is a multi-file event stream rather than an Anthropic message log; identity,
injected-context filtering, subagent merging, recency, search invalidation, and
metadata-supplied path containment all need fixture coverage. K2 carries the
separate renderer/guarantee risk above.
*Revised size:* K1 ~1–2 focused days. Estimate K2 only after its ADR fixes the
output contract, renderer ownership, capabilities, and filename policy.

</details>

---

## Remaining tracked follow-ups (none export-blocking)

- **Symlink containment across all file-based adapters** (new 2026-07-27) — see the
  K1 entry above. `isInside()` is lexical; `path.resolve()` does not dereference
  links, so a symlink inside a CLI's state dir defeats it. Kimi is hardened
  (`contained()` in `server/sources/kimi.js`); `claude.js`, `codex.js`, `grok.js`,
  `cursor.js`, `gemini.js`, `copilot.js`, `goose.js`, `droid.js` are not. Decide
  whether to lift `contained()` into `_shared.js` and adopt it everywhere, and
  measure the `realpathSync` cost on Claude's ~10k-transcript list path first.

- **`getConversation`/`ADAPTERS` prototype-name 500 hole** (plan §9) — same class
  of bug as the fixed `EXPORTERS` dispatch one. Reject ordinary unknown names
  plus `toString` / `constructor` / `__proto__` through an own-property guard,
  give the error an `unsupported` code, and map it to HTTP 400 in
  `/api/conversation`; pin both direct-dispatch and endpoint behavior.
- **Adopt the ADR-0005 clean-prompt split in Codex's `detail()` path**
  (`startsWith('<environment_context')`) — take user turns only from
  `event_msg/user_message`, keep assistant turns from
  `response_item/message(role=assistant)`, and share the export path's
  `images || local_images` fallback so list/detail/export cannot drift.
- **Recovered-session previews** (optional): `detail()` for folder-only sessions
  deliberately stays metadata-only (ADR-0017 F2 resolution, reaffirmed in F3) —
  rendering subagent messages in the expanded card would be a new decision.
- **`npm test` hard-requires the Python extractor** (ADR-0010 tension, documented
  in the items-CDE summary's watchdog addendum). Make checked-in expected
  Markdown the portable `npm test` gate; move the live Python byte-diff to an
  explicit maintainer parity command that fails clearly when `EXTRACT_PY` is
  unavailable. This also establishes the fixture pattern K2 would need.
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
- **UI-verification caveat:** port 5191 may be `vite preview` serving a
  frozen `dist/` — check
  `ps -o command= -p $(lsof -nP -iTCP:5191 -sTCP:LISTEN -t)` before concluding a
  UI change doesn't work. Either approved local tool is valid: use browser
  tooling when DOM-level inspection is the reliable route, or Peekaboo for
  native UI/evidence captures. Keep screenshots local and never send them to an
  external analysis API.
- **History-parity determinism:** any parity run with history combos on a LIVE
  session should use a snapshot HOME (copy the project dir + `history.jsonl`
  into a temp HOME, set `HOME` for both sides, pass `EXTRACT_PY` explicitly) —
  the two sides run sequentially and a prompt landing between them would
  produce a false diff. Stale sessions are safe live (their history lines no
  longer grow); the smoke-test F3a golden is fully staged.
