---
date: 2026-07-01
type: plan
topic: ai-session-manager per-session context-health badge (Claude Code + Codex)
project: ai-session-manager
target_project: ai-session-manager
status: complete
supersedes: null
related:
  - docs/plan-asm-markdown-export-2026-06-12.md
authors:
  - Codex dev agent (original feature plan, Codex + Claude parity)
  - Claude Code (validation against local transcript data, Claude-side corrections)
---

# Plan: Per-Session Context Health

Add a **context-health badge** to each Claude Code and Codex session card so a
user can judge, at a glance, whether a given session is worth resuming — i.e. how
much of its context window is still free.

- **Codex** shows a *reported* value: `Context 77% left` — Codex persists both the
  numerator (last request's token footprint) and the effective window.
- **Claude** shows an *estimated* value, led by a measured token count (`150k ctx`)
  because Claude transcripts persist per-request token usage but **not** the
  effective window or the auto-compaction threshold.

Cumulative billing/quota metrics and the other seven adapters are **out of scope**
— that framing already lives in `server/usage.js` and is unchanged here.

## Implementation status (completed 2026-07-01)

**Backend complete and independently verified.** The shared helper, Claude and
Codex extraction, conversation-entry contract, usage-parser ownership, and smoke
fixtures are implemented. The final review corrections are also complete:
`finalizeContextUsage()` is null-safe, rejects non-integer `usedTokens`, and the
tracker has regression coverage for missing and malformed usage.

**Frontend complete and independently reviewed.** `ContextBadge` renders before
the message count, uses lowercase compact units, distinguishes reported from
estimated percentages, applies healthy/warning/low/neutral states, and exposes the
same detailed explanation through `title` and `aria-label`. Null context data
renders no badge.

Final verification: `npm test` reports **64 PASS / 0 FAIL**,
`npm run build` passes, and both staged and unstaged `git diff --check` pass.
Three browser-width screenshots confirm desktop and narrow layouts, metadata
wrapping, Codex/Claude notation, and green/amber/red health states.

> **Provenance.** The Codex half of this plan was authored and validated by the
> Codex dev agent against real rollout transcripts. The Claude half was revised by
> Claude Code after validating every claim against ~42k live assistant messages in
> `~/.claude/projects`; §2.2 documents three corrections to the original Claude
> proposal and the on-disk evidence for each.

---

## 0. Evidence base (validated 2026-07-01)

All numbers below come from grepping the user's actual local transcripts, not docs.

**Codex** (`~/.codex/sessions/rollout-*.jsonl`) — the numerator *and* denominator
are both persisted, per rollout, in `event_msg` / `token_count`:

```json
{ "type": "event_msg",
  "payload": { "type": "token_count",
    "info": {
      "total_token_usage": { "...cumulative..." },
      "last_token_usage":  { "total_tokens": 81872, "..." },
      "model_context_window": 353400 } } }
```

- Numerator = `info.last_token_usage.total_tokens` (the last completed request's
  real context footprint, cached input included).
- Denominator = `info.model_context_window` — the **effective** window recorded by
  Codex, which can differ from the model's advertised max (this session recorded
  353,400 while GPT-5.5 advertises ~1,050,000). **Use the recorded value.**
- Model id = latest `turn_context.model`.
- `81,872 / 353,400 → ~77% left`. Marked **`reported`**.

**Claude** (`~/.claude/projects/<enc-cwd>/<id>.jsonl`) — per-request token usage is
persisted on each assistant message; the window is **not**:

```json
{ "type": "assistant",
  "message": { "model": "claude-sonnet-4-6",
    "usage": { "input_tokens": 2417, "cache_creation_input_tokens": 2325,
               "cache_read_input_tokens": 11486, "output_tokens": 234 } } }
```

Confirmed by exhaustive grep across every transcript:

| Finding | Evidence |
|---|---|
| No window / compaction limit is stored anywhere | zero hits for `context_window` / `max_tokens` / `compact*limit` across all files |
| `<synthetic>` and `api_error` assistant messages carry **zero** usage | 907 `<synthetic>` msgs history-wide; every one has `usage {input:0, cc:0, cr:0, out:0}`; in the largest transcript the **last** usage-bearing line was `<synthetic>` |
| The 1M-vs-200k window is **per-session and not recorded** | one `claude-opus-4-8` session peaks at **362,570** input-side (⇒ provably a >200k / 1M-beta window); many `claude-sonnet-4-6` sessions peak at **150k–183k** (indistinguishable between 200k and 1M) |
| Compaction **is** observable | Claude writes `"subtype":"compact_boundary"`, `"isCompactSummary":true`, `"compactMetadata":{"trigger":...}` |
| Model distribution (main-chain, usage-bearing) | sonnet-4-6 ×11,874 · opus-4-7 ×9,467 · opus-4-8 ×8,969 · sonnet-5 ×1,341 · opus-4-6 ×1,094 · `<synthetic>` ×907 · haiku-4-5 ×480 |

**Consequence** driving the Claude design: the same Claude model id runs under
either a 200k or a 1M window depending on tier/beta, and the transcript records
neither. A model→window lookup that assumes 1M therefore over-states remaining
context by up to ~10× on any session that is actually on a 200k window (a 183k
Sonnet session would read as "82% left" when it is really ~8% left and about to
auto-compact) — biased in exactly the wrong direction for a "should I resume?"
signal. §2.2 fixes this by *inferring* the denominator from the session's own token
history (assume the 200k floor; upgrade to 1M only when the tokens prove it) and
leading the display with the measured token count.

---

## 1. Shared context contract

Every conversation entry gains one optional, backward-compatible field. Absent ⇒
the badge is not rendered (never render a misleading `0%`).

```js
contextUsage: {
  usedTokens:   81872,          // last completed request's context footprint
  windowTokens: 353400,         // effective window (reported) or assumed (estimated)
  percentLeft:  77,             // clamped 0..100; may be null when unbounded (Claude)
  measuredAt:   '2026-06-30T21:19:32.702Z',
  model:        'gpt-5.5',
  basis:        'reported',     // 'reported' (Codex) | 'estimated' (Claude)
  windowBasis:  'recorded',     // 'recorded' | 'assumed-200k' | 'observed-1m'
  compactions:  0,              // Claude: count of compact boundaries seen (0 for Codex)
}
```

`usedTokens` always means **the latest completed request's context footprint**
(cached input included) — never cumulative session throughput and never account
quota.

### 1.1 Shared module — `server/contextUsage.js` (new)

`server/contextUsage.js` is a **dependency-light, pure** module (no `node:sqlite`,
no filesystem, no other server imports) and is the **canonical home** for all
context math. It exports three things:

```js
// (1) breakdown primitive — the ONE place the usage field list lives
parseClaudeUsage(u) -> { input, cacheCreate, cacheRead, output }   // ints, 0 default

// (2) final math + validation — shared by the Codex path and the Claude tracker
finalizeContextUsage({ usedTokens, windowTokens, model, measuredAt,
                       basis, windowBasis, compactions }) -> contextUsage | null

// (3) pure stateful reducer for Claude's streaming selection logic
createClaudeContextTracker() -> { push(record), finalize() -> contextUsage | null }
```

**Ownership / imports (do not create a cycle or drag in sqlite).**
`parseClaudeUsage()` lives here, and **both** `server/usage.js` (for all-time
totals) and `server/sources/claude.js` (for the per-session badge) **import it from
`contextUsage.js`**. The adapter must **not** import `server/usage.js` — that module
eagerly constructs `DatabaseSync` and other usage machinery the lightweight adapter
has no business loading. Direction of dependency is one-way: `usage.js → contextUsage.js`
and `claude.js → contextUsage.js`; `contextUsage.js` imports nothing from either.

**`finalizeContextUsage()` semantics:**
- Returns `null` unless `usedTokens` is a finite integer > 0. (This alone kills the
  `<synthetic>` "100% left" bug — a zero-usage selection yields no badge.)
- If `windowTokens` is a finite positive number, compute
  `percentLeft = clamp(round(100 * (1 - usedTokens / windowTokens)), 0, 100)`.
  Otherwise `percentLeft = null` (show raw tokens only).
- Never throws; malformed input ⇒ `null`.

**Why a tracker, not just `finalize()` (correction #3).** `finalizeContextUsage()`
takes *already-computed* numbers, so it can only test the arithmetic — not the
interesting logic: skipping `<synthetic>`/`api_error`, walking back to the latest
valid message, excluding sidechains, tracking `peakInputSide`, and counting
compactions once. `createClaudeContextTracker()` encapsulates exactly that as a pure
reducer over records:

- `push(record)` — ingest one parsed JSONL record (order = file order). Internally it
  maintains: the latest eligible assistant message (`type:'assistant'`,
  `!isSidechain`, real `model`, non-zero usage) as the numerator source; the running
  `peakInputSide` (input-side of eligible messages); and the compaction count.
- `finalize()` — derive `windowTokens`/`windowBasis` from `peakInputSide` (§2.2),
  then delegate to `finalizeContextUsage({ basis:'estimated', … })`.

Because the tracker is pure and record-at-a-time, the streaming adapter feeds it
live lines **and** the smoke fixtures feed it hand-built record arrays — identical
code path, fully deterministic (correction #3, tests in §4a).

**Parser split rationale.** Keeping `parseClaudeUsage()` a *breakdown* (not a
pre-summed scalar) is what lets the two call sites diverge without duplicating the
field list: all-time totals sum all four across every message; context occupancy
sums the same four for the one selected message (Correction B — output included),
while the denominator uses only the three input terms (§2.2 asymmetry).

---

## 2. Source extraction

Both adapters already stream every line of a transcript during their existing
scan (`codex.js` and `claude.js` `readSession`), so this adds **no extra read
pass**. The existing mtime summary caches automatically refresh the badge after a
resumed session appends new events or compacts.

### 2.1 Codex — `reported` (validated, unchanged from original plan)

While scanning a rollout, retain the **last valid** `event_msg` / `token_count`
event and the latest `turn_context.model`:

- `usedTokens   = info.last_token_usage.total_tokens`
- `windowTokens = info.model_context_window`  → `windowBasis: 'recorded'`
- `model        = latest turn_context.model`
- `basis: 'reported'`, `compactions: 0`

Old rollouts with no `token_count` event ⇒ helper returns `null` ⇒ no badge.

### 2.2 Claude — `estimated` (revised; corrections vs the original plan)

The logic below **is** `createClaudeContextTracker()` from §1.1 — the adapter feeds
it each line during its existing scan and calls `finalize()`. The prose here is the
spec; the tracker is where it lives (so it is unit-testable, §4a). Walk the
transcript's main chain, tracking two things:

1. **The numerator.** Select the **latest main-chain assistant message that has a
   real model** (`model` present and `!== '<synthetic>'`) **and** a non-zero usage.
   `<synthetic>` and `api_error` lines are *skipped*, and selection **walks
   backward** to the preceding valid message — it does not stop at `null` unless no
   valid message exists in the whole transcript. Compute the request footprint from
   **all four** usage fields:

   ```
   usedTokens = input_tokens + cache_creation_input_tokens
              + cache_read_input_tokens + output_tokens
   ```

   > **Correction A — skip `<synthetic>`/`api_error`, then fall back.** The original
   > plan said "latest assistant message containing `message.usage`". On real data
   > the last such line is frequently a `<synthetic>` message with all-zero usage,
   > which would render **"Context 100% left"** on a nearly-full session. The fix is
   > to skip synthetic/error lines and select the **latest preceding real-model,
   > non-zero** message; only a transcript with *no* valid message yields `null`.
   > The zero-usage guard in §1.1 is the backstop.

   > **Correction B — include `output_tokens` (revised from the prior draft).** The
   > contract is footprint *after the latest completed request*, and the framing is
   > "should I resume?". On resume, the last assistant turn's output is replayed as
   > conversation history, so it becomes context — omitting it **understates** risk,
   > the unsafe direction. All four fields are counted. (The three input terms alone
   > equal the prompt that was sent; `output_tokens` adds the turn just generated.
   > It is usually a small term — **except with extended thinking**, where thinking
   > counts as output and can be large, which is exactly when the correction bites.)

2. **The denominator — data-driven, not a model lookup.**

   > **Correction C — infer the window from tokens; don't trust a model→window
   > table.** The effective Claude Code window is not recorded in the transcript,
   > and the same model id can run under either a 200k or a 1M window depending on
   > tier/beta. Rather than hard-code a per-model default (which would over- or
   > under-state free context whenever the guess is wrong), observe the session's
   > own token history:

   ```
   // peak uses the INPUT side only (the three prompt terms, no output_tokens):
   // the window bounds how large a prompt can be *sent*, so only the input side is
   // proof of the window. usedTokens (the numerator) still includes output because
   // that measures on-resume footprint, not a send-time bound — the asymmetry is
   // intentional.
   peakInputSide = max over main-chain real-model messages of
                   (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)

   const ASSUMED_WINDOW = 200_000;   // single tunable; raise if a 1M Claude Code
                                     // default is ever confirmed for these models
   windowTokens = (peakInputSide > ASSUMED_WINDOW) ? 1_000_000 : ASSUMED_WINDOW
   windowBasis  = (peakInputSide > ASSUMED_WINDOW) ? 'observed-1m' : 'assumed-200k'
   ```

   Rationale, stated honestly:

   - **`observed-1m` is session-history evidence, not a proven current denominator.**
     A peak input side above 200k proves the session ran a larger-than-200k window
     *at that point* (one real opus-4-8 session peaked at 362,570 — impossible to
     send into a 200k window). It does **not** prove the window is still that large
     at the last message if the model/tier changed mid-session, so treat 1M here as
     a lower-bound inference, not a guarantee.
   - **`assumed-200k` is a conservative heuristic, not a documented fact.** At or
     below a 200k peak the two regimes are indistinguishable from the transcript, so
     the plan assumes the smaller window. This deliberately errs toward *under*-
     stating free context (a false "getting full" nudge) rather than false comfort —
     the safe direction for a "should I resume?" signal. It is **not** a claim that
     200k is Claude Code's official or most-common window; it is the safe floor.

   Because the denominator is inferred from tokens, this is model-agnostic: it works
   for mixed-model sessions and unknown/future model ids without a registry.

   `basis: 'estimated'` always for Claude.

3. **Compaction annotation.** Count **unique `compact_boundary` events** as
   `compactions`; use `isCompactSummary` only as a fallback when no boundary event
   is present, so a single compaction (which emits both markers — verified: 4 of
   each in one tree) is not double-counted. Because the numerator is the *latest*
   real message, it already reflects the post-compaction baseline — the count is for
   the tooltip only ("compacted N× — context shown is since the last compaction").

Unknown / future model ids: still produce a badge (the denominator is observed
from tokens, not the model), but the tooltip names the model as unrecognized.

**Subagent guard.** Never let a sidechain (`isSidechain: true`) message supply the
main-session metric — main-chain only, matching the export adapter's convention.

---

## 3. Card presentation

Add the badge to the existing metadata row, before the message count. It wraps
with the other metadata badges; no expanded-card panel, no responsive regressions.

- **One pill, two parts:** measured token count, then inferred percentage.
  - **Codex (reported):** `100k ctx · 77% left` — both parts measured, no `~`.
  - **Claude (estimated):** `150k ctx · ~25% left` — the token count is measured
    (no `~`); only the percentage carries `~` because the denominator is inferred.
  - When `percentLeft == null` (no bounded window), show the token part alone:
    `150k ctx`.
- **Color is driven by `percentLeft`** (not the token count): healthy ≥ 50%,
  warning 20–49%, low < 20%. When `percentLeft == null`, render neutral.
- **Omit** the badge entirely when `contextUsage` is `null`. No `0%`, no
  model-family guess.

**Tooltip contents:**
- Raw `used / window` token values.
- Model, when known.
- Basis line: `Reported by Codex` or
  `Estimated — Claude stores no window; assumed 200k` /
  `…observed 1M from this session`.
- Last-recorded timestamp (`measuredAt`).
- For Claude: an explicit note that this is **not** Claude Code's configurable
  auto-compaction threshold, and (if `compactions > 0`) the compaction count.

---

## 4. Verification

This project has **no separate unit-test framework** — `npm test` is the single
`scripts/smoke-test.mjs`. "Tests" below therefore means **deterministic
assertions added to that script**, in two groups.

**(a) Fixture assertions** — hardcoded inline inputs (never the user's transcripts),
deterministic regardless of local data. The Codex arithmetic feeds
`finalizeContextUsage()` directly; every Claude selection/peak/compaction case feeds
hand-built record arrays through `createClaudeContextTracker().push()` →
`finalize()`, i.e. the exact code path the adapter uses.

> **Pick non-boundary numbers.** Avoid `usedTokens` that lands a percentage on an
> `x.5` rounding edge — e.g. `155,000 / 200,000`, which is exactly `22.5%` under
> integer arithmetic but evaluates to `22.499999999999996` via `1 - u/w`, so
> `Math.round` gives `22`. The value is deterministic in V8, but its result flips
> with algebraic refactoring of the formula — a brittle fixture. Use values whose
> result is unambiguous (`0.25` is exact in binary).

- Codex sample (`finalizeContextUsage` direct): `81,872 / 353,400 → 77`,
  `basis:'reported'`, `windowBasis:'recorded'`.
- Claude 200k assumed (via tracker): a real-model message summing (all four fields)
  to `150,000`, peak ≤ 200k → `windowTokens:200000`, `windowBasis:'assumed-200k'`,
  `percentLeft:25`.
- Claude 1M observed (via tracker): a session whose peak input side is `362,570` →
  `windowTokens:1000000`, `windowBasis:'observed-1m'`.
- `output_tokens` **is counted** in `usedTokens` (regression guard for Correction B):
  same message with vs without a large output turn yields different `usedTokens`.
- **Fallback, not `null`:** a record array whose *last* line is `<synthetic>` (or
  `api_error`) but which has an earlier valid message → tracker selects that earlier
  message (regression guard for Correction A). `null` **only** when *no* valid
  message exists anywhere.
- Cached input contributes (`cache_read` + `cache_creation` counted).
- Sidechain (`isSidechain:true`) messages never selected as the numerator.
- Malformed / missing usage on an otherwise-valid line → skipped; whole-transcript
  with none valid → `null`.
- `finalizeContextUsage(null | undefined | non-object)` → `null`, never throws;
  fractional `usedTokens` are rejected rather than rounded or floored.
- `usedTokens >= windowTokens` → `percentLeft` clamps to `0`, not negative.
- Two markers for one compaction (`compact_boundary` + `isCompactSummary`) →
  `compactions === 1`, not 2 (regression guard for the count-once rule).

**(b) Real-data shape checks** (existing smoke-test style): for every available
Claude/Codex entry, assert `contextUsage` is either `null` or a well-formed object
— integer `usedTokens`, `windowTokens` positive-or-null, `percentLeft` in `0..100`
or null, `basis ∈ {reported, estimated}`, `windowBasis` valid, ISO `measuredAt`.

**Manual browser QA:** at `http://localhost:5191/`, verify healthy / warning / low /
estimated / missing-data / narrow-screen badge states. Run `npm test` and
`npm run build`.

**Final result (2026-07-01):** `64 PASS / 0 FAIL`; production build passes; staged
and unstaged diff checks are clean. Three captured browser widths verify responsive
wrapping and the reported/estimated green, amber, and red badge states. Tooltip
branches, null omission, observed-1m wording, compaction annotation, lowercase
units, and accessible labeling were verified against the rendered data and code.

---

## 5. Assumptions & known limitations

- **"Context left" = remaining capacity after the latest completed request**, not
  cumulative session tokens and not account quota.
- **After compaction** the latest request is the new baseline; a higher percentage
  is expected and correct.
- **Codex is exact; Claude is a bounded estimate.** For Claude, `usedTokens` is
  exact but `windowTokens` is inferred: `observed-1m` is a lower-bound inference
  from the session's own token history (not guaranteed current), and `assumed-200k`
  is a conservative floor that may under-state free context on an undetected 1M
  session (the safe direction). The measured token count is the durable truth; the
  `~%` is advisory.
- **Not the auto-compact threshold.** Claude Code auto-compacts *before* the raw
  window is exhausted, but that threshold is configurable and is **not** recorded in
  transcripts, so the badge deliberately reports raw-window occupancy — clearly
  labelled — and makes no claim about distance-to-compaction.
- **No network, no new endpoint.** The registry stays local and explicit; the
  existing `/api/conversations` response gains one optional, backward-compatible
  field.

---

## 6. Out of scope

- The other seven adapters (opencode, Grok, Cursor, Gemini, Copilot, Goose,
  Droid) — no context badge; unchanged.
- Cumulative billing / cost / all-time token totals — already handled honestly in
  `server/usage.js`; untouched.
- Any attempt to reconstruct or configure the auto-compaction threshold.

---

## 7. Execution record

1. **Presentation component — complete.** `ContextBadge` is in the card metadata
   row before message count and omits null data.
2. **Display contract — complete.** Lowercase compact units, reported/estimated
   notation, raw-token fallback, and all four color states are implemented.
3. **Accessible detail — complete.** Tooltip content is shared through `title` and
   `aria-label`, including exact values, model, basis, timestamp, Claude caveat,
   and compaction count.
4. **Feature styling — complete.** `.ctx-*` states preserve the existing badge
   contract and metadata wrapping.
5. **Automated verification — complete.** `npm test`, `npm run build`, and staged
   and unstaged diff checks pass; non-Claude/Codex adapters remain null.
6. **Visual QA — complete.** Three browser widths cover desktop and narrow layouts,
   reported and estimated labels, green/amber/red states, and metadata wrapping.
7. **Plan closure — complete.** Final evidence is recorded and status is
   `complete`.
