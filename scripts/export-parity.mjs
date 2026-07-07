#!/usr/bin/env node
// Golden-diff harness: assert ASM's JS export is byte-for-byte identical to
// /session-tools:replay (extract-session.py) across a flag matrix, per ADR-0010
// (docs/adr-markdown-export-2026-07-01.md). Two-format: `codex` and `claude`.
//
// Usage:
//   node scripts/export-parity.mjs <source> <ref.jsonl> [<ref2.jsonl> ...]
//   EXTRACT_PY=/path/to/extract-session.py node scripts/export-parity.mjs codex <ref>
//
// `ref` must be an absolute path to the transcript (passed to BOTH the Python
// extractor and the JS adapter, so resolution is identical and unambiguous).
// Exits non-zero if any combination differs.
//
// Pinned reference sessions (see handoff / ADRs):
//   codex : ~/.codex/sessions/2026/06/30/rollout-*-019f1a6e-*.jsonl  (39 turns)
//           ~/.codex/sessions/2026/06/11/rollout-*-019eb994-*.jsonl  (images: [] + local_images)
//   claude: ~/.claude/projects/-Users-rymalia-projects/0af8a8ed-51cd-44f8-8afb-9dbd7f1d6337.jsonl
//           (text + 1 image + 32 thinking + 26 tool_use + 26 tool_result; NO index
//            entry — still the common case locally: 0 of 8420 live transcripts are
//            in any sessions-index.json. Index enrichment (ADR-0015) is covered by
//            the staged scripts/fixtures/claude-index-enrichment.* smoke check.)

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { collectEvents, exportCapabilities } from '../server/sources/index.js';
import { renderMarkdown, sourceEffectiveOptions } from '../server/export.js';

// ASM's formatTs renders in the process's local timezone (ADR-0018), while the
// Python reference slices the raw UTC string. Pin TZ=UTC so both sides format
// identical wall-clock values; Node ≥13 propagates a runtime TZ change to Date,
// and formatTs constructs Dates at call time, so setting it here is sufficient.
process.env.TZ = 'UTC';

const PY = process.env.EXTRACT_PY
  || `${os.homedir()}/projects/claude-session-tools/plugins/session-tools/scripts/extract-session.py`;

// Flag matrix as JS opts; the Python flags are DERIVED from these so the two
// sides can't drift. NOTE: no `--history` combos — history backfill is 1B
// (ADR-0012); a live main transcript resolves history=off on both sides.
const MATRIX = [
  { label: 'default', opts: {} },
  { label: 'full', opts: { full: true } },
  { label: 'thinking', opts: { thinking: true } },
  { label: 'tools+tool-results', opts: { tools: true, toolResults: true } },
  { label: 'tools+max200', opts: { tools: true, maxChars: 200 } },
  { label: 'full+max80', opts: { full: true, maxChars: 80 } },
  { label: 'raw+full', opts: { full: true, raw: true } },
  { label: 'verbatim+full', opts: { full: true, verbatim: true } },
  { label: 'tools+thinking', opts: { tools: true, thinking: true } },
  { label: 'full+embed-images', opts: { full: true, embedImages: true } },
];

function optsToPyFlags(o) {
  const f = [];
  if (o.full) f.push('--full');
  else {
    if (o.tools) f.push('--tools');
    if (o.toolResults) f.push('--tool-results');
    if (o.thinking) f.push('--thinking');
    if (o.sidechains) f.push('--sidechains');
  }
  if (o.verbatim) f.push('--verbatim');
  if (o.raw) f.push('--raw');
  if (o.embedImages) f.push('--embed-images');
  if (o.maxChars && o.maxChars !== 400) f.push('--max-chars', String(o.maxChars));
  return f;
}

// Use the endpoint's SOURCE-EFFECTIVE stage verbatim (export.js sourceEffectiveOptions:
// full-expand + history auto→off by capability) so this harness can't drift from
// /api/export. It intentionally SKIPS the capability-rejection gate — /replay has no
// HTTP gate, so the renderer legitimately handles combos (e.g. verbatim+full on Codex)
// that the endpoint 400s; those remain valid low-level renderer-parity cases.
function resolveOpts(source, combo) {
  const requested = {
    maxChars: 400, history: 'auto',
    full: false, tools: false, toolResults: false, thinking: false,
    sidechains: false, verbatim: false, raw: false, embedImages: false,
    ...combo,
  };
  return sourceEffectiveOptions(requested, exportCapabilities(source) || {});
}

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return `  line ${i + 1}:\n    py: ${JSON.stringify(la[i])}\n    js: ${JSON.stringify(lb[i])}`;
    }
  }
  return `  (identical line-by-line but length differs: py=${a.length} js=${b.length} bytes)`;
}

const [source, ...refs] = process.argv.slice(2);
if (!source || refs.length === 0) {
  console.error('usage: node scripts/export-parity.mjs <source> <ref.jsonl> [<ref2> ...]');
  process.exit(2);
}

let failures = 0;
for (const ref of refs) {
  console.log(`\n=== ${source} :: ${ref} ===`);
  for (const { label, opts: combo } of MATRIX) {
    const py = execFileSync('python3', [PY, ref, ...optsToPyFlags(combo)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const o = resolveOpts(source, combo);
    const { meta, events, resolvedOpts } = await collectEvents(source, ref, o);
    const js = renderMarkdown(events, meta, resolvedOpts || o); // mirror endpoint's final opts
    const ok = py === js;
    if (!ok) failures++;
    console.log(`  [${label.padEnd(20)}] ${ok ? '✓ identical' : '✗ DIFFERS'}`);
    if (!ok) console.log(firstDiff(py, js));
  }
}
console.log(`\n${failures === 0 ? '✓ all combinations byte-identical' : `✗ ${failures} combination(s) differ`}`);
process.exit(failures === 0 ? 0 : 1);
