---
date: 2026-06-12
updated: 2026-07-01
type: plan
topic: ai-session-manager markdown export (replay parity), Phase 1
project: documentor
target_project: ai-session-manager
status: in-progress (1A)
supersedes: null
related:
  - assessment-ai-session-manager-2026-06-12.md
  - adr-markdown-export-2026-07-01.md
  - /Users/rymalia/projects/claude-session-tools/plugins/session-tools/scripts/extract-session.py
---

# Plan: Session → Markdown Export for ai-session-manager (Phase 1)

Add an **Export** action alongside each session's existing **Resume**, rendering
the *full* session transcript to configurable markdown — the GUI equivalent of
`/session-tools:replay`, scoped in Phase 1 to the two clients the user actually
runs: **Claude Code** and **Codex**.

The renderer is a **byte-for-byte faithful port** of `extract-session.py`
(session-tools v1.7.0, ~953 lines Python) into Node, restructured as **one shared
renderer + per-client `collectEvents` modules** so the remaining seven tools can
be added later without touching the core.

> **Authoritative decisions live in `adr-markdown-export-2026-07-01.md` (13 ADRs).**
> This plan is the roadmap; where the two disagree, the ADR wins. This revision
> (2026-07-01) folds the ADR outcomes back in and marks shipped vs pending.

## 0. Status (2026-07-01, HEAD `37efecb`)

| Piece | File | State |
|-------|------|-------|
| Shared renderer | `server/export.js` | ✅ **Shipped** (`228d2e2`) — byte-verified; hygiene builder added (`673f531`) |
| Codex `collectEvents` | `server/sources/codex.js` | ✅ **Shipped** — image-note parity bug fixed & committed (`f2c7e05`) |
| Registry / capability dispatch | `server/sources/index.js` | ✅ **Shipped** — `EXPORTERS`, `collectEvents` (`Object.hasOwn` guard `673f531`), `exportCapableSources` = `['claude','codex']` |
| `/api/export` + `/api/sources.exportable` | `vite.config.js` | ✅ **Shipped** — hygiene DONE & committed (`673f531`, §9): no-store on all exits, RFC 5987 filename, `Object.hasOwn` dispatch; `apiMiddleware` now a named export |
| Golden-diff harness | `scripts/export-parity.mjs` | ✅ **Shipped** — Codex now general (4+ live sessions incl. `019eb994` + a deterministic fixture), Claude 50/50 (5 × 10 combos) |
| Claude `collectEvents` (main, 1A) | `server/sources/claude.js` | ✅ **Shipped** (`4030a6b`) — byte-identical across 5 live sessions |
| Export regression tests in `npm test` | `scripts/smoke-test.mjs` | ✅ **Shipped** — export traversal/`*-evil` guards, 7 renderer/parity tests, Codex image-parity case, + 8 endpoint-hygiene tests (`673f531`) |
| Frontend export UI | `src/App.jsx` + `src/ExportMenu.jsx` + `src/exportOptions.js` | ✅ **Shipped (working tree, uncommitted)** — item B; see §13 |
| Claude enrichment (1B) | `claude.js` (`list()` + `detail()` + `collectEvents`) | ⬜ **Pending** — see §7; **now must also preserve context-health code (see cross-feature note)** |

Baseline: `npm test` passes **83/0** (data-dependent per-source checks scale with which
CLIs have local data). Golden-diff harness green for both sources across live sessions
**and** a checked-in fixture. **The ADR log was refreshed & expanded (`d1038c7`):** new
ADR-0014 (requested→effective→resolved option pipeline; `full` never 400s), ADR-0015
(Claude live-main index enrichment is **1A**), ADR-0016 (browser delivery/size), ADR-0017
(canonical Claude `SessionBundle` identity + opaque refs); ADR-0002/0009/0013 sharpened.
§13 below is re-sequenced against those.

> **Cross-feature note (2026-07-01): the context-health feature landed** (`d4efa34`
> data + `37efecb` badge) *between* the export commits and now. It added
> `server/contextUsage.js` and wove per-session `contextUsage` into `_shared.js`
> `makeEntry`, `claude.js`/`codex.js` `list()`, `usage.js`, plus a card badge in
> `App.jsx`/`index.css` (new `--ok/--warn/--danger` tokens). **Impact on this plan:**
> (1) **1B (§7/§13.8) is riskier now** — `claude.js` `list()` contains the Claude
> context-health computation, so the `SessionBundle` `list()` refactor must *integrate*
> it, not clobber it. (2) **Frontend (§10) must coexist** — the Export control sits next
> to Resume in a card row that already renders the context-health pill; reuse the shared
> design tokens and don't crowd it. Export itself (`collectEvents`/`renderMarkdown`) is a
> separate path and is functionally unaffected.

> ✅ **RESOLVED & COMMITTED (`f2c7e05`) — the Critical Codex image-note parity bug.**
> `codex.js` uses `(Array.isArray(p.images) && p.images.length ? p.images :
> p.local_images) || []`, mirroring Python's `images or local_images` (empty list falsy),
> so a record with `images: []` + non-empty `local_images` keeps the `[N image(s)
> attached]` note. Deterministic fixture
> (`scripts/fixtures/codex-empty-images-local-images.jsonl`) wired into both the parity
> harness and a hermetic `smoke-test.mjs` case. `extract-session.py:543` matched exactly.

## 1. Goal & scope

**In scope (Phase 1):**
- Full-fidelity transcript export (no last-30 cap, no 300/600-char preview clip).
- Configurable markdown via replay's full flag set: `tools`, `tool-results`,
  `thinking`, `sidechains`, `history` (tri-state), `full`, `verbatim`, `raw`,
  `embed-images`, `max-chars`.
- Two delivery modes from the browser: **Copy to clipboard** (handoff /
  context-injection) and **Download `.md`** (the qmd-indexing use case, =
  replay's `--save-dir`).
- Clients: **Claude Code** and **Codex** only.

> **Fidelity note (resolves the earlier "untruncate for archival" idea):** the
> acceptance bar is **byte-for-byte parity with `/replay`** (ADR-0002), so
> `maxChars` keeps replay's **default of 400** rather than defaulting to
> unlimited. "Full fidelity" here means *no preview clipping and every content
> type available*, tuned by flags — not "always emit untruncated tool results."
> Diverging the default would break the golden diff. Users who want everything
> pass a high `--max-chars` (clamped to 20000, ADR-0011).

**Out of scope (Phase 1):**
- The other seven ASM tools (the architecture leaves a clean slot for them).
- Server-side "save to a qmd collection dir" (keeps ASM's no-write invariant
  intact in v1 — see §9). Noted as a fast follow.

**Milestones:**
- **1A — Core + main transcripts.** Shared renderer, endpoint, registry, Codex,
  Claude *main* transcript, tests, the Codex image-note parity fix (`f2c7e05`), and
  endpoint hygiene (`673f531`) all **shipped & committed** (64/0). Only the **frontend
  export UI remains** for 1A to be usable end-to-end (§10). Ships the core workflow for
  both clients.
- **1B — Claude enrichment.** Subagent sidechains, `history.jsonl` backfill,
  folder-only / `sessions-index.json` recovery. **Not just `collectEvents`** —
  also needs `claude.js` `list()` changes + a stable ref format (ADR-0012).

## 2. Architecture decision: shared renderer + per-client modules

ASM already proves the pattern: one file per tool exporting a fixed contract,
funneled through a shared normalizer (`makeEntry`). Export mirrors this:

```
                 ┌─────────────────────────────────────────────┐
   per-client    │  server/sources/claude.js   (+ collectEvents)│
   modules  ───▶ │  server/sources/codex.js    (+ collectEvents)│
   (CODE)        └─────────────────────────────────────────────┘
                        │  emit { meta, events: NormalizedEvent[] } (full fidelity)
                        ▼
                 ┌─────────────────────────────────────────────┐
   shared core   │  server/export.js                           │
   (renders,     │   renderMarkdown(events, meta, opts)         │
   flags,        │   summarizeToolUse / cleanUserText /         │
   noise-strip)  │   truncate / pyRepr / pyStr / deriveFilename │
                 └─────────────────────────────────────────────┘
                        │  markdown string
                        ▼
                 /api/export  ──▶  Copy / Download (App.jsx + ExportMenu.jsx)
```

**Why a module, not a static config file** (ADR-0001/0003): the per-client
differences are *structural*. Codex wraps records in `{ type, payload }` and
splits the clean prompt into `event_msg/user_message`; Claude uses Anthropic
content-block arrays and its richest content lives in *sibling files*
(`subagents/agent-*.jsonl`, `~/.claude/history.jsonl`). No declarative config can
express "read these other files and merge by timestamp." A small function per
client can. Cosmetic bits that *are* declarative (labels, accent color) stay in
`SOURCE_META`.

**Do not shell out to `extract-session.py` (ADR-0001):** it is Claude-only (walks
`~/.claude/projects`) so it can't serve Codex at all, and shelling out would add a
Python runtime dep + an `execFile` surface ASM confines to `agents.js`/`open.js`.
The cost — two implementations of the same logic — is paid down by the golden-diff
harness (ADR-0010).

**Contributor story:** to add tool X, implement `collectEvents(ref, opts)` in
`server/sources/x.js` returning `{ meta, events }`. `EXPORTERS` auto-detects it;
adapters without it are simply not export-capable (the UI hides the button).

## 3. The normalized event model (the shared contract) — CORRECTED

The shipped contract is **one event per source *record*, carrying a `blocks[]`
array** — NOT the flat "one event per block" model in the original draft. This is
ADR-0003 and it matters: a Claude assistant message carries several blocks (text +
thinking + N tool calls) under **one** header; the flat model emitted multiple
headers per message and miscounted turns.

```js
// emitted by each adapter's collectEvents; consumed by renderMarkdown
/**
 * @typedef {Object} NormalizedEvent
 * @property {'user'|'assistant'} role
 * @property {string} ts               ISO-8601 (sortable; ms-epoch sources format to match)
 * @property {string} source           'main' | 'history' | 'subagent:<id>'  (1A: always 'main')
 * @property {boolean} sidechain       true for subagent turns (1A: false)
 * @property {boolean} meta            true for Claude isMeta harness-synthetic turns
 * @property {Array}   blocks          [{ kind, ... }]
 * @property {string[]} [imagePasteIds] Claude only — aligns image labels with prompt markers
 */
// block.kind ∈ { text, reasoning, thinking, tool_use, tool_result, image }
//   text        → { kind, text }
//   thinking    → { kind, text }              (Claude)
//   reasoning   → { kind, text }              (Codex; '' → renders "[encrypted by Codex]")
//   tool_use    → { kind, name, input }       (input is a Claude-style object)
//   tool_result → { kind, text }
//   image       → { kind, mediaType, source } (source passed through for --embed-images)
```

Notes:
- **Filtering is render-time (ADR-0004).** `collectEvents` emits *every* event
  unfiltered; `renderMarkdown` applies `tools/toolResults/thinking/sidechains/
  maxChars/verbatim/embedImages`. `opts` is therefore unused inside 1A
  collectors (kept for signature parity). `history` is the lone *collect-time*
  flag — Claude-only, 1B.
- **Meta drop, not scaffold flag.** The original draft's `scaffold` field was
  dropped. Codex simply doesn't emit injected `response_item` user/developer
  records (ADR-0005); Claude's `isMeta` records are emitted with `meta:true` and
  the renderer drops them unless `--verbatim`. `<system-reminder>` stripping is a
  separate mechanism (`cleanUserText`/`NOISE_RE`) operating *inside* kept text.
- Events are **untruncated** here; truncation is render-time (`maxChars`). This is
  the key departure from ASM's `detail()` path.
- **Stable sort by `ts`.** Both collectors `events.sort()` by ISO string;
  `Array.sort` is stable (Node 12+) so equal/emission order is preserved, matching
  Python. For single-file 1A this is effectively a no-op over file order; it
  becomes load-bearing when 1B merges subagents + history.

## 4. Adapter contract extension — SHIPPED

One optional method (existing `list`/`detail` untouched):

```js
export async function collectEvents(ref, opts);  // → { meta, events: NormalizedEvent[] }
```

`meta` carries header fields the renderer prints. Shipped shape (superset;
adapters fill a subset):
`{ source, sessionId, cwd, mainPath, isCodex, model, cliVersion, historyOn,
   historyAdded, summary, subagentCount, folder, created, gitBranch, messageCount }`.

Registry in `server/sources/index.js` (as shipped):

```js
const EXPORTERS = Object.fromEntries(
  Object.entries(ADAPTERS).filter(([, a]) => typeof a.collectEvents === 'function')
);
export function exportCapableSources() { return Object.keys(EXPORTERS); }
export async function collectEvents(sourceName, ref, opts) {
  const a = EXPORTERS[sourceName];
  if (!a) { const e = new Error('export not supported for ' + sourceName); e.code = 'unsupported'; throw e; }
  return a.collectEvents(ref, opts);   // adapter validates ref (isInside) itself
}
```

`/api/sources` now returns `exportable: true|false` per tool (ADR-0013 extends
this with a small per-flag capability set for the UI — see §10).

## 5. Shared renderer — `server/export.js` — SHIPPED

Ports `extract-session.py`'s `render_event` + `main()` header assembly +
`summarize_tool_use` + `clean_user_text` + `truncate` + `format_ts`
**byte-for-byte (ADR-0002)**. Key shipped details beyond the original sketch:

- **Code-point-accurate `truncate`** — iterates `Array.from(s)` (code points),
  not `.slice()`/`.length` (UTF-16 units), so emoji/non-BMP content matches
  Python's `len()`/`[:n]` and the `+N chars` remainder count exactly.
- **`pyStr` / `pyRepr`** — reproduce CPython `str()`/`repr()` for
  `summarizeToolUse`'s `!r` formatting (quote choice, `\\ \n \r \t`, ASCII
  control escaping; `True/False/None`).
- **`summarizeToolUse`** — priority-key picker
  (`file_path,path,pattern,command,description,prompt,query,url,skill,
  subagent_type,input,arguments,cell_id`) → `name(k=v, …)`; dict/list values via
  `JSON.stringify` (matches Python `separators=(',',':')`).
- **Header + filters block** — session id, cwd, branch, turns, active-filter
  summary; Codex adds `format`/`model`/`cliVersion`; 1B adds subagent/history/
  index lines. `--raw` emits the body only.
- **Reasoning** — empty Codex reasoning renders `[encrypted by Codex]`.

**Known parity gaps preserved on purpose (ADR-0009), do not "fix":** fence/inline-
code breakage when a tool result contains backticks (this genuinely *is* replay's
behavior, faithfully preserved). If `/replay` fixes it, re-sync.

> **Codex review correction (ADR-0002 ⇄ ADR-0009 tension).** Two items previously
> filed under ADR-0009 are **JS-port gaps, not preserved replay behavior**, so the
> "zero divergence" claim is currently overstated: (a) `pyRepr` keeps exotic
> non-printable Unicode literal where CPython `repr()` would `\x/\u/\U`-escape it;
> (b) `summarizeToolUse` dict/list values keep Unicode literal where Python
> `json.dumps` defaults to `ensure_ascii=True` (`\uXXXX`). These *can* differ
> byte-for-byte on structured/Unicode tool inputs. Also, `pyStr` **already handles**
> bool/None correctly — it is **not** a remaining gap (drop it from the list).
> **Decision needed:** either implement Python-compatible escaping, or explicitly
> weaken ADR-0002 to *enumerated, tested* exceptions. Track in the ADR, not silently.

## 6. Per-client modules (Phase 1A)

### 6a. `server/sources/codex.js` — `collectEvents` — SHIPPED (CORRECTED)

The original §6a table was wrong about the prompt source. Shipped mapping
(ADR-0005/0006), a port of `load_codex_events`:

| Codex record | Emitted |
|---|---|
| `session_meta` | fills `meta` (sessionId, cwd, model, cliVersion) — no event |
| `event_msg` `user_message` | `user` + `[{kind:'text'}]` — **the clean, human-typed prompt** (appends `[N image(s) attached]` note) |
| `response_item` `message` role `assistant` | `assistant` + `[{kind:'text'}]` |
| `response_item` `message` role user/developer | **dropped** — injected AGENTS.md / env context |
| `event_msg` `agent_message` | **dropped** — duplicate of the response_item |
| `response_item` `function_call` / `custom_tool_call` | `assistant` + `[{kind:'tool_use', name, input}]` via `codexToolInput` (JSON-parses string `arguments`) |
| `function_call_output` / `custom_tool_call_output` | `user` + `[{kind:'tool_result', text}]` via `codexOutputText` |
| `response_item` `reasoning` | `assistant` + `[{kind:'reasoning', text}]` |

Tool-type tail (`tool_search_*`, `web_search_*`, `mcp_tool_call_*`,
`patch_apply_*`) is **dropped to match `/replay`** (ADR-0006, ~3% of calls);
richer coverage must land in `/replay` first. No clipping here — raw text out.

> ✅ **Image-note parity fixed (working tree) — see §0.** The `[N image(s) attached]`
> note now uses `(Array.isArray(p.images) && p.images.length ? p.images : p.local_images)
> || []`, mirroring Python's `images or local_images`. Codex parity is now **general**
> (4+ live sessions + a checked-in fixture), no longer fixture-scoped.

### 6b. `server/sources/claude.js` — `collectEvents` (1A main transcript) — SHIPPED (`4030a6b`)

Byte-identical to `/replay` across 5 live Claude sessions × 10 combos (50/50).
Streams the main `<id>.jsonl`; per-record → grouped `blocks[]`:

| Claude record → blocks | |
|---|---|
| `user`, `content` string | `[{kind:'text', text}]` |
| `user`, `content` list | per block: `text`→`{kind:'text'}`, `image`→`{kind:'image', mediaType, source}` (raw `source` passed through), plus each `tool_result`→`{kind:'tool_result', text}` (extracted like `extract_user_tool_results`) |
| `assistant` | `text`→`{kind:'text'}`, `thinking`→`{kind:'thinking'}`, `tool_use`→`{kind:'tool_use', name, input}` |
| any record | `sidechain = !!isSidechain`; **`meta = !!isMeta` on user records only** (assistant events hardcode `meta:false` — matches `/replay`, which checks `isMeta` on user turns only); `imagePasteIds` carried through |

`meta`: `sessionId` (filename stem), `mainPath = resolved`, `isCodex:false`,
`historyOn:false`, and `cwd` = first record (by sorted ts) carrying a `cwd`.
Guard: `isInside(path.resolve(ref), ROOT)` → `'forbidden'`, exactly like
`detail()`.

> **`sessions-index.json` enrichment — shipped code skips it; Codex flags a latent
> trap.** An audit found **0 of ~8,436 live transcripts** overlap the 175 index
> entries (index files exist only for *cleaned-up* sessions whose `.jsonl` is gone),
> so a collector with no index lookup byte-matches `/replay` **today**. But this is
> *observed data, not a format guarantee* — `/replay` calls `load_session_index()`
> even for a direct main-transcript path, so if a Claude update ever retained both
> files, the header would gain summary/created/branch/msg-count lines and 1A would
> diverge. **DECIDED (ADR-0015): implement it in 1A** — the cheap per-project index
> lookup (`load_session_index(p.parent, p.stem)`, the project-slug dir, **not** the
> `<id>/` companion folder) as live-main-transcript enrichment, plus a synthetic
> overlapping-index golden case. Tracked as item **C** in §13. (Index-*only* recovery
> stays 1B under ADR-0017.)

## 7. Claude enrichment (Phase 1B — separable, bigger than it looks)

Contained in `claude.js`, but **not just `collectEvents`** (ADR-0012): folder-only
and index-only sessions produce **no card today**, because `list()` only surfaces
top-level `<id>.jsonl`. So 1B = converter **+** discovery (`list()` change) **+** a
stable ref format **+** "what does an index-only card expand to." Do not schedule
it as "just the collector."

Port the remainder of `extract-session.py`. **These rules were misstated in the
original draft — corrected per Codex review (Major #4/#5/#6):**

1. **Subagent sidechains** — glob `<id>/subagents/agent-*.jsonl`, load with
   `source:'subagent:<stem>'`, `sidechain:true`.
2. **`history.jsonl` backfill** — the one *collect-time* flag. Synthesize
   `{role:'user', source:'history'}` events matching `sessionId`, then dedup
   against main-transcript user turns. **Dedup key (exact order):**
   `clean_user_text` **first**, *then* `\s+`→space, lowercase, `.slice(0,200)`;
   compare **only string-valued** main user content. Tri-state
   `history: auto|on|off`.
3. **Folder-only recovery** — main `.jsonl` gone but `<id>/subagents/` survives.
   Force `sidechains:true`; **history is auto-on for folder-only but must still
   honor an explicit `--no-history`** (do *not* "force `history:true`" — that was
   wrong). Index-only sessions keep history **off**.
4. **`sessions-index.json` fallback** — populate `meta` (summary, created,
   branch, original message count); supports the index-only case. (This is also the
   §6b "live-index enrichment" hook, if that lands in 1A.)
5. **Collect order matters for equal-timestamp parity:** main → **lexically-sorted**
   subagents → history, *then* a stable sort by `ts`. Emission order is the
   tiebreaker, so the pre-sort concatenation order must match `/replay` exactly.
6. **Resolved-options contract (Major #5).** Folder-only forces Sidechains on so
   recovered events aren't filtered out — but that resolution must not be a hidden
   `opts` mutation. Extend the contract to return **`{ meta, events, resolvedOpts }`**;
   the renderer filters on `resolvedOpts`, while **filename tokens derive from the
   *requested* opts** (before `full`/folder-only expansion), preserving ADR-0008.

**1B is not "just `collectEvents`" (Major #4).** `detail()` and `server/search.js`
both consume `ref` as a readable JSONL path (`getConversation(source, ref)`), so
folder-only / index-only / virtual refs break **card expansion and content search**,
not only export. 1B must therefore define **one canonical `SessionBundle` resolver**
shared by `list` / `detail` / `collectEvents`, plus: composite `mtimeMs` / lastActivity
invalidation for bundled sessions, one-card de-duplication, "what an index-only card
expands to," and a **ref/key migration path for persisted stars** (`ccv.starred` keys
on `${source}:${ref}`).

## 8. API endpoint — `vite.config.js` — SHIPPED (CORRECTED)

The shipped `/api/export` is richer than the original §8 sketch. It:
- Reads the **full flag set** (`tools, toolResults, thinking, sidechains,
  verbatim, raw, embedImages`) plus `full` (expanded server-side into its four
  component flags) and **tri-state `history`** (`auto|on|off`; Codex forced off).
- **Clamps `maxChars` to `[1, 20000]`** (the single intentional deviation from
  replay's unbounded `--max-chars`; default 400 preserves parity — ADR-0011).
- Maps **unsupported source → 400** (`e.code === 'unsupported'`), `'forbidden'` →
  **403**, other → 500.
- Sets **`Cache-Control: no-store`**; `Content-Type` is `text/plain` for `--raw`
  else `text/markdown`.
- On `download=1`, derives the filename via `deriveFlagTokens` +
  `deriveExportFilename` → **`replay-<short8>[-<flags>].md`** (ADR-0008, overrides
  the original `${source}-${id}.md`). Tokens are computed from flags *as requested*
  (before `--full` expands), in canonical order, so ordering is stable. No
  `-2/-3` non-clobber loop — a streamed download never touches disk; the browser
  de-dupes.

Returns markdown directly (not JSON) so Download streams and Copy can
`await res.text()`.

## 9. Security & non-destructive invariants — SHIPPED/PENDING

- **Read-only preserved.** `collectEvents` only reads (same fs APIs as `detail`);
  no writes. ASM's "never mutate session files" invariant is untouched.
- **Path containment.** Each adapter validates `ref` with `isInside()` before
  opening — the endpoint adds no new traversal surface. ✅ **Shipped (`4030a6b`):**
  `/api/export`-shaped traversal + `*-evil` sibling-ref cases in
  `scripts/smoke-test.mjs`, asserting on `collectEvents` (the smoke test imports
  functions directly and does **not** run HTTP — ADR-0011).
- **Delivery is browser-side.** Copy and Download keep the server write-free. A
  future "save to a qmd dir" is the only thing that would make ASM write files —
  deferred, and even then to ASM's own dir, never a session file.
- **No shell.** Export touches no `execFile`/shell path.

**✅ Endpoint hygiene follow-ups (Codex Minor #10/#11 — DONE, working tree, uncommitted).**
Plan-reviewed + implementation-reviewed via `/codex-plan-review` (plan REVISE → fixed →
impl SHIP, 0 defects). `npm test` 44/0; byte-parity re-verified (codex+claude live sessions).
- ✅ **`Cache-Control: no-store` on EVERY export exit** — moved to the top of the
  `/api/export` branch (before the missing-source 400), so 4xx/5xx error bodies (which
  can echo private absolute paths) are no longer cacheable. Codex confirmed `json()`/
  `res.end()` don't strip it and no later middleware runs (`vite.config.js`).
- ✅ **`Content-Disposition` sanitized + RFC 5987-encoded** — new
  `deriveContentDisposition(sessionId, tokens)` in `server/export.js` emits an ASCII-token
  `filename="…"` fallback (`[^A-Za-z0-9._-]→_`, closing quote/CRLF injection) **and**
  `filename*=UTF-8''…`. Plan review caught that `encodeURIComponent` **throws** on a lone
  surrogate from `sessionId.slice(0,8)` and leaves `'()*` unescaped (not RFC 5987
  attr-char): fixed via **code-point** slicing in `deriveExportFilename` + `.toWellFormed()`
  + explicit `'()*` percent-encoding. Codex exhaustively verified all 65,536 code units.
- ✅ **`Object.hasOwn(EXPORTERS, sourceName)` dispatch guard** (`server/sources/index.js`) —
  prototype names (`toString`/`constructor`/`__proto__`) now 400 (`unsupported`), not 500.
- ✅ **Tests (`scripts/smoke-test.mjs`, +8):** prototype-name→unsupported (×3),
  `deriveContentDisposition` hostile-id/emoji-boundary/lone-surrogate (×3), and
  endpoint-level `apiMiddleware` mock req/res asserting `no-store` on early-400 +
  unsupported-400 (×2). `apiMiddleware` is now a named export for in-process testing.
  (`getConversation`/`ADAPTERS` has the same prototype 500 hole but no 400/500 contract to
  break — left out of scope, tracked as a follow-up.)

## 10. Frontend — `src/App.jsx` (+ `src/ExportMenu.jsx`) — PENDING (not started)

Insertion point exists in `App.jsx` near the Resume control; no export logic yet.

- **Export control** on each card, next to Resume; rendered only when the card's
  `source ∈ exportCapableSources()` (from `/api/sources.exportable`).
- **Options popover** (`src/ExportMenu.jsx`, prefix `exp-`): checkboxes for Tools,
  Tool results, Thinking, Sidechains, History, Verbatim, Raw, Embed-images; a
  `maxChars` number input; actions **Copy** and **Download**.
- **Capability metadata must be PHASE-ACCURATE, not just per-source (ADR-0013 +
  Codex Major #3).** Grey out flags a source can't honor from `/api/sources`
  capability fields. Codex no-ops `sidechains`, `history`, `embed-images`,
  `verbatim`. **Critically, in 1A the Claude adapter also does NOT honor `history`
  or `sidechains`** — it hardcodes `historyOn:false` and reads no subagent files.
  If the menu offers an enabled History checkbox for Claude now, `history=on` yields
  a `-history.md` **filename with no history content** (misleading). So the
  capability set must reflect *current phase*: until 1B lands, Claude reports
  `history:false` and `sidechains:false`. Don't advertise 1B capabilities from a 1A build.
- **Persist** last-used options to `localStorage` under `ccv.export` (matches
  `ccv.filters` / `ccv.starred`).
- **Copy (correctness, Codex Minor #9):** `const r = await fetch('/api/export?…')` →
  **check `r.ok` first** (an error returns a JSON body; without the guard it would be
  copied *as markdown*). Only on success `navigator.clipboard.writeText(await r.text())`;
  surface server errors otherwise. Measure the soft cap in **UTF-8 bytes via
  `TextEncoder`**, not `.length` (chars ≠ bytes), and make Download an **explicit**
  fallback action rather than silently navigating away.
- Download → `<a download>` / `window.location` to `/api/export?…&download=1`.

Defaults mirror replay: content filters **off** (clean human-only transcript),
`maxChars=400`, `history=auto`. "Full" = the `full` flag (Tools + Tool results +
Thinking + Sidechains).

## 11. Verification — CORRECTED

Primary gate is the **golden diff against `extract-session.py`** (ADR-0010), not
HTTP assertions (the smoke test doesn't start Vite):

- **`scripts/export-parity.mjs`** (shipped) runs the Python extractor and the JS
  path over a 10-combo flag matrix and asserts byte-identity. Green across **4+ live
  Codex sessions** (incl. `019eb994`) **+ a checked-in fixture**, and Claude 50/50
  (5 sessions × 10):
  ```bash
  node scripts/export-parity.mjs codex ~/.codex/sessions/2026/06/30/rollout-*019f1a6e*.jsonl
  node scripts/export-parity.mjs claude ~/.claude/projects/-Users-rymalia-projects/0af8a8ed-…jsonl
  ```
- ✅ **Renderer unit tests** shipped (`4030a6b`, in `smoke-test.mjs`): 6 deterministic
  cases on synthetic blocks — one-header-per-event grouping, turn counting, code-point
  truncation, `[encrypted by Codex]`, `isMeta` suppression.
- ✅ **Smoke-test** export containment cases shipped (§9).

> **⚠️ Keep reducing reliance on favorable *live* fixtures (Codex Major #7).** The
> first synthetic fixture is now checked in (empty `images` + non-empty `local_images`,
> which caught the §0 Critical), but the harness still **bypasses the endpoint**
> (parsing, `maxChars` clamp, filename/header derivation, error mapping). **Still
> recommended:** add more **deterministic synthetic JSONL fixtures** covering a
> live-index overlap; explicit history on/off; `toolResults` alone; `raw` + embed-images;
> equal / missing timestamps; Unicode structured tool inputs; `maxChars` boundaries +
> invalid input; filename derivation; unsupported-source (incl. prototype names). Length-
> only assertions are unreliable (a transcript may lack thinking/tools) — **diff full
> output** instead.

## 12. Open questions — RESOLVED (except Q2)

1. **Resume-command echo → NO (resolved).** Byte-parity with `/replay` (ADR-0002)
   is the bar, and replay emits no resume line. Adding one would diverge every
   golden diff. If wanted later, it must land in `/replay` first.
2. **Clipboard size → RESOLVED (ADR-0016).** Copy checks `response.ok`, measures
   UTF-8 bytes, and writes to the clipboard only under a **2 MiB soft cap**; above it,
   an **explicit** Download action (never an automatic download). Download is unbounded.
   Implemented in item B (§13).
3. **1B scope → LATER (resolved, ADR-0012).** Ship 1A (main transcripts, both
   clients) first; 1B (Claude subagents/history/folder-only/index-only) is a
   separate change that also needs `list()` + a ref-format decision.

## 13. Remaining work (execution order — reassessed 2026-07-01, HEAD `37efecb`)

*1A core (Codex + Claude main) + tests + the image-parity fix + endpoint hygiene are all
**committed** (`228d2e2`→`673f531`, `npm test` 64/0). The user-facing feature is still
**backend-only — there is no Export UI yet**, so a user cannot export at all. Getting the
UI shippable (items A→B below) is the highest-value path; everything else is robustness.*

**✅ Done & committed**
- ✅ **Critical Codex parity bug** — `f2c7e05` (fixture + hermetic smoke-test case).
- ✅ **Endpoint hygiene (§9)** — `673f531`: `no-store` on all exits; RFC 5987
  `deriveContentDisposition` (code-point slice + `.toWellFormed()` + `'()*` encoding,
  closing an `encodeURIComponent` lone-surrogate crash the plan review caught);
  `Object.hasOwn` dispatch; +8 tests. Plan-reviewed (REVISE→fixed) + impl-reviewed
  (SHIP, 0 defects) via `/codex-plan-review`. **Bonus:** this also delivered the first
  slice of item C — `apiMiddleware` is now a named export driven by a mock req/res, so
  error-mapping + `no-store` now have endpoint-level coverage (not just the pure renderer).

**⬜ Remaining — re-sequenced against ADR-0013–0017. Ship 1A's UI, then harden, then 1B:**

- ✅ **A. DONE (working tree, uncommitted) — Capability metadata + option-resolution pipeline
  (ADR-0013 + ADR-0014).** Adapter-owned tri-value `exportCapabilities` on `claude.js`/`codex.js`
  + `exportCapabilities()` accessor (`Object.hasOwn`-guarded) surfaced via `/api/sources`
  (export-capable sources only); pure `resolveExportOptions` + `sourceEffectiveOptions` in
  `export.js` (`full` exempt/unconditional-expand, explicit-unavailable→reject naming the
  option, `history` on/off/auto, tokens-from-requested, fail-closed); `/api/export` wired with
  `resolvedOpts` plumbed to the renderer. Parity harness refactored to **share
  `sourceEffectiveOptions`** (no more duplicated resolver → can't drift). +16 tests (67→**83/0**),
  byte-parity green (codex+claude). Plan-reviewed (REVISE→6 findings folded) + impl-reviewed
  (FIX→parity-drift fixed) via `/codex-plan-review`. **Needs commit.** *Original spec below:*
- **A. Capability metadata + option-resolution pipeline (ADR-0013 + ADR-0014).** *Backend;
  unblocks B; ideal `/codex-plan-review` loop.* Two coupled pieces:
  - **ADR-0013:** each adapter owns a **tri-value** `exportCapabilities` map (`supported` /
    `notApplicable` / `unavailable`) — Claude 1A: `sidechains`/`history` = `unavailable`
    (real /replay features not built until 1B, *not* notApplicable); Codex:
    `sidechains`/`history`/`verbatim`/`embedImages` = `notApplicable`. Surface via
    `/api/sources`; endpoint + UI consume the *same* metadata, never switch on source name;
    missing/unknown **fail closed**.
  - **ADR-0014:** the `/api/export` handler implements requested → capability-validated →
    source-effective → session-resolved. **`full` is a render directive: it expands to the
    four flags unconditionally for every source and NEVER 400s** (matches `/replay --full`;
    constituents with no events still show `on` in the header). Only an *explicitly,
    individually selected* option that is `unavailable`/`notApplicable` → **400 naming the
    option**. `history=auto` → off when unavailable. Filename tokens derive from accepted
    *requested* opts before `full` expands. *Tests: `full` byte-identical for Claude/Codex
    with `sidechains=on` + no sidechain content; explicit unavailable option → 400; auto→off.*
- ✅ **B. DONE (working tree, uncommitted) — Frontend `ExportMenu.jsx` + card wiring (§10 + ADR-0016).**
  New `src/ExportMenu.jsx` (native Popover API in the top layer, driven via `popovertarget` invoker
  wiring — escapes `.card{overflow:hidden}` clipping and gives Escape/outside-click/single-open/
  focus-return), new pure `src/exportOptions.js` (`normalizeExportOpts`/`buildExportQuery`/
  `clampMaxChars`, capability-filtered so the UI can never emit an explicit-unavailable 400),
  new `src/export.css` (`exp-` prefix), and `src/App.jsx` wiring (lifted+persisted `ccv.export`
  opts, Export control next to Resume gated on `exportable`, card-head keydown descendant guard).
  Copy: `r.ok` first, UTF-8-byte 2 MiB soft cap → explicit Download (never auto), AbortController +
  verified clipboard + unmount-safe timers. Download: real `<a target=_blank rel=noopener>` (no
  `download` attr) so errors open visibly. Coexists with the context-health pill. Resolves Q2.
  **+13 pure-helper smoke tests (83→96/0)**; production build green. Plan-reviewed (REVISE → 9
  findings folded) + impl-reviewed (Codex found the popover light-dismiss/reopen Major → fixed via
  `popovertarget` invoker) via `/codex-plan-review`. Browser-verified end-to-end (greying per
  source, Full-implies-four, single-open, toggle open/close, Copy path, no console errors).
  **Needs commit.** *Original spec below.*
- **B. Frontend `ExportMenu.jsx` + card wiring (§10 + ADR-0016).** *The actual deliverable.*
  Copy checks `response.ok`, buffers, measures **UTF-8 bytes**, writes to clipboard only
  under a **2 MiB soft cap**; above it, an **explicit** Download action (never auto-download).
  Download via server `Content-Disposition`; errors surface visibly. One menu open at a time;
  Escape / outside-click / focus-return / keyboard nav / propagation isolation from card
  expansion. Persisted `ccv.export` opts are **schema-validated + capability-filtered** before
  use. **Coexist with the context-health pill** next to Resume (reuse `--ok/--warn/--danger`).
  Resolves Q2. *Largest non-1B item — its own loop.*
- ✅ **C. DONE & committed (`3f9ca90`, 2026-07-07) — Claude live-main index enrichment
  (ADR-0015).** `collectEvents` now ports `/replay`'s direct-path branch: a
  `loadSessionIndex(projectDir, sessionId)` helper reads `sessions-index.json` beside the
  transcript (missing/unparseable/structurally-invalid → silently no enrichment; the
  structural tolerance is a documented error-path divergence — Python crashes there) and
  populates the four renderer-visible meta fields (`summary`/`created`/`gitBranch`/
  `messageCount`; `firstPrompt`/`modified` deliberately stay out of the meta contract).
  Index load is sequenced **before** the readline interface is created — an await between
  `createInterface` and the `for await` loop starves the iterator (predicted in plan
  review, hit as a real hang, now commented in code). ADR-0015's required fixture landed:
  `scripts/fixtures/claude-index-enrichment.*` (decoy entry + non-rendered-field bait +
  index `created` ≠ first event ts), golden-diffed across the full 10-combo matrix plus 6
  hermetic child-process variants (match/order/no-leakage, no-index, no-match, malformed
  JSON, array-root structural, falsey-field suppression; child processes because
  `claude.js` captures `ROOT` from `os.homedir()` at import time). Tests 102→**104/0**;
  no-index regression re-verified byte-identical on the real pinned transcript.
  Plan-reviewed (4 findings folded) + impl-reviewed (0 findings) via `/codex-plan-review`.
  *Original spec below:*
- **C. Claude live-main index enrichment (ADR-0015) — DECIDED 1A, was open "decision E".**
  On export of a Claude main transcript, load `sessions-index.json` from the **project-slug
  dir** (`load_session_index(p.parent, p.stem)` — `~/.claude/projects/<slug>/`, *not* the
  `<id>/` companion folder), exactly as `/replay`'s direct-path branch. Add a synthetic
  main-transcript-beside-overlapping-index fixture + golden diff. *Self-contained Claude
  `collectEvents`/meta change; closes the §6b latent parity trap. Independent of A/B.*
- ✅ **D. DONE & committed (`c40d385`, 2026-07-07, jointly with E) — verification fixtures.**
  New golden fixture `scripts/fixtures/claude-render-edges.jsonl` (generated pure-ASCII:
  non-ASCII body text + structured non-ASCII tool input, base64 image for hermetic
  embed-images coverage, equal + missing timestamps, noise/`command-name` tags exercising
  `cleanUserText` vs verbatim, and an 80/81-code-point `tool_result` pair hitting the
  full+max80 boundary — deliberately NO integer-like keys or floats), staged +
  golden-diffed across the now-12-combo matrix (`tool-results-alone` and
  `raw+embed-images` added to `export-parity.mjs`). Hermetic exact-output pins for every
  ADR-0009 exception: #3 (`pyRepr` exotic Unicode literal), #4 both integer-key surfaces
  (fallback SET `T(1=…, 9=…, a=…)` and structured-value order), and new #5 (float-ness
  lost at `JSON.parse`). Endpoint `maxChars` clamp tests via body-equivalence (0→1,
  99999→20000, `abc`→default, `12abc`→12 parseInt truncation) + clamped `max1` download
  token; clamp-boundary filename tokens. **Bonus fix:** the smoke-test `check` helper
  never invoked function-valued conditions, so ~20 existing checks were passing
  vacuously — helper now invokes (try/catch), and all previously-vacuous checks
  genuinely pass. history=on→400 and auto→off were verified already-covered (no new
  work); a history-*content* fixture stays impossible until F. Tests 104→**114/0**.
  *Original spec below:*
- **D. Finish verification fixtures (§11 / ADR-0010 tier 1–2 / ADR-0009).** Filename-stem
  parity tests are **done** (`d1038c7`, hermetic `deriveFlagTokens`/`deriveExportFilename`,
  67/0) and the endpoint harness exists (`673f531`). Still add deterministic fixtures for:
  `maxChars` clamp + boundaries via the real endpoint; explicit history on/off; `toolResults`
  alone; `raw`+embed-images; equal/missing timestamps; and — per **sharpened ADR-0009 #4** —
  **both** integer-key surfaces of `summarizeToolUse` (the `Object.keys` fallback set *and* a
  structured value under a priority key like `input`/`arguments`; the `.slice(0,3)` cap can
  change *which* keys appear) plus the `ensure_ascii` non-ASCII case (#2). Diff full output.
- ✅ **E. DONE & committed (`c40d385`, 2026-07-07, jointly with D) — ADR-0009 escaping.**
  `jsonAscii` in `server/export.js` closes item #2: structured dict/list values now escape
  every UTF-16 code unit ≥ 0x80 as lowercase `\uXXXX` (astral chars as surrogate halves),
  byte-verified against CPython `json.dumps(..., ensure_ascii=True)` empirically *before*
  implementation and golden-proven after (edges fixture + real pinned Claude and Codex
  sessions, 12 combos each). ADR-0009 item 2 annotated **FIXED**; **new item 5** added
  during plan review (Codex Major): float formatting is *structurally unfixable* —
  `JSON.parse` collapses `1.0`→`1` before the serializer runs, so Python's
  `1.0`/`1e-07`/`-0.0` is unreproducible without a lossless JSON parser; accepted,
  hermetically pinned, golden fixtures must avoid non-integer numerics. #3/#4 remain
  accepted exceptions, now fixture-pinned (see D). Plan-reviewed (1 Major → item 5 +
  3 Minors folded) + impl-reviewed (0 findings) via `/codex-plan-review`.
  *Original spec below:*
- **E. ADR-0009 escaping — implement or accept-and-fix (§5).** #2 (`ensure_ascii`) is a **port
  gap to fix**; #3 (`pyRepr` exotic Unicode) + #4 (integer-key order) are **accepted, tested
  exceptions**; `pyStr` bool/None is **not** a gap (handled). Do alongside D — both add the
  same Unicode/structured-input fixtures.
- ✅ **F — loop F1 DONE & committed (`9fed1aa`, 2026-07-07): resolver + identity contract
  (ADR-0017), no 1B parsing.** New `server/sources/claudeBundle.js`: strict fail-closed
  `v1:<projectSlug>:<sessionId>` ref codec (charset `[A-Za-z0-9._-]`, `.`/`..` rejected,
  every derived path still `isInside`-checked) and `resolveBundle()` mirroring
  `resolve_session`'s era logic — main-only / main+folder+subagents (lexical) /
  folder-only / index-only, with the replayable-existence rule (bare empty folder →
  null, extract-session.py:199); `loadSessionIndex` moved there; `compositeSignature`
  (`relPath@mtimeMs:size`, sorted, `|`-joined over main+subagents+index) implemented and
  pinned with its F2 consumer contract (entries gain `cacheSignature: string|null`;
  `mtimeMs` stays the numeric sort key; search/list invalidate on
  `cacheSignature ?? mtimeMs`). `claude.js` `detail`/`collectEvents` accept both ref
  schemes via discriminated `resolveRefToMainPath` (path branch byte-unchanged;
  opaque without a main transcript → `not_found`); `not_found` → 404 mapped on both
  `/api/export` and `/api/conversation`. `ccv.starred` migrated once into a versioned
  source-agnostic envelope (`ccv.starred.v1`, pure `src/starred.js`; valid envelope
  wins, single serializer, future rewrites only when `version < target`). **`list()`
  deliberately unchanged** — opaque emission + one-card-per-identity + the Claude
  star-key rewrite land atomically in F2. Tests 114→**127/0** (codec, resolver era
  matrix + signature stability/mutation across all three artifact types in child
  processes, opaque≡path byte-equivalence for export+detail, endpoint 404s, starred
  envelope); golden parity re-verified byte-identical (pinned Claude + both Codex
  sessions, 12 combos). Plan-reviewed (REVISE → 5 findings folded: empty-folder
  fail-closed, explicit 404s, pinned signature contract, envelope precedence rules,
  endpoint-level 404 tests) + impl-reviewed (SHIP, 0 defects; 1 Info test-strength nit
  fixed pre-commit) via `/codex-plan-review`. **Remaining: F3 (1B converter) —
  original spec below.**
- ✅ **F — loop F2 DONE & committed (`96a9ab3`, 2026-07-07): listing/search
  integration.** `list()` flipped to opaque refs atomically with one card per
  logical identity: batched `resolveProjectBundles(slug)` (same validation/
  containment as the single path, ONE readdir + ONE cached index parse per
  project — the `loadProjectIndexMap` cache keys on the index file's
  mtime+size+missing/unreadable state, eviction test-pinned for rewrite AND
  deletion) shares `assembleBundle` with `resolveBundle`. Folder-only /
  index-only sessions gain metadata-only cards (index-derived title/counts/
  branch/cwd, `Number.isFinite`-guarded timestamps with `fileMtime` surfacing
  as visible ISO `lastActivity`, `resume: ''`, `contextUsage: null`,
  `exportable: false`) — ~292 recovered sessions surfaced locally
  (9,028→9,320 cards). Main-transcript cards keep transcript-derived display
  fields byte-for-byte (context-health computation untouched; index never
  consulted for them). `detail()` returns the ADR-0017 recovered metadata
  response (`recovered: 'folder-only'|'index-only'`, `messages: []`, title
  summary→firstPrompt fallback); `collectEvents` stays `not_found` → 404
  until F3 (ADR-0012). Entries carry `cacheSignature`; `server/search.js`
  invalidates on exported `entrySignature(c)` (`cacheSignature ?? mtimeMs`).
  `ccv.starred` envelope v2 (SAME permanent `ccv.starred.v1` storage key —
  the envelope `version` field tracks migrations) rewrites `claude:<path>.jsonl`
  keys to `claude:v1:<slug>:<id>` exactly once; non-Claude keys untouched.
  ADR-0017 amended with the recovered-session resolution note. Three UI
  guards (Export menu, resume copy, expanded resume line hidden on recovered
  cards). `isSidechain` index entries excluded at discovery only
  (loadSessionIndex semantics unchanged for parity). Tests 127→**134/0**
  (era-matrix list/detail child-process coverage, starred v2 rewrite matrix,
  entrySignature, cache eviction + same-stat unreadable recovery); golden
  parity byte-identical; build green. Plan-reviewed (REVISE → 6 findings
  folded) + impl-reviewed (FIX → 1 Major `lastActivity` leak + 3 Minors
  fixed across two rounds) via `/codex-plan-review`. **Remaining: F3 only.**
- **F. 1B (§7 + ADR-0017) — the big one; gate now accepted (ADR-0012).** Canonical Claude
  `SessionBundle` identity `{source, projectSlug, sessionId}` + **opaque versioned refs
  (Claude only** — others keep path refs, a deliberate two-scheme asymmetry). Shared resolver
  for `list`/`detail`/`collectEvents`/search → `{identity, mainPath, folderPath,
  subagentPaths, indexMeta, compositeSignature}`; one card per identity; scheme-tagged refs +
  **source-agnostic versioned `ccv.starred`** migration (so it never migrates twice); then the
  subagent/history/folder-only/index-only converter with the `{meta, events, resolvedOpts}`
  contract. **Constraint (§0):** the `claude.js` `list()` refactor must *preserve* the
  context-health computation now living there (context health is main-transcript-only, ADR-0017).
  *Multi-loop effort; do last.*
