---
date: 2026-08-05
type: implementation-reference
status: planned
project: ai-session-manager
scope: Antigravity CLI (agy) — list, detail, model metadata, project attribution, usage, agents
related:
  - ./kimi-k1-implementation-notes-2026-07-27.md
  - ../server/sources/gemini.js
  - ../server/sources/kimi.js
---

# Antigravity CLI (`agy`) adapter — implementation reference (A1)

This freezes the non-obvious contracts for wiring **Antigravity CLI** (`agy`,
Google's successor to Gemini CLI, v1.1.10) into ASM as the **eleventh** first-class
source. It was written after full on-disk reconnaissance against real local data.
If this doc and a shorter work-order disagree, **this doc wins**.

The kimi K1 notes (`kimi-k1-implementation-notes-2026-07-27.md`) are the structural
template for everything not spelled out here (single-file ownership, hermetic
harness under a temp HOME, fails-open, containment discipline). Read `kimi.js` and
`gemini.js` as the sibling adapters to match.

Antigravity is `source = 'antigravity'`, `SOURCE_META.short = 'AGY'`. **CLI-only**:
this adapter surfaces the `agy` CLI store, never the Antigravity IDE store.

## Non-goals (A1 ends here)

- **No Markdown export.** Do NOT add `collectEvents` / `exportCapabilities`. The
  registry auto-reports `exportable: false`. (An export ADR, like Kimi's K2, would
  be a separate future item.)
- **No protobuf parsing.** The authoritative per-session store
  (`conversations/<id>.db`) holds conversation content as **schemaless protobuf
  blobs** (reverse-engineered during recon). We deliberately DO NOT parse it for
  message content. Everything user-visible comes from the clean JSONL transcripts
  Antigravity writes alongside. The one narrow, protobuf-free exception is a byte
  regex over the `.db` for project attribution (below) — no wire-format decoding.
- **No token/quota usage.** `agy` stores real token counts only inside the
  protobuf blobs; we don't reach in. Usage is reported as `kind:'activity'`
  (session/message counts), honestly labeled.

## Storage layout & identity

Root: `~/.gemini/antigravity-cli/` (call it `ROOT`). Relevant artifacts:

| Path | Role |
|---|---|
| `brain/<conversation-id>/.system_generated/logs/transcript.jsonl` | Concise JSONL transcript (tool output truncated) |
| `brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl` | **Full** JSONL transcript — this is the detail spine |
| `conversations/<conversation-id>.db` | SQLite; protobuf step blobs. Used **only** for the attribution byte-scan |
| `cache/last_conversations.json` | `{ workspace: conversation-id }` — partial reverse map |
| `conversation_summaries.db` | Global summary table; **under-reports CLI sessions**, so NOT the list source |

`<conversation-id>` is a UUID (`9025ed1d-ff63-4333-9dd0-858f97e928f7`). It is:

- the **public adapter `ref`** (stable, matches resume, never a raw path);
- the `brain/<id>` dir name and the `conversations/<id>.db` name.

Resume command: `` `${cdPrefix(cwd)}agy --conversation <id>` `` (the `--conversation`
flag resumes by id; verified in `agy --help`).

## List source — enumerate `brain/`, derive from the transcript

Do **not** use `conversation_summaries.db` as the list source: it listed only the
IDE session on this machine and omitted both CLI sessions. Instead:

1. `readdir(${ROOT}/brain)`. For each entry that is a directory whose name is a
   valid UUID **and** which contains
   `.system_generated/logs/transcript_full.jsonl`, it is a session. Skip anything
   else (isolate-and-continue on a bad entry, per the registry's failure model).
2. Parse that transcript (see next section) into counts + timestamps + first user
   text. Build the card with `makeEntry`:
   - `id`: conversation-id; `ref`: conversation-id.
   - `title`: first canonical user prompt, sliced (makeEntry already does the
     `firstUserText` fallback). If `conversation_summaries.db` happens to carry a
     non-empty `title`/`preview` for this id, prefer that (curated). Optional.
   - `cwd`: project attribution (below).
   - `userCount` / `assistantCount`: see counting rule.
   - `firstActivity` / `lastActivity`: min / max `created_at` across steps (the
     JSONL timestamps are clean ISO-8601 — use them, not file mtimes).
   - `mtimeMs`: newest of {transcript_full mtime, transcript mtime} for the
     parser cache; also the numeric sort fallback.
   - `resume`: as above.
   - `model` / `effort`: see extraction.
3. Per-file mtime cache (`Map(file → {mtimeMs, summary})`) exactly like every other
   adapter — re-parse only when the transcript mtime changes.

`cacheSignature`: not required (single transcript file per session ⇒ `mtimeMs`
suffices). Leave null.

## Detail source — parse `transcript_full.jsonl`

Each line is a JSON object:
`{ step_index, source, type, status, created_at, content?, tool_calls? }`.

`source ∈ {USER_EXPLICIT, MODEL, SYSTEM}`. `type` is the discriminator. Map to the
shared `{role, text}` message contract (roles limited to `user|assistant|tool`; text
uses the marker vocabulary `🔧`/`↳`/`💭` via the `_shared.js` helpers):

| `type` | Handling |
|---|---|
| `USER_INPUT` | **user** turn. Extract only the `<USER_REQUEST>…</USER_REQUEST>` body as the text. Strip `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, and any other `<TAG>…</TAG>` injected blocks — they are not user content. (Parse `<USER_SETTINGS_CHANGE>` for model/effort *before* discarding — see below.) If there is no `<USER_REQUEST>` wrapper, fall back to the whole `content` with the metadata blocks removed. |
| `PLANNER_RESPONSE` | **assistant** turn, emitted as ONE message whose `text` concatenates (newline-joined, empties dropped, in this order): (a) `thinkingLine(thinking)` if a non-empty `thinking` string field is present (💭 — it is a first-class field, observed on real data); (b) `content` if non-empty; (c) one `toolUseLine(tc.name, tc.args)` per entry in `tool_calls` (🔧). A single step routinely carries `thinking`+`tool_calls` or `content`+`thinking`; include every part present. (`args` values are JSON-encoded strings, e.g. `"true"`; unwrap one level of quoting where trivially possible, else pass through — `toolUseLine` will stringify.) `App.jsx`'s `segmentText()` splits the markers back out, so the concatenation is correct — do not split into multiple messages. |
| `CONVERSATION_HISTORY`, `CHECKPOINT` | **skip** (SYSTEM markers, no user-facing content). |
| Any other `type` **with `content` and `source==='MODEL'`** (e.g. `VIEW_FILE`, `LIST_DIRECTORY`, `RUN_COMMAND`, `EDIT_FILE`, …) | **tool** result. `text = toolResultLine(content)`. These are tool-execution records named after the tool; do not enumerate a fixed list — treat "MODEL step that is neither PLANNER_RESPONSE nor a known marker, and has content" as a tool result. |
| Unknown `type`, `source==='MODEL'`, no `content` but has `tool_calls` | assistant tool call (as PLANNER_RESPONSE). |
| Anything else | skip defensively. |

The `thinking` field (💭) is handled inline in the `PLANNER_RESPONSE` row above —
it is real and present on observed data, not hypothetical.

Apply `lastN` **after** the full message list is built (`messages.slice(-lastN)`).

`detail(ref)` returns `{ source, id, title, projectPath, gitBranch:null, resume,
messages }` — same shape as `gemini.js`/`kimi.js`.

### Message counting

`userCount` = # `USER_INPUT` steps; `assistantCount` = # `PLANNER_RESPONSE` steps.
`messageCount = userCount + assistantCount`. **Tool-result rows do not count**
(matches Kimi).

## Model / effort extraction (documented deviation from B2's "RAW id" wording)

`agy` records the model in two places: the protobuf `gen_metadata` (raw
`gemini-3.6-flash`) and, human-readable, inside the first `USER_INPUT`'s
`<USER_SETTINGS_CHANGE>` block:

```
The user changed setting `Model Selection` from None to Gemini 3.6 Flash (High). …
```

**A1 extracts model+effort from that transcript text** (protobuf-free), via
`/Model Selection`.*?\bto\s+(.+?)\s*\(([^)]+)\)/`:

- `model` = the captured name verbatim, e.g. `"Gemini 3.6 Flash"`, `"Claude Opus 4.6"`.
- `effort` = the parenthetical lowercased.

`agy` runs **non-Gemini models too** (`agy models`: Claude Sonnet/Opus, GPT-OSS),
and the parenthetical carries the reasoning mode for **all** of them — Gemini
`(High|Medium|Low)`, Claude `(Thinking)`, GPT-OSS `(Medium)`. So the regex accepts
**any** parenthetical, not just the Gemini levels, and the `(` (never a `.`)
delimits the model name — model names contain dots (`Claude Opus 4.6`).

Treated as ONE pair, from the session's model selection (persists for the session).
Both are **nullable** — a session that never surfaced a settings-change gets no
badge (fine, per B2).

**Deviation note (call it out for review, à la Kimi's amendment):** B2 says `model`
is the *raw* id. Here the raw id lives only in the protobuf we are deliberately not
parsing, so A1 emits the friendly name that `agy` actually wrote into its
user-facing transcript. This is still faithful to "what the tool recorded" (the
honesty rule) for the data source we chose, and `src/modelLabel.js` passes unknown
names through unchanged, so it renders cleanly. Extracting the raw
`gen_metadata` id is a possible future enrichment; do not add protobuf for it in A1.
Verify `modelLabel.js` renders `"Gemini 3.6 Flash"` acceptably (raw passthrough); no
change to `modelLabel.js` is expected.

## Project attribution (best-effort, protobuf-free, fails open)

No clean per-session workspace map exists (`last_conversations.json` is partial and
`conversation_summaries.db.workspace_uris` was empty for the one CLI-adjacent row).
Resolve `cwd` in this priority, first hit wins, each wrapped so a failure falls
through — never throws, never hides:

1. **Byte-scan of `conversations/<id>.db`** (protobuf-free): read the file as a
   buffer, regex `/file:\/\/(\/[^\0-\x1f"\\]+)/g`, `decodeURIComponent` each,
   keep those that (a) resolve to an **existing directory**, (b) are **under
   `os.homedir()`** and **not under `~/.gemini`**. From the survivors pick the
   **shortest path** (the workspace root is an ancestor of tool-touched subdirs).
   Verified: yields `/Users/rymalia/projects` and
   `/Users/rymalia/projects/ai-session-manager` for the two real sessions.
2. `cache/last_conversations.json` reverse map (`workspace → id`): if `id` appears
   as a value, use its key. (Authoritative but partial.)
3. `conversation_summaries.db.workspace_uris` first URI, if a row for `id` exists.
4. `null` → `projectLabel` renders `(unknown)`; the session is still shown and
   counted. **Fails open** — an unresolved project overcounts, never hides work
   (matches the whole codebase's rule and keeps the B6 blocklist honest).

Cache the resolved `cwd` in the per-file summary so the db byte-scan runs once per
session per mtime, not per request.

## Security / containment

`detail(ref)` and any internal path build from `ref` must be fail-closed:

- Validate `ref` against a strict UUID charset **first**:
  `/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/`.
  Reject `.`, `..`, `/`, and any path-shaped ref (mirrors opencode's `ses_…`
  charset guard) → throw `'forbidden'`.
- After building the transcript path, `path.resolve` it and require
  `isInside(resolved, ROOT)` → else throw `'forbidden'` (→ 403), same as every
  file adapter.
- The attribution byte-scan reads only `${ROOT}/conversations/<validated-id>.db`;
  the paths it *extracts* are used solely for `statSync(...).isDirectory()` and
  string comparison — never opened, so they add no read surface. Still, only accept
  directories under `os.homedir()` (defensive).
- An unknown-but-well-formed id → repo `not_found` behavior. `list()` isolates a
  bad session and continues.

Add `antigravity` to the smoke-test's `SIBLING` map with an `antigravity-evil`
sibling-prefix ref and a traversal ref; the build must fail if either reads. Because
the ref is a UUID (not a path), the sibling-prefix case proves the **charset guard**
rejects a non-UUID ref — do not use a path-shaped evil ref that a broken guard would
*also* reject for the wrong reason (the Kimi `.kimi-code-evil` lesson).

## Integration boundaries (mirror what Kimi touched)

- **`server/sources/antigravity.js`** — the adapter (this file's contract).
- **`server/sources/index.js`** — import + add to `ADAPTERS`.
- **`server/sources/_shared.js` → `SOURCE_META`** — add
  `antigravity: { label: 'Antigravity CLI', short: 'Antigravity', color: '<distinct>' }`.
  (The `short` was 'AGY' in the first cut; changed to 'Antigravity' at the user's
  request on 2026-08-05 — the header chip reads the full word.)
  Color must be visually distinct from the existing ten on the Stats per-source
  bars. Proposed: **`#6366f1`** (indigo) — on-brand for Antigravity and distinct
  from grok's pale lavender `#9b87f5` and cursor's sky `#4d9fff`; **confirm live**
  on the Stats bars and adjust if muddy.
- **`server/usage.js`** — an Antigravity section, `kind:'activity'`: conversation
  count + total message count from `brain/`, honest note that `agy` stores no
  accessible token/quota data. Re-derive project independently (do NOT route through
  `listConversations()`), consistent with the file's design.
- **`server/agents.js`** — a registry entry: binary `agy`, version `agy --version`
  (→ `1.1.10`), config dir `~/.gemini/antigravity-cli`, launch `agy`, update
  `agy update`; `conversationCount` from the `brain/` session count.
- **Frontend offline fallback** — wherever `App.jsx` / `sortConvos.js` / `Usage`
  carry a hardcoded source-label/color fallback, add `antigravity` (Kimi added the
  same set; grep for `kimi` to find every site).
- **README / package discovery text** — add Antigravity to the supported-tools list
  wherever the other ten are enumerated.

Do **not** create a second Antigravity metadata registry; `SOURCE_META` +
`agents.js` are the canonical homes.

## Hermetic acceptance matrix (`scripts/antigravity-adapter-test.mjs`)

Stage fixtures under a temp `HOME` and import the adapter in a child process
(source roots are captured at module load — the Kimi harness is the template).
Prove:

- main list fields + the `agy --conversation <id>` resume string;
- canonical user prompt = `<USER_REQUEST>` body only, with
  `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` stripped;
- `PLANNER_RESPONSE` text, `PLANNER_RESPONSE` tool_calls (`🔧`), a `PLANNER_RESPONSE`
  carrying a `thinking` string (💭) **combined with** tool_calls in the SAME message
  (assert order: 💭 before 🔧, one message not two), and a tool-result step (`↳`),
  all in transcript order;
- `CONVERSATION_HISTORY` / `CHECKPOINT` skipped and excluded from `messageCount`;
- model+effort parsed from `<USER_SETTINGS_CHANGE>` (`Gemini 3.6 Flash` / `high`),
  and **absent** settings-change → `model===null && effort===null`;
- `firstActivity`/`lastActivity` derived from step `created_at`, not mtime;
- project attribution: (a) db byte-scan picks the shortest existing non-`.gemini`
  dir; (b) missing `.db` → falls through to `last_conversations.json`; (c) nothing
  resolves → `cwd` null / `(unknown)` and the session is still listed;
- `lastN` truncation applied post-merge;
- malformed transcript line isolated (skipped), not fatal;
- containment: caller traversal ref, non-UUID sibling-prefix ref, unknown UUID —
  the first two rejected/forbidden, the last → not_found;
- Usage `activity` counts and the Agents entry present and consistent.

Finish with `npm test` (smoke suite, must stay green and +N for the new SIBLING /
source checks), `npm run build`, and a **live UI check** of an Antigravity card,
expanded transcript (user / assistant / tool markers), model badge, Stats source
color, Usage card, and Agents entry. Screenshots stay local.

## Verification owned by Claude (not the delegate)

Per repo policy, the coding agent's self-reported "green" is not trusted. Claude
runs `npm test` in a clean state, spot-reproduces the containment assertions, and
does the live UI check itself.
