---
date: 2026-07-01
type: adr-log
topic: ai-session-manager markdown export (/replay parity) — decisions
project: ai-session-manager
related:
  - plan-asm-markdown-export-2026-06-12.md
  - assessment-ai-session-manager-2026-06-12.md
  - /Users/rymalia/projects/claude-session-tools/plugins/session-tools/scripts/extract-session.py
---

# ADRs: Session → Markdown Export

A simple list of architecture decisions clarified while prototyping the export
feature, for the dev lead to fold back into `plan-asm-markdown-export-2026-06-12.md`.
Each entry is **Decision / Why / Consequence**.

## Implementation status (as of this log)

Built and **byte-verified** against `/replay`:

| Piece | File | State |
|-------|------|-------|
| Codex `collectEvents` | `server/sources/codex.js` | Done — port of `load_codex_events` |
| Shared renderer | `server/export.js` (new) | Done — port of `render_event` + header + `summarize_tool_use` |
| Registry / capability | `server/sources/index.js` | Done — `EXPORTERS`, `exportCapableSources`, `collectEvents` |
| `/api/export` + `/api/sources.exportable` | `vite.config.js` | Done |
| Claude `collectEvents` (main transcript) | `server/sources/claude.js` | **Not yet** — renderer already supports it (1A remainder) |

Verification: rendered the real Codex session `019f1a6e…` through the JS path and
diffed against the Python extractor across **9 flag combinations**
(`--full`, default, `--thinking`, `--tools --tool-results`, `--tools --max-chars 200`,
`--full --max-chars 80`, `--raw --full`, `--verbatim --full`, `--tools --thinking`) —
**all byte-identical**. `npm test` still passes 26/0.

---

## ADR-0001 — Reimplement in Node; do not shell out to `extract-session.py`
- **Decision:** Port the renderer to plain JS (no Python dependency, no `execFile`).
- **Why:** `extract-session.py` is **Claude-only** (walks `~/.claude/projects`) so it
  can't serve Codex at all; shelling out would add a Python runtime dep and an
  `execFile` surface ASM deliberately confines to `agents.js`/`open.js`.
- **Consequence:** Two implementations of the same logic → drift risk, mitigated by
  ADR-0010 (golden-diff tests). Revisit only if a second JS consumer appears, at
  which point a shared module becomes worth it.

## ADR-0002 — Byte-for-byte parity is the acceptance bar
- **Decision:** Reproduce `/replay`'s output exactly. Do **not** "improve" rendering.
- **Why:** Stated goal is to port `/replay`, not to redesign it; the maintainer is
  satisfied with its output.
- **Consequence:** Known `/replay` warts are inherited on purpose (see ADR-0009); the
  renderer improvements floated earlier (fence-safety, encrypted-placeholder
  suppression, same-role coalescing) are **out of scope**.

## ADR-0003 — Normalized contract `{ role, ts, source, sidechain, meta, blocks[] }`
- **Decision:** One normalized event per source **record**; the renderer writes one
  header per event and iterates its `blocks[]`.
- **Why:** A Claude assistant message carries several blocks (text + thinking + N
  tool calls) under **one** header; Codex records are naturally one block each. The
  plan's original flat "one event per block" model produced multiple headers per
  message and miscounted turns.
- **Consequence:** Adapters decide granularity (Claude groups; Codex is 1-block).
  `block.kind ∈ { text, reasoning, thinking, tool_use, tool_result, image }`.

## ADR-0004 — `collectEvents` is flag-agnostic; filtering is render-time
- **Decision:** Adapters emit **every** event unfiltered; `renderMarkdown` applies
  `tools/toolResults/thinking/sidechains/maxChars`.
- **Why:** Mirrors `load_codex_events` (conversion independent of flags); lets a UI
  toggle reveal content without re-fetching.
- **Consequence:** `opts` is unused inside Codex `collectEvents` (kept for signature
  parity). `history` is the lone exception — a Claude-only *collect-time* flag.

## ADR-0005 — Codex prompt source split
- **Decision:** User turns from `event_msg/user_message`; assistant from
  `response_item/message` (role=assistant); **drop** `event_msg/agent_message`
  (duplicate) and `response_item` role user/developer (injected AGENTS.md / env).
- **Why:** `response_item` user turns are polluted with injected context; the
  `event_msg` prompt is the clean, human-typed text. Verified: 5 clean prompts, no
  scaffolding leakage.
- **Consequence:** More robust than the existing `detail()` heuristic
  (`startsWith('<environment_context')`); adopt the same split there eventually.

## ADR-0006 — Codex tool-type coverage matches the reference (pragmatic tail cut)
- **Decision:** Handle `function_call` + `custom_tool_call` (+ their `_output`s) and
  `reasoning`. Drop `tool_search_*`, `web_search_*`, `mcp_tool_call_*`,
  `patch_apply_*`.
- **Why:** This is exactly what `/replay` does; the dropped types are ~3% of tool
  activity in local data (53 of ~1,640 calls).
- **Consequence:** `patch_apply_end` (which can carry real edits) is not captured — a
  conscious parity trade. If richer Codex coverage is wanted later, it must land in
  `/replay` first (ADR-0002).

## ADR-0007 — Full flag set mirrors `/replay`
- **Decision:** Expose `tools, tool-results, thinking, sidechains, history, full,
  max-chars, verbatim, raw, embed-images`; delivery = Copy vs Download (= `--save-dir`).
  `history` is **tri-state** `auto|on|off` (not a boolean). `maxChars` default **400**.
- **Why:** Parity, including replay's `--no-history` semantics. Codex forces
  `history=off` and no-ops `sidechains`/`embed-images`/`verbatim`.
- **Consequence:** Earlier "untruncate for archival" idea is dropped (would diverge).
  UI should grey out Codex-inapplicable flags via capability metadata (ADR-0013).

## ADR-0008 — Download filename = `replay-<short8>[-<flags>].md`
- **Decision:** Port `derive_flag_tokens` (canonical order, computed **before**
  `--full` expands) + `derive_output_path`'s stem. **Override** plan §8's
  `${source}-${id}.md`.
- **Why:** Parity with `/replay`'s filenames (`replay-c506e1c6-full.md`, etc.).
- **Consequence:** Drop the `-2/-3` non-clobber loop — a streamed download never
  touches disk; the browser de-dupes. Port the loop only if a server-side "save to a
  qmd dir" mode is added.

## ADR-0009 — Known parity gaps to preserve (not bugs to fix)
- **Decision:** Replicate `/replay` faithfully, including its edge behaviors, and
  document them so a later "fix" isn't mistaken for a regression:
  1. **Fence/inline-code breakage** when a tool result or tool summary contains
     ``` ``` ``` or backticks (observed once in the test file). Replicated intentionally. ``
  2. **`pyRepr`** keeps exotic non-printable Unicode literal, whereas CPython
     `repr()` would `\x/\u/\U`-escape it. Matches for normal content.
  3. **`summarizeToolUse`** dict/list values use `JSON.stringify` (compact, matches
     `separators=(',',':')`) but keep Unicode literal, vs Python `json.dumps`
     `ensure_ascii=True`. Only bites structured tool inputs (rare for Codex).
  4. **`pyStr`** booleans/None (`True`/`False`/`None`) differ from JS `String()`.
- **Why:** Zero-divergence mandate (ADR-0002).
- **Consequence:** If `/replay` fixes any of these, re-sync the JS.


## ADR-0010 — Verification = golden-diff against `extract-session.py`
- **Decision:** Diff JS output vs the Python extractor across flag combinations as
  the regression gate (9 passing for Codex today). Add deterministic renderer unit
  tests on synthetic blocks; keep the containment smoke cases.
- **Why:** Cheapest guard against drift (ADR-0001); the renderer is pure so it
  unit-tests cleanly.
- **Consequence:** The golden diff must become **two-format** once Claude
  `collectEvents` lands. Length-only assertions are unreliable (a transcript may
  lack thinking/tools) — diff full output instead.

## ADR-0011 — Endpoint security & hygiene
- **Decision:** Reuse each adapter's `isInside(ref, ROOT)` guard; add
  `Cache-Control: no-store`; map unsupported source → **400** (not 500); clamp
  `maxChars` to `[1, 20000]`.
- **Why:** Private transcript content; read-only invariant preserved (no new fs
  writes). The clamp is the single intentional deviation from replay's unbounded
  `--max-chars` (default 400 preserves parity).
- **Consequence:** Add `/api/export` traversal + `*-evil` sibling-ref cases to
  `scripts/smoke-test.mjs` (note: it imports functions directly — it does **not**
  start Vite/HTTP, so assert on `collectEvents`/`renderMarkdown`, not on live headers).

## ADR-0012 — Phasing, and the folder-only listing gap (blocks 1B)
- **Decision:** 1A = Codex (done, verified) + Claude **main** transcript (next).
  1B (Claude subagents / `history.jsonl` / folder-only / index-only) is a separate
  change that **must also extend `claude.js` `list()` and define a stable ref
  format**.
- **Why:** `claude.js list()` only surfaces top-level `<id>.jsonl`. Folder-only and
  index-only sessions produce **no card**, so `collectEvents` recovery logic would be
  unreachable from the UI.
- **Consequence:** Don't schedule 1B as "just `collectEvents`" — it's converter +
  discovery + ref-format + "what does an index-only card expand to."

## ADR-0013 — Per-source capability metadata (no hardcoded `source === 'claude'`)
- **Decision:** `/api/sources` now returns `exportable` per source; extend with a
  small capability set so `ExportMenu` greys out inapplicable flags (Codex:
  sidechains, history, embed-images, verbatim).
- **Why:** Keeps the menu generic and honest about no-ops.
- **Consequence:** Cheap; avoids a `source`-switch in the frontend.
