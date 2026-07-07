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

These decisions govern the markdown-export architecture. Implementation progress,
commit references, and current test counts belong in
`plan-asm-markdown-export-2026-06-12.md`; this document records durable decisions.
Each ADR is **Decision / Why / Consequence** and carries an explicit status.

## ADR-0001 — Reimplement in Node; do not shell out to `extract-session.py`

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Implement export inside ASM's Node process. Do not invoke the
  Python extractor at runtime and do not add an `execFile` path for export.
- **Why:** This keeps Vite dev/preview behavior identical, avoids a Python runtime
  dependency and subprocess attack surface, and gives every source adapter the
  same normalized contract. `extract-session.py` now supports Claude and Codex;
  it remains the reference oracle, not a production dependency.
- **Consequence:** The Node and Python implementations can drift. ADR-0010 requires
  provenance-aware golden diffs and hermetic regression fixtures.

## ADR-0002 — Byte-for-byte parity is the acceptance bar

**Status:** Accepted (amended 2026-07-01)

- **Decision:** For supported source modes and accepted options, reproduce
  `/replay`'s rendered body and canonical flag tokens exactly, plus its **derived
  download stem** `replay-<short8>[-<tokens>]`. Filtering, truncation, ordering,
  headers, and role/block formatting are inside the parity boundary. The on-disk
  `-2/-3` collision suffix is **outside** the parity boundary — it is a
  `--save-dir` disk artifact, and ASM's streamed download never touches disk
  (ADR-0008).
- **Why:** The feature ports `/replay`; it does not redesign the transcript format.
  A bounded definition makes the parity claim testable instead of aspirational.
- **Consequence:** HTTP protocol behavior may intentionally differ only where an
  ADR says so (`maxChars` clamping, HTTP errors, caching, content-disposition
  encoding). Upstream rendering quirks are preserved. Avoidable JS differences
  are bugs; accepted exceptions must be enumerated and covered by fixtures under
  ADR-0009. The filename is **not** covered by the golden *body* diff (ADR-0010
  tier 3); its stem+token parity is pinned in a separate tier by hermetic
  `deriveFlagTokens`/`deriveExportFilename` unit tests in `scripts/smoke-test.mjs`
  asserting canonical stems (`--full` → `replay-c506e1c6-full.md`, no flags →
  `replay-c506e1c6.md`, and canonical — not request — token order). These verify
  "exactly" for the stem tier independently of the body diff.

## ADR-0003 — Normalized contract `{ role, ts, source, sidechain, meta, blocks[] }`

**Status:** Accepted

- **Decision:** One normalized event per source **record**; the renderer writes one
  header per event and iterates its `blocks[]`.
- **Why:** A Claude assistant message carries several blocks (text + thinking + N
  tool calls) under **one** header; Codex records are naturally one block each. The
  plan's original flat "one event per block" model produced multiple headers per
  message and miscounted turns.
- **Consequence:** Adapters decide granularity (Claude groups; Codex is 1-block).
  `block.kind ∈ { text, reasoning, thinking, tool_use, tool_result, image }`.

## ADR-0004 — `collectEvents` is flag-agnostic; filtering is render-time

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Adapters emit every available event unfiltered and do not mutate
  caller-owned options. `renderMarkdown` applies content filters. Collection-time
  discovery such as Claude history/folder recovery may return session-specific
  `resolvedOpts` alongside `{ meta, events }`.
- **Why:** Conversion remains independent of presentation while still allowing a
  recovered session to declare unavoidable effective settings.
- **Consequence:** Option handling follows ADR-0014's explicit pipeline:
  requested → capability-validated → source-effective → session-resolved. Filename
  tokens use accepted requested options before expansion; rendering uses final
  resolved options.

## ADR-0005 — Codex prompt source split

**Status:** Accepted

- **Decision:** User turns from `event_msg/user_message`; assistant from
  `response_item/message` (role=assistant); **drop** `event_msg/agent_message`
  (duplicate) and `response_item` role user/developer (injected AGENTS.md / env).
- **Why:** `response_item` user turns are polluted with injected context; the
  `event_msg` prompt is the clean, human-typed text. Verified: 5 clean prompts, no
  scaffolding leakage.
- **Consequence:** More robust than the existing `detail()` heuristic
  (`startsWith('<environment_context')`); adopt the same split there eventually.

## ADR-0006 — Codex tool-type coverage matches the reference (pragmatic tail cut)

**Status:** Accepted

- **Decision:** Handle `function_call` + `custom_tool_call` (+ their `_output`s) and
  `reasoning`. Drop `tool_search_*`, `web_search_*`, `mcp_tool_call_*`,
  `patch_apply_*`.
- **Why:** This is exactly what `/replay` does; the dropped types are ~3% of tool
  activity in local data (53 of ~1,640 calls).
- **Consequence:** `patch_apply_end` (which can carry real edits) is not captured — a
  conscious parity trade. If richer Codex coverage is wanted later, it must land in
  `/replay` first (ADR-0002).

## ADR-0007 — Full flag set mirrors `/replay`

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Expose `tools, tool-results, thinking, sidechains, history, full,
  max-chars, verbatim, raw, embed-images`; delivery is Copy or Download.
  `history` is tri-state `auto|on|off`, not boolean. `maxChars` defaults to 400.
- **Why:** These are `/replay`'s semantics, including `--no-history`; defaulting to
  unlimited output would break parity.
- **Consequence:** Source/phase applicability is not inferred in the UI. ADR-0013
  declares capabilities and ADR-0014 defines `full`, unavailable options, and
  requested-versus-effective resolution. History requires a three-state control.

## ADR-0008 — Download filename = `replay-<short8>[-<flags>].md`

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Port `derive_flag_tokens` (canonical order, computed **before**
  `--full` expands) + `derive_output_path`'s stem. **Override** plan §8's
  `${source}-${id}.md`.
- **Why:** Parity with `/replay`'s filenames (`replay-c506e1c6-full.md`, etc.).
- **Consequence:** Drop the `-2/-3` non-clobber loop — a streamed download never
  touches disk; the browser de-dupes. Deliver the logical filename through a safe
  RFC 6266/5987 `Content-Disposition`. Port collision handling only if a future
  server-side qmd save mode writes files.

## ADR-0009 — Upstream rendering quirks and accepted port exceptions

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Classify parity edge cases rather than calling every divergence an
  intentional replay behavior:
  1. **Upstream quirk preserved:** fence/inline-code breakage when tool output or
     summaries contain backticks. ASM must follow `/replay` until upstream changes.
  2. **Port gap to fix (FIXED 2026-07-07):** structured dict/list values must
     match Python `json.dumps(..., ensure_ascii=True)`; literal non-ASCII from
     `JSON.stringify` is not an accepted exception. Closed by `jsonAscii` in
     `server/export.js` (per-code-unit `\uXXXX` escaping, byte-verified against
     CPython), with a hermetic fixture and a golden-diffed non-ASCII
     structured-input case.
  3. **Accepted, tested exception unless later fixed:** `pyRepr` may keep exotic
     non-printable Unicode literal where CPython emits `\x/\u/\U` escapes.
  4. **Accepted, tested exception unless source order is preserved earlier:** V8
     canonicalizes integer-like object keys ascending on **both** surfaces of
     `summarizeToolUse` where key order is observed — the `Object.keys(...)`
     fallback key list **and** the `JSON.stringify` of a structured dict/list
     value serialized under a priority key such as `input`/`arguments` — whereas
     Python retains JSON insertion order in both. So
     `{"2":"x","0":"y"}` diverges as a fallback key set *and* as a tool-input
     value, independently of the item-2 `ensure_ascii` fix. On the fallback
     surface this compounds with the `.slice(0, 3)` cap: integer-key promotion can
     change **which** three keys appear, not merely their order (insertion
     `{a, b, "9", "1"}` → Python `[a, b, 9]` vs V8 `[1, 9, a]` — a different set).
     Both surfaces require a deterministic fixture.
  5. **Accepted, structurally unfixable exception (added 2026-07-07):** float
     formatting in structured tool-input values. Python re-serializes what the
     JSON parser preserved (`1.0` → `"1.0"`, `1e-07` → `"1e-07"`, `-0.0` →
     `"-0.0"`), while `JSON.parse` collapses `1.0` to the double `1` before the
     serializer runs, so V8 emits `1`, `1e-7`, `0`. Unlike items 2–4 this is not
     a porting choice: reproducing Python would require a custom lossless JSON
     parser. Pinned by a hermetic fixture asserting the JS output; golden
     fixtures must avoid non-integer numerics in structured tool inputs.
- **Why:** ADR-0002 remains meaningful only when upstream quirks, implementation
  bugs, and consciously accepted exceptions are distinct.
- **Consequence:** Remove the obsolete `pyStr` bool/None exception; it is handled.
  Every accepted exception needs a deterministic fixture. If `/replay` changes an
  upstream quirk, re-sync ASM and its goldens.


## ADR-0010 — Verification = golden-diff against `extract-session.py`

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Maintain three verification tiers:
  1. Hermetic unit/fixture tests runnable from any checkout.
  2. Endpoint-level tests covering parsing, resolution, successful response bodies,
     headers, filenames, and error mapping.
  3. Maintainer golden diffs against the Python extractor and representative local
     Claude/Codex transcripts.
- **Why:** Pure tests catch deterministic regressions; endpoint tests catch flag
  plumbing; live Python diffs detect semantic drift across implementations.
- **Consequence:** Each golden run prints the extractor path, plugin/version
  identifier, extractor SHA-256, source, and fixture/session identifiers. Reference
  changes must be attributable. Diff full output, not lengths. The maintainer gate
  may require `EXTRACT_PY`; hermetic tests must not require a sibling repository.

## ADR-0011 — Endpoint security & hygiene

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Export remains read-only and shell-free. Validate every resolved
  path with `isInside`; use own-property exporter dispatch; map unsupported source
  or unavailable option to 400 and containment failure to 403; clamp `maxChars` to
  `[1, 20000]`; set `Cache-Control: no-store` on every export response; and emit an
  injection-safe RFC 6266/5987 `Content-Disposition` on downloads.
- **Why:** Transcript content and absolute paths are private. Localhost does not
  remove the need for traversal, cache, prototype-property, or header-injection
  defenses.
- **Consequence:** The clamp is an explicit endpoint deviation from unbounded
  `/replay`. Containment tests must assert the `forbidden` failure specifically;
  catching `ENOENT` is not proof that containment ran. No export path writes files
  or invokes a shell.

## ADR-0012 — Phasing, and the folder-only listing gap (blocks 1B)

**Status:** Accepted (amended 2026-07-01)

- **Decision:** 1A contains the shared backend, Codex, Claude main transcripts,
  index enrichment for live main transcripts (ADR-0015), and the browser UI. The
  backend alone does not complete 1A's user-facing outcome. Claude subagents,
  `history.jsonl`, folder-only, and index-only recovery form a separate 1B change.
- **Why:** Folder-only and index-only sessions have no card today. Recovery changes
  identity, discovery, preview, search, cache invalidation, and persisted keys—not
  just `collectEvents`.
- **Consequence:** No 1B parsing work begins before the canonical `SessionBundle`
  resolver and identity contract in ADR-0017 are accepted.

## ADR-0013 — Per-source capability metadata (no hardcoded `source === 'claude'`)

**Status:** Accepted (amended 2026-07-01)

- **Decision:** Each adapter owns phase-accurate export capability metadata. Each
  option is `supported`, `notApplicable`, or `unavailable`; the registry exposes
  this through `/api/sources`. The frontend and endpoint consume the same metadata
  and never switch on source names.
- **Why:** A boolean cannot distinguish a source concept that does not apply from a
  feature that exists but has not been implemented in the current phase. That
  distinction controls `full`, errors, disabled-state copy, and future rollout.
- **Consequence:** Two representative contracts, paired to show the state that
  motivates the tri-value — `unavailable` (a real `/replay` feature not yet built
  in this phase) versus `notApplicable` (the source has no such concept at all):

  ```js
  // Claude adapter, Phase 1A. sidechains + history are real /replay features
  // that 1A has not implemented yet (1B, ADR-0012) → 'unavailable', NOT
  // 'notApplicable': they will exist for this source once 1B lands.
  export const exportCapabilities = {
    tools: 'supported',
    toolResults: 'supported',
    thinking: 'supported',
    sidechains: 'unavailable',
    history: 'unavailable',
    verbatim: 'supported',
    raw: 'supported',
    embedImages: 'supported',
  };

  // Codex adapter — same keys, and the differing states are the point.
  export const exportCapabilities = {
    tools: 'supported',
    toolResults: 'supported',
    thinking: 'supported',        // reasoning; '' → "[encrypted by Codex]"
    sidechains: 'notApplicable',  // Codex has no subagent concept
    history: 'notApplicable',     // no history.jsonl backfill concept
    verbatim: 'notApplicable',    // no Claude harness/meta tags to preserve
    raw: 'supported',
    embedImages: 'notApplicable',  // DECISION: the Codex collector emits NO image
                                   // blocks at all — attachments fold into a
                                   // "[N image(s) attached]" text note — so
                                   // --embed-images has nothing to act on (and
                                   // rollouts carry local paths, not inlineable
                                   // base64). Revisit to 'supported' only if a
                                   // rollout ever emits image blocks with bytes.
  };
  ```

  Missing/unknown values fail closed. UI labels explain `notApplicable` versus
  `unavailable` (Codex greys these permanently; Claude 1A greys them with a
  "coming in 1B" affordance). Explicit request behavior and `full` are defined by
  ADR-0014.

## ADR-0014 — Requested, effective, and resolved export options

**Status:** Accepted

- **Decision:**
  - Treat requested options as immutable. Session recovery may return
    `resolvedOpts` alongside `{ meta, events }` but may not mutate requested
    options.
  - Validate only **explicitly, individually selected** options against ADR-0013
    before collection. An explicit option that is `unavailable` or
    `notApplicable` for the source returns **400** with a body naming the
    offending option (e.g. `sidechains not applicable to source 'codex'`),
    rather than silently producing misleading content or a misleading filename
    token.
  - `history=auto` resolves to off when history is `unavailable` or
    `notApplicable`.
  - **`full` is a render directive, not a capability request.** It always expands
    to `tools + tool-results + thinking + sidechains` on, unconditionally and for
    every source, matching `/replay --full`. Capability state never gates `full`,
    and `full` never yields a 400. Constituents with no corresponding events
    (e.g. Codex sidechains, Claude-1A sidechains) render nothing and still appear
    as `on` in the filters header, exactly as `/replay` does. Its filename token
    remains `full`.
- **Why:** Source capability, phase completeness, session recovery, rendering, and
  filename derivation otherwise disagree about what the user requested and what
  the export contains. `/replay` never rejects `--full`; it sets the four render
  flags regardless of whether matching content exists, and `/replay --full` is
  verified byte-identical to ASM on both a Claude main transcript and a Codex
  rollout (each with `sidechains=on` and no sidechain events). Gating or trimming
  `full` by capability would break those golden diffs and 400 the flagship export.
  The 400 for an explicit *individual* unavailable/notApplicable option is a
  deliberate HTTP-layer divergence from `/replay`'s tolerance, sanctioned by
  ADR-0002; it mainly guards direct API callers, since the capability-filtered UI
  cannot select such an option.
- **Consequence:** The endpoint implements:

  ```text
  requested options
    → capability validation   (explicitly selected options only)
    → source-effective options (full expands here, unconditionally)
    → session-resolved options
    → renderer
  ```

  Capability validation acts on explicitly selected options only; `full` is
  exempt from that gate and expands at the source-effective stage. Filename
  tokens derive from accepted requested options before `full` or folder-only
  expansion (so the token is `full`, never its components). `renderMarkdown`
  receives final resolved options. Tests cover every resolution boundary,
  including: `full` accepted and byte-identical for Claude 1A and Codex (with
  `sidechains=on` in the header and no sidechain content); an explicit
  `sidechains` or `history` on a source where it is `unavailable`/`notApplicable`
  → 400 with the option named; and `history=auto` → off when unavailable.

## ADR-0015 — Claude live-main index enrichment belongs to 1A

**Status:** Accepted

- **Decision:** When exporting a Claude main transcript, load matching metadata
  from the `sessions-index.json` in the **same project-slug directory as the
  `.jsonl`** — `/replay`'s direct-path branch calls `load_session_index(p.parent,
  p.stem)` (`extract-session.py:130`), i.e. `~/.claude/projects/<slug>/`, **not**
  the `<id>/` companion subagents folder — exactly as `/replay` does. This is live
  main-transcript enrichment, not index-only recovery.
- **Why:** The current zero-overlap audit is an observation about local data, not a
  format guarantee. The Python reference performs this lookup for direct transcript
  paths, and the renderer already supports the resulting header fields.
- **Consequence:** Add a synthetic main transcript beside an overlapping index
  fixture and golden-diff it. Index-only discovery, logical identity, and recovery
  remain 1B work under ADR-0017.

## ADR-0016 — Browser delivery, interaction, and size policy

**Status:** Accepted

- **Decision:** Copy fetches the export, checks `response.ok`, buffers text, measures
  UTF-8 bytes, and writes to the clipboard only under a 2 MiB soft cap. Above the
  cap, present an explicit Download action; never start an automatic download from
  Copy. Download uses a direct server response and server-controlled
  `Content-Disposition` so the browser can stream without client-side buffering.
  Download errors open visibly rather than being silently saved as markdown.
- **Why:** Copy and Download have different memory, permission, and failure
  characteristics. An explicit boundary prevents JSON errors from being copied and
  avoids surprising downloads.
- **Consequence:** Only one export menu may be open. It supports Escape,
  outside-click, focus return, keyboard navigation, and event-propagation isolation
  from card expansion. Persisted options are schema-validated and capability-filtered
  before use. Server rendering remains buffered and Download remains unbounded in
  Phase 1; streaming render is deferred until large-session measurements justify it.

## ADR-0017 — Canonical Claude `SessionBundle` identity and resolver

**Status:** Accepted

- **Decision:** Identify a Claude session logically as
  `{ source: 'claude', projectSlug, sessionId }`, independent of which physical
  artifacts survive. A shared resolver used by `list`, `detail`, `collectEvents`,
  and search returns `{ identity, mainPath, folderPath, subagentPaths, indexMeta,
  compositeSignature }`. Public refs are versioned opaque encodings of logical
  identity and never contain caller-controlled filesystem paths.
- **Why:** Main transcripts, companion folders, subagents, and index records are
  representations of one session. Path identity creates duplicate cards and breaks
  expansion, search, stars, and caches when files are cleaned up.
- **Consequence:** Emit one card per identity with deterministic
  main/folder/index precedence and lexically sorted subagents. Validate every
  resolved path under the Claude root. Migrate persisted path-based stars/keys.
  Context health comes from the main transcript only and is unavailable without
  one. Define explicit preview/search behavior for folder-only and index-only
  sessions. Global `history.jsonl` does not invalidate listing caches and is read
  only when export resolution requires it. History timestamps use exact
  `YYYY-MM-DDTHH:mm:ss.mmmZ` UTC formatting.

  **Known, deliberate asymmetry (Phase 1B):** only Claude adopts opaque refs;
  every other adapter (Codex included) keeps `ref = <absolute path>`, because only
  Claude collapses multiple physical artifacts (main / folder / subagents / index)
  into one logical session — a Codex rollout path *is* stable identity with no
  recovery problem to solve. Generalizing opaque refs to all nine now would be
  YAGNI. The cost is that `list`, `detail`, search, and `ccv.starred` straddle two
  ref schemes by design. To keep that a one-time cost rather than a second
  migration: (a) tag every ref with a scheme/version discriminator so
  `getConversation`/search/stars dispatch opaque-vs-path unambiguously instead of
  sniffing, and (b) migrate `ccv.starred` to a **source-agnostic, versioned** key
  now, so a future opaque-ref source never forces Claude's stars to re-migrate.
  The two-scheme straddle is accepted as the price of not generalizing
  prematurely.

## ADR-0018 — Export timestamps render in local time; parity runs under TZ=UTC

**Status:** Accepted (2026-07-06)

- **Decision:** `formatTs` converts each event/header timestamp to the export
  process's **local timezone** before rendering, keeping the reference's
  `YYYY-MM-DD HH:MM:SS` shape. The Python extractor (`format_ts`) slices the
  raw UTC ISO string; this is a deliberate, enumerated divergence under
  ADR-0002/ADR-0009. Unparseable timestamps fall back to raw string slicing.
- **Why:** Exports are read by a human in their own timezone; raw UTC
  wall-clock values were routinely 7–8 hours "off" for the maintainer (PDT).
- **Consequence:** Timezone presentation moves **outside** the byte-parity
  boundary. To keep golden diffs meaningful, `scripts/export-parity.mjs` pins
  `process.env.TZ = 'UTC'`, under which the JS output is byte-identical to the
  Python reference (Node ≥13 propagates a runtime TZ change to `Date`). Any
  future hermetic fixture that asserts an exact rendered timestamp must pin TZ
  the same way. If `/replay` later localizes upstream, re-sync and drop the
  divergence note.
