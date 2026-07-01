#!/usr/bin/env node
// Golden-diff harness: assert ASM's JS export is byte-for-byte identical to
// /session-tools:replay (extract-session.py) across a flag matrix, per ADR-0010
// (docs/adr-markdown-export-2026-07-01.md). Two-format: works for `codex` today,
// and for `claude` once server/sources/claude.js gains collectEvents.
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
//   claude: ~/.claude/projects/-Users-rymalia-projects/0af8a8ed-51cd-44f8-8afb-9dbd7f1d6337.jsonl
//           (text + 1 image + 32 thinking + 26 tool_use + 26 tool_result; NO index
//            entry — which is the normal case: 0 of 8420 live transcripts are in
//            any sessions-index.json, so index enrichment is a 1B-only concern.)

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { collectEvents } from '../server/sources/index.js';
import { renderMarkdown } from '../server/export.js';

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

// Mirror /api/export's opts resolution EXACTLY (vite.config.js). If you change
// the endpoint's resolution, change it here too.
function resolveOpts(source, combo) {
  const o = {
    maxChars: 400, history: 'auto',
    full: false, tools: false, toolResults: false, thinking: false,
    sidechains: false, verbatim: false, raw: false, embedImages: false,
    ...combo,
  };
  if (source === 'codex') o.history = 'off';
  if (o.full) o.tools = o.toolResults = o.thinking = o.sidechains = true;
  return o;
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
    const { meta, events } = await collectEvents(source, ref, o);
    const js = renderMarkdown(events, meta, o);
    const ok = py === js;
    if (!ok) failures++;
    console.log(`  [${label.padEnd(20)}] ${ok ? '✓ identical' : '✗ DIFFERS'}`);
    if (!ok) console.log(firstDiff(py, js));
  }
}
console.log(`\n${failures === 0 ? '✓ all combinations byte-identical' : `✗ ${failures} combination(s) differ`}`);
process.exit(failures === 0 ? 0 : 1);
