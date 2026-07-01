// Smoke test: exercises every source adapter + the usage/open modules against
// the real local data, validating the API data contract. Run with `npm test`.
// Exits non-zero on any failure.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listConversations, getConversation, collectEvents, exportCapableSources, SOURCE_META } from '../server/sources/index.js';
import { getUsage } from '../server/usage.js';
import { openPath } from '../server/open.js';
import { searchContent } from '../server/search.js';
import { renderMarkdown, truncate } from '../server/export.js';

let pass = 0;
const fails = [];
const check = (name, cond) => { cond ? pass++ : fails.push(name); };
const acheck = async (name, fn) => { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const t0 = Date.now();

// ---- list contract ----
const all = await listConversations();
check('list returns array', Array.isArray(all));
// An empty list is valid on a machine with no AI-CLI data yet — the
// data-dependent checks below all iterate over what's actually present.
if (all.length === 0) {
  console.log('note: no local conversations found — data-dependent checks will be skipped');
}

const REQUIRED = ['source', 'key', 'ref', 'title', 'projectPath', 'resume', 'lastActivity'];
const keys = new Set();
let dupes = 0, missing = 0, badCount = 0, future = 0, emptyTitle = 0;
const now = Date.now();
for (const c of all) {
  if (keys.has(c.key)) dupes++;
  keys.add(c.key);
  for (const f of REQUIRED) if (c[f] == null) missing++;
  if (!Number.isFinite(c.messageCount)) badCount++;
  if (c.lastActivity && Date.parse(c.lastActivity) > now + 60000) future++;
  if (!c.title || !String(c.title).trim()) emptyTitle++;
}
check('unique keys', dupes === 0);
check('no missing required fields', missing === 0);
check('messageCount always finite', badCount === 0);
check('no future timestamps', future === 0);
check('no empty titles', emptyTitle === 0);
check('list sorted newest-first', all.every((c, i) =>
  i === 0 || (Date.parse(all[i - 1].lastActivity) || 0) >= (Date.parse(c.lastActivity) || 0)));

// ---- per-source detail ----
const bySource = {};
for (const c of all) (bySource[c.source] ??= []).push(c);
for (const [src, list] of Object.entries(bySource)) {
  check(`SOURCE_META defines ${src}`, !!SOURCE_META[src]);
  await acheck(`detail[${src}]`, async () => {
    const d = await getConversation(src, list[0].ref, 10);
    if (!d || !Array.isArray(d.messages)) throw new Error('messages not an array');
    if (!d.resume) throw new Error('missing resume command');
    if (d.messages.some((m) => !['user', 'assistant', 'tool'].includes(m.role)))
      throw new Error('unexpected message role');
  });
}

// ---- security: every adapter must reject path-traversal refs ----
const EVIL = ['/etc/passwd', '../../../../etc/passwd', 'ses_../../etc/passwd'];
for (const src of Object.keys(bySource)) {
  await acheck(`security[${src}] rejects traversal`, async () => {
    for (const ref of EVIL) {
      let leaked = false;
      try { await getConversation(src, ref, 1); leaked = true; } catch { /* rejected = good */ }
      if (leaked) throw new Error(`read disallowed ref: ${ref}`);
    }
  });
}

// ---- security: sibling-prefix paths (".../projects-evil") must be rejected ----
const H = os.homedir();
const SIBLING = {
  claude: `${H}/.claude/projects-evil/x.jsonl`,
  codex: `${H}/.codex/sessions-evil/x.jsonl`,
  grok: `${H}/.grok/sessions-evil/x`,
  cursor: `${H}/.cursor/projects-evil/x/agent-transcripts/y/y.jsonl`,
  gemini: `${H}/.gemini/tmp-evil/x/checkpoint-z.json`,
  copilot: `${H}/.copilot/history-session-state-evil/x.json`,
  goose: `${H}/.local/share/goose/sessions-evil/x.jsonl`,
  droid: `${H}/.factory/sessions-evil/x.json`,
};
for (const [src, ref] of Object.entries(SIBLING)) {
  await acheck(`security[${src}] rejects sibling-prefix`, async () => {
    let leaked = false;
    try { await getConversation(src, ref, 1); leaked = true; } catch { /* good */ }
    if (leaked) throw new Error(`read sibling path: ${ref}`);
  });
}

// ---- security: markdown export (collectEvents) rejects the same bad refs ----
// Mirrors the getConversation guards above but for the /api/export path. This
// imports collectEvents directly (no HTTP), so it asserts the adapter's
// isInside() guard, not a live endpoint. See ADR-0011.
for (const src of exportCapableSources()) {
  await acheck(`export-security[${src}] rejects traversal + sibling-prefix`, async () => {
    const bad = [...EVIL, SIBLING[src]].filter(Boolean);
    for (const ref of bad) {
      let leaked = false;
      try { await collectEvents(src, ref, {}); leaked = true; } catch { /* rejected = good */ }
      if (leaked) throw new Error(`export read disallowed ref: ${ref}`);
    }
  });
}

// ---- renderer unit tests (deterministic, synthetic blocks; no data dep) ------
// Guards the render_event port's invariants (ADR-0010): one header per event,
// turn counting, code-point-accurate truncation, the encrypted-reasoning
// placeholder, and isMeta suppression. These hold regardless of local data.
const countMatches = (s, re) => (s.match(re) || []).length;
const META = { sessionId: 't' };
const FULL = { full: true, tools: true, toolResults: true, thinking: true, sidechains: true };

// (1) grouping: a multi-block assistant message emits exactly ONE header + 1 turn.
await acheck('render: one header per multi-block assistant event', async () => {
  const ev = { role: 'assistant', ts: '2026-01-01T00:00:00Z', source: 'main', blocks: [
    { kind: 'text', text: 'hello' },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'tool_use', name: 'Read', input: { file_path: '/x' } },
  ] };
  const md = renderMarkdown([ev], META, FULL);
  if (countMatches(md, /### assistant ·/g) !== 1) throw new Error('expected exactly one assistant header');
  if (!/- \*\*turns\*\*: 1\b/.test(md)) throw new Error('expected turns=1');
});

// (2) turn counting: a tools-only assistant event with tools OFF adds no header/turn.
await acheck('render: filtered-out tool_use event counts 0 turns', async () => {
  const ev = { role: 'assistant', ts: '', source: 'main', blocks: [
    { kind: 'tool_use', name: 'Bash', input: { command: 'ls' } },
  ] };
  const md = renderMarkdown([ev], META, { maxChars: 400 }); // tools off
  if (countMatches(md, /### assistant ·/g) !== 0) throw new Error('expected no assistant header');
  if (!/- \*\*turns\*\*: 0\b/.test(md)) throw new Error('expected turns=0');
});

// (3) a user event with text + image + tool_result is still ONE turn (one user header).
await acheck('render: mixed user event is one turn', async () => {
  const ev = { role: 'user', ts: '', source: 'main', imagePasteIds: [], blocks: [
    { kind: 'text', text: 'look at this' },
    { kind: 'image', mediaType: 'image/png', source: { type: 'base64', data: 'AAAA' } },
    { kind: 'tool_result', text: 'result body' },
  ] };
  const md = renderMarkdown([ev], META, FULL);
  if (countMatches(md, /### user ·/g) !== 1) throw new Error('expected exactly one user header');
  if (!/- \*\*turns\*\*: 1\b/.test(md)) throw new Error('expected turns=1');
});

// (4) truncation is code-point accurate (non-BMP), not UTF-16.
check('render: truncate counts code points', truncate('😀'.repeat(10), 4) === '😀😀😀😀… [+6 chars]');
check('render: truncate leaves short strings intact', truncate('short', 400) === 'short');

// (5) empty reasoning → the encrypted placeholder (Codex parity).
await acheck('render: empty reasoning shows encrypted placeholder', async () => {
  const ev = { role: 'assistant', ts: '', source: 'main', blocks: [{ kind: 'reasoning', text: '' }] };
  const md = renderMarkdown([ev], META, { thinking: true });
  if (!md.includes('> _reasoning:_ [encrypted by Codex]')) throw new Error('missing encrypted placeholder');
});

// (6) Codex user_message mirrors Python's `images or local_images`: an empty
// images array falls through to local_images. Stage the checked-in fixture
// under an isolated HOME so the real adapter path guard remains exercised.
await acheck('codex export: empty images falls back to local_images', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-codex-parity-'));
  try {
    const staged = path.join(tempHome, '.codex', 'sessions', '2026', '01', '02', 'rollout-fixture.jsonl');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(
      fileURLToPath(new URL('./fixtures/codex-empty-images-local-images.jsonl', import.meta.url)),
      staged,
    );
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./export-parity.mjs', import.meta.url)), 'codex', staged],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          EXTRACT_PY: process.env.EXTRACT_PY
            || path.join(os.homedir(), 'projects', 'claude-session-tools', 'plugins', 'session-tools', 'scripts', 'extract-session.py'),
        },
        encoding: 'utf8',
      },
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// (7) isMeta user turns are suppressed unless --verbatim.
await acheck('render: isMeta user suppressed unless verbatim', async () => {
  const ev = { role: 'user', ts: '', source: 'main', meta: true, blocks: [{ kind: 'text', text: 'command body' }] };
  if (countMatches(renderMarkdown([ev], META, {}), /### user ·/g) !== 0)
    throw new Error('isMeta user should be hidden by default');
  if (countMatches(renderMarkdown([ev], META, { verbatim: true }), /### user ·/g) !== 1)
    throw new Error('isMeta user should appear with verbatim');
});

// ---- full-content search ----
await acheck('content search builds index + matches', async () => {
  const empty = await searchContent('');
  if (empty.keys.length !== 0) throw new Error('empty query should match nothing');
  const common = await searchContent('e'); // every English transcript contains "e"
  if (all.length > 0 && !(common.keys.length > 0)) throw new Error('index empty / no content matches');
  const narrowed = await searchContent('e zzqqxxnotarealword');
  if (narrowed.keys.length !== 0) throw new Error('multi-word AND did not narrow to 0');
});

// ---- usage module ----
await acheck('getUsage shape', async () => {
  const u = await getUsage();
  if (!Array.isArray(u)) throw new Error('not an array');
  if (!u.every((x) => x && typeof x.source === 'string' && 'available' in x))
    throw new Error('entry missing source/available');
});

// ---- open module (validation only — never opens a real path) ----
const rejects = (p) => { try { openPath(p); return false; } catch { return true; } };
check('openPath rejects nonexistent path', rejects('/definitely/not/real/xyz-123'));
check('openPath rejects empty path', rejects(''));
check('openPath rejects null', rejects(null));

// ---- report ----
const ms = Date.now() - t0;
console.log(`\nsources: ${Object.keys(bySource).length}/${Object.keys(SOURCE_META).length} with data · conversations: ${all.length} · ${ms}ms`);
console.log(`PASS ${pass}  FAIL ${fails.length}`);
if (fails.length) {
  console.log('FAILURES:\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('✓ all checks passed');
