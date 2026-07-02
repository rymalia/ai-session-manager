// Smoke test: exercises every source adapter + the usage/open modules against
// the real local data, validating the API data contract. Run with `npm test`.
// Exits non-zero on any failure.
import os from 'node:os';
import { listConversations, getConversation, SOURCE_META } from '../server/sources/index.js';
import { getUsage } from '../server/usage.js';
import { openPath } from '../server/open.js';
import { searchContent } from '../server/search.js';
import { parseClaudeUsage, finalizeContextUsage, createClaudeContextTracker } from '../server/contextUsage.js';

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

// ---- context-health helper (deterministic fixtures; no data dep) ------------
// Mirrors docs/plan-asm-context-health-2026-07-01.md §4a. The Codex arithmetic
// feeds finalizeContextUsage() directly; every Claude selection/peak/compaction
// case feeds hand-built record arrays through createClaudeContextTracker(), the
// exact code path the adapter uses. Fixtures avoid x.5 rounding-boundary values.
const runTracker = (records) => {
  const tr = createClaudeContextTracker();
  for (const r of records) tr.push(r);
  return tr.finalize();
};
const asst = (usage, extra = {}) => ({ type: 'assistant', message: { model: 'claude-opus-4-8', usage }, ...extra });

// Codex reported: 81,872 / 353,400 → 77, basis reported, window recorded.
check('ctx: codex 81872/353400 → 77% reported', (() => {
  const c = finalizeContextUsage({ usedTokens: 81872, windowTokens: 353400, basis: 'reported', windowBasis: 'recorded' });
  return c && c.percentLeft === 77 && c.basis === 'reported' && c.windowBasis === 'recorded';
})());

// Claude 200k assumed: total 150,000, peak ≤ 200k → 25% left, assumed-200k.
check('ctx: claude 150k/200k → 25% assumed-200k', (() => {
  const c = runTracker([asst({ input_tokens: 100000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000, output_tokens: 5000 })]);
  return c && c.usedTokens === 150000 && c.percentLeft === 25 && c.windowBasis === 'assumed-200k' && c.basis === 'estimated';
})());

// Claude 1M observed: a peak input side > 200k proves the 1M window.
check('ctx: claude peak 362570 → observed-1m', (() => {
  const c = runTracker([asst({ input_tokens: 300000, cache_read_input_tokens: 62570, output_tokens: 100 })]);
  return c && c.windowTokens === 1000000 && c.windowBasis === 'observed-1m';
})());

// output_tokens IS counted (Correction B): same input side, different output → different usedTokens.
check('ctx: output_tokens counted in usedTokens', (() => {
  const a = runTracker([asst({ input_tokens: 100000, output_tokens: 0 })]);
  const b = runTracker([asst({ input_tokens: 100000, output_tokens: 8000 })]);
  return a.usedTokens === 100000 && b.usedTokens === 108000;
})());

// Fallback, not null: a trailing <synthetic> line does NOT wipe the prior valid selection.
check('ctx: <synthetic> last line falls back to prior valid msg', (() => {
  const c = runTracker([
    asst({ input_tokens: 120000, output_tokens: 500 }),
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } },
  ]);
  return c && c.usedTokens === 120500;
})());

// api_error-style trailing line (no real model) likewise falls back.
check('ctx: api_error trailing line falls back', (() => {
  const c = runTracker([
    asst({ input_tokens: 90000, output_tokens: 100 }),
    { type: 'system', subtype: 'api_error' },
  ]);
  return c && c.usedTokens === 90100;
})());

// Cached input contributes to usedTokens.
check('ctx: cached input counted', (() => {
  const c = runTracker([asst({ input_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 9000, output_tokens: 0 })]);
  return c && c.usedTokens === 60000;
})());

// Sidechain assistant messages are never selected.
check('ctx: sidechain never selected', (() => {
  const c = runTracker([
    asst({ input_tokens: 70000, output_tokens: 0 }),
    asst({ input_tokens: 900000, output_tokens: 0 }, { isSidechain: true }),
  ]);
  return c && c.usedTokens === 70000 && c.windowBasis === 'assumed-200k'; // sidechain peak ignored too
})());

// No valid message anywhere → null (only genuine null case).
check('ctx: no valid message → null', () => runTracker([
  { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'user', message: { content: 'hi' } },
]) === null);

// Zero/negative usedTokens → null via finalizeContextUsage guard.
check('ctx: zero usedTokens → null', () => finalizeContextUsage({ usedTokens: 0, windowTokens: 200000 }) === null);

// usedTokens >= window clamps percentLeft to 0 (not negative).
check('ctx: over-full clamps to 0%', (() => {
  const c = finalizeContextUsage({ usedTokens: 250000, windowTokens: 200000, basis: 'estimated' });
  return c && c.percentLeft === 0;
})());

// One compaction emits BOTH markers → counted once.
check('ctx: dual compaction markers counted once', (() => {
  const c = runTracker([
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
    asst({ input_tokens: 30000, output_tokens: 0 }),
  ]);
  return c && c.compactions === 1;
})());

// parseClaudeUsage tolerates junk → all-zero breakdown.
check('ctx: parseClaudeUsage tolerates missing usage', (() => {
  const b = parseClaudeUsage(undefined);
  return b.input === 0 && b.cacheCreate === 0 && b.cacheRead === 0 && b.output === 0;
})());

// Malformed/missing usage on an otherwise-valid assistant line is SKIPPED (not
// selected) — the tracker keeps the prior valid message.
check('ctx: malformed usage line skipped, prior valid kept', (() => {
  const c = runTracker([
    asst({ input_tokens: 110000, output_tokens: 200 }),
    { type: 'assistant', message: { model: 'claude-opus-4-8' } },                    // no usage at all
    { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 'garbage' } } }, // non-numeric
  ]);
  return c && c.usedTokens === 110200;
})());

// A transcript whose ONLY assistant line has malformed usage → null.
check('ctx: sole malformed-usage message → null', () => runTracker([
  { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: null, output_tokens: undefined } } },
]) === null);

// finalizeContextUsage never throws on null / non-object / fractional input.
check('ctx: finalizeContextUsage(null) → null (no throw)', () => finalizeContextUsage(null) === null);
check('ctx: finalizeContextUsage(undefined) → null', () => finalizeContextUsage(undefined) === null);
check('ctx: finalizeContextUsage("x") → null', () => finalizeContextUsage('x') === null);
check('ctx: fractional usedTokens rejected (not floored)', () =>
  finalizeContextUsage({ usedTokens: 1500.5, windowTokens: 200000 }) === null);

// ---- context-health real-data shape check (b) -------------------------------
// Every Claude/Codex entry's contextUsage is either null or a well-formed object.
let ctxBad = 0;
for (const c of all) {
  const cu = c.contextUsage;
  if (cu == null) continue;
  const ok = Number.isInteger(cu.usedTokens) && cu.usedTokens > 0
    && (cu.windowTokens == null || (Number.isInteger(cu.windowTokens) && cu.windowTokens > 0))
    && (cu.percentLeft == null || (Number.isInteger(cu.percentLeft) && cu.percentLeft >= 0 && cu.percentLeft <= 100))
    && (cu.basis === 'reported' || cu.basis === 'estimated')
    && ['recorded', 'assumed-200k', 'observed-1m', null].includes(cu.windowBasis)
    && Number.isInteger(cu.compactions) && cu.compactions >= 0
    && (cu.measuredAt == null || !Number.isNaN(Date.parse(cu.measuredAt)))
    && (c.source === 'claude' || c.source === 'codex'); // only these two emit it
  if (!ok) ctxBad++;
}
check('ctx: real-data contextUsage well-formed or null', ctxBad === 0);

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
