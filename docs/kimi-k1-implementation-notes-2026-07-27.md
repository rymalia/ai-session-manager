---
date: 2026-07-27
type: implementation-reference
status: planned
project: ai-session-manager
scope: Kimi K1 — list, detail, subagents, model metadata, usage
related:
  - ../NEXT-STEPS.md
  - session-summary-2026-07-27-backlog-triage-stats-tooltips.md
---

# Kimi K1 implementation reference

`NEXT-STEPS.md` controls backlog scope, priority, and completion status. Existing
ADRs remain authoritative for export behavior. This reference explains the
non-obvious K1 contracts an implementer cannot safely infer from the generic
three-function adapter interface.

K1 ends at first-class list/detail/subagent/model/usage support. It does **not**
add `collectEvents`, export capabilities, Markdown rendering, or download
filenames. Those belong to K2 after a dedicated ADR chooses the guarantee and
renderer contract for a self-defined Kimi Markdown format.

## Why Kimi needs a real event parser

Kimi's `wire.jsonl` is not an Anthropic-style message transcript. User-facing
and assistant-facing data are split across record families:

| Wire record | K1 meaning |
|---|---|
| `turn.prompt` with `origin.kind === "user"` | Canonical human prompt |
| `context.append_message` | Context assembly; may duplicate prompts and include injected reminders or skill material, so it is not the user-turn source |
| `context.append_loop_event` / `content.part` | Assistant text or thinking, selected by `part.type` |
| `context.append_loop_event` / `tool.call` | Assistant tool call |
| `context.append_loop_event` / `tool.result` | Tool result associated by `toolCallId` |
| `context.append_loop_event` / `step.begin` and `step.end` | Boundaries for grouping one assistant step |
| `llm.request` | Model and thinking-effort snapshot |
| `usage.record` | Consumed-token accounting |

The reader should group assistant content, thinking, and tool calls by step
rather than making every low-level record a separate UI message. Tool results
remain tool-role messages in their wire order. Apply `lastN` only after all
selected agent streams have been parsed, merged, and normalized.

Only canonical human prompts count as user messages or title fallbacks. Do not
surface permission-mode injections, todo reminders, skill bodies, or duplicated
context-assembly messages as user turns.

## Identity and containment

Use `sessionId` as the public adapter ref. It is stable across project movement,
matches the resume command, and avoids turning an absolute index path into
public identity.

Resolve it through `~/.kimi-code/session_index.jsonl` with these rules:

1. Parse defensively and ignore malformed lines.
2. Treat the index as append-only input: duplicate session ids resolve
   last-record-wins.
3. Resolve `sessionDir`, then require it to be inside `~/.kimi-code`.
4. Read `state.json` only from that validated directory.
5. Resolve every `agents[*].homedir`, requiring it to be inside both the session
   directory and the Kimi root before opening `wire.jsonl`.

These checks protect a different boundary from the ordinary `ref` traversal
test: both the caller and locally stored metadata influence what the adapter
could read. A syntactically valid session id whose index/state points outside
the root must be rejected or skipped, never followed.

Unknown but well-formed ids should produce the repository's `not_found`
behavior. Traversal-shaped or path-shaped refs must never be interpreted as
filesystem paths. Listing should isolate bad sessions and continue, matching
the source registry's failure-isolation principle.

## Normalized session summary

Build the card summary from the logical session, not just `state.json`:

- Title: `state.title`; `isCustomTitle` is provenance, not a second title.
- Project: `state.workDir`, falling back to the index `workDir`.
- First activity: the earliest valid conversational wire timestamp, falling
  back to `state.createdAt`.
- Last activity: the newest valid wire timestamp across included agents.
  `state.updatedAt` is only a fallback because it can trail active wire data.
- First user text: the first canonical human prompt.
- Message count: canonical user turns plus grouped assistant steps; tool-result
  rows do not add to this count.
- Resume: the normal quoted-cwd prefix followed by `kimi -S <sessionId>`.
- Model metadata: the last `llm.request` from the **main** agent, using B2's
  shared last-turn model/effort contract. A later subagent request must not
  relabel the session stripe.

Use artifact mtimes for parser-cache invalidation, but do not substitute them
for valid conversational timestamps shown to the user.

## Subagent merge and provenance

`state.agents` is the resolver input. Parse main and subagent wires through the
same normalization path, then merge normalized messages by wire timestamp.
Equal timestamps need a stable tie-break: main before subagents, then lexical
agent key, then original record order.

Every normalized message should retain:

- `source`: `main` or a stable `subagent:<key>` tag;
- `sidechain`: true for non-main agents.

“Subagents folded in” also requires visible provenance in the expanded preview;
silently attaching ignored fields is not enough. Prefer a compact addition to
the existing role label or another low-noise marker, while keeping the accepted
message roles (`user`, `assistant`, `tool`) unchanged for the shared UI and
smoke-test contract.

Because search reads `detail()`, the list entry needs a composite
`cacheSignature` covering `state.json` and every included wire. A subagent-only
append must invalidate search even when the main wire did not change.

## Usage semantics

Aggregate only `usage.record`; `step.end.usage` describes the same completed
steps and would double-count. Sum the recorded input, output, cache-read, and
cache-creation components across every resolved agent wire.

Expose this as `kind: "consumed"` with an honest all-time/local-records note.
Kimi stores no remaining-quota snapshot in this session format, so do not use a
quota label or percentage treatment. Cache usage results from the same
multi-artifact signature principle used by the conversation adapter.

## Integration boundaries

The source registry and `SOURCE_META` remain the canonical homes for adapter and
display registration. K1 also crosses these less-obvious boundaries:

- the shared B2 model field and stripe badge;
- Usage aggregation and its source metadata fallback;
- tool-label sorting and the main app metadata fallback;
- the fixed Agents registry, including Kimi's binary, config location, launch
  command, and built-in updater;
- README/package discovery text;
- search invalidation for multi-wire sessions.

Pick one distinct source color in `SOURCE_META` and mirror it only where the
frontend deliberately carries an offline fallback. Do not create a second
independent Kimi metadata registry.

## Hermetic acceptance matrix

Stage Kimi data under a temporary HOME and import the adapter in a child process,
because source roots are captured at module load. The fixture suite should prove:

- main-only list/detail fields and the `kimi -S` resume command;
- canonical prompts without injected context or duplicated
  `context.append_message` content;
- grouped text, thinking, tool calls, and tool results in wire order;
- a main-plus-subagent session with deterministic merge order and visible
  sidechain provenance;
- last-**main**-request model/effort when a subagent uses another model;
- wire-derived recency when `state.updatedAt` is stale;
- usage totals from `usage.record` without `step.end` double-counting;
- search signature mutation after a subagent-only append;
- malformed index/state/wire records being isolated rather than aborting the
  source;
- caller traversal, sibling-prefix paths, unknown ids, malicious
  index-provided `sessionDir`, and malicious state-provided `homedir`;
- source metadata, Usage, and Agents surfaces exposing Kimi consistently.

Finish with the canonical smoke test and production build, then perform a local
UI check of a Kimi card, expanded main/subagent preview, model badge, Stats
source color, Usage card, and Agents entry. Browser tooling or Peekaboo may be
used according to which is more reliable for the target; screenshots must stay
local and must not be sent to an external analysis API.

## K2 handoff boundary

Do not opportunistically reuse the current replay renderer during K1. It embeds
Claude/Codex assumptions in headers, capabilities, verification, and filenames.
The K2 ADR must first decide:

- the canonical Kimi event grouping and Markdown shape;
- supported versus not-applicable export options;
- subagent representation;
- source-aware header and filename ownership;
- checked-in golden provenance and how it differs from live upstream parity;
- how existing Claude/Codex byte parity remains protected.

Until that ADR lands, Kimi should correctly report as non-exportable through the
existing source-capability mechanism.
