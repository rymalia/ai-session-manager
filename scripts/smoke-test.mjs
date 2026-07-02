// Smoke test: exercises every source adapter + the usage/open modules against
// the real local data, validating the API data contract. Run with `npm test`.
// Exits non-zero on any failure.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listConversations, getConversation, collectEvents, exportCapableSources, exportCapabilities, SOURCE_META } from '../server/sources/index.js';
import { getUsage } from '../server/usage.js';
import { openPath } from '../server/open.js';
import { searchContent } from '../server/search.js';
import { renderMarkdown, truncate, deriveContentDisposition, deriveFlagTokens, deriveExportFilename, resolveExportOptions } from '../server/export.js';
import { parseClaudeUsage, finalizeContextUsage, createClaudeContextTracker } from '../server/contextUsage.js';
import { apiMiddleware } from '../vite.config.js';

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

// ---- endpoint hygiene: dispatch, no-store, Content-Disposition (plan §9) -----
// Prototype-property source names (toString/constructor/__proto__) must resolve
// to 'unsupported' (→ HTTP 400), not reach an inherited fn and TypeError (→ 500).
for (const name of ['toString', 'constructor', '__proto__']) {
  await acheck(`export dispatch: prototype name '${name}' → unsupported`, async () => {
    let code;
    try { await collectEvents(name, 'x', {}); } catch (e) { code = e.code; }
    if (code !== 'unsupported') throw new Error(`expected code 'unsupported', got ${code}`);
  });
}

// deriveContentDisposition hardens the download filename against a hostile local
// sessionId: ASCII filename="" is injection-safe (no quote/CR/LF), the RFC 5987
// filename* is well-formed (no raw ' ( ) * " CR LF), and a surrogate-splitting id
// never throws in encodeURIComponent.
check('content-disposition: hostile id → injection-safe filename', (() => {
  const cd = deriveContentDisposition('a"b\r\n(c)*', []);
  const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''(.+)$/.exec(cd);
  return !!m && !/["\r\n]/.test(m[1]) && !/['()*"\r\n]/.test(m[2]);
})());
check('content-disposition: emoji-boundary id does not throw', (() => {
  try { return deriveContentDisposition('1234567😀', []).includes("filename*=UTF-8''"); }
  catch { return false; }
})());
check('content-disposition: lone-surrogate id does not throw', (() => {
  try { deriveContentDisposition('12345\uD83Dx', []); return true; } catch { return false; }
})());

// Canonical download-stem parity (backs ADR-0002): flag tokens are computed from
// requested opts BEFORE --full expands (so the token is `full`, never its four
// components), and the stem is `replay-<short8>[-<tokens>]`. This is the filename
// tier ADR-0002 promises; the golden body diff does not cover it.
// maxChars: 400 is the no-token default (mirrors Python's default; a differing
// value adds a max<n> token), so callers always pass the resolved maxChars.
check('export filename: --full → replay-<short8>-full.md', (() => {
  const tokens = deriveFlagTokens({ full: true, maxChars: 400 });
  return tokens.join(',') === 'full'
    && deriveExportFilename('c506e1c6-51cd-44f8-8afb-0123456789ab', tokens) === 'replay-c506e1c6-full.md';
})());
check('export filename: default (no flags) → replay-<short8>.md', () =>
  deriveExportFilename('c506e1c6-51cd-44f8', deriveFlagTokens({ maxChars: 400 })) === 'replay-c506e1c6.md');
check('export filename: token order is canonical, not request order', () =>
  deriveFlagTokens({ raw: true, tools: true, thinking: true, maxChars: 400 }).join(',') === 'raw,tools,thinking');

// Endpoint-level: drive apiMiddleware with a mock req/res (no socket) and assert
// Cache-Control: no-store on every export exit, including 4xx error paths.
function mockRes() {
  const h = {};
  return {
    statusCode: 0,
    body: '',
    setHeader(k, v) { h[k.toLowerCase()] = v; },
    getHeader(k) { return h[k.toLowerCase()]; },
    end(b) { this.ended = true; if (b != null) this.body = String(b); },
  };
}
async function callApi(pathname) {
  const res = mockRes();
  await apiMiddleware({ url: pathname, method: 'GET' }, res, () => { res.nextCalled = true; });
  return res;
}
await acheck('export endpoint: missing source/ref → 400 + no-store', async () => {
  const res = await callApi('/api/export');
  if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
  if (res.getHeader('cache-control') !== 'no-store') throw new Error('missing Cache-Control: no-store');
});
await acheck('export endpoint: unsupported source → 400 + no-store', async () => {
  const res = await callApi('/api/export?source=toString&ref=x');
  if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
  if (res.getHeader('cache-control') !== 'no-store') throw new Error('missing Cache-Control: no-store');
});

// ---- capability metadata + option-resolution pipeline (ADR-0013 / ADR-0014) ---
// resolveExportOptions is pure: it validates ONLY explicitly-selected options, `full`
// is exempt and expands unconditionally, history on→validate / off→allow /
// auto→resolve-off, and filename tokens come from the requested opts.
const CLAUDE_CAPS = exportCapabilities('claude');
const CODEX_CAPS = exportCapabilities('codex');

check('caps: claude sidechains/history unavailable, tools supported', () =>
  CLAUDE_CAPS.sidechains === 'unavailable' && CLAUDE_CAPS.history === 'unavailable' && CLAUDE_CAPS.tools === 'supported');
check('caps: codex sidechains/embedImages notApplicable, raw supported', () =>
  CODEX_CAPS.sidechains === 'notApplicable' && CODEX_CAPS.embedImages === 'notApplicable' && CODEX_CAPS.raw === 'supported');
check('caps: non-export source has null capabilities', () => exportCapabilities('grok') === null);

// full is exempt: full alone succeeds and expands all four even on Codex where
// sidechains is notApplicable (matches /replay --full — flag on, no content).
check('resolve: full expands four flags, no 400 (codex)', () => {
  const r = resolveExportOptions({ full: true, history: 'auto', maxChars: 400 }, CODEX_CAPS);
  return !r.error && r.effective.tools && r.effective.toolResults && r.effective.thinking && r.effective.sidechains
    && r.tokens.join(',') === 'full';
});
// but an INDEPENDENTLY selected unsupported option still 400s, full or not.
check('resolve: explicit sidechains=true → 400 even with full (codex)', () => {
  const r = resolveExportOptions({ full: true, sidechains: true, history: 'auto', maxChars: 400 }, CODEX_CAPS);
  return r.error && r.option === 'sidechains' && r.state === 'notApplicable';
});
check('resolve: claude history="on" → error unavailable', () => {
  const r = resolveExportOptions({ history: 'on', maxChars: 400 }, CLAUDE_CAPS);
  return r.error && r.option === 'history' && r.state === 'unavailable';
});
check('resolve: history="auto" resolves to off when unsupported', () => {
  const r = resolveExportOptions({ history: 'auto', maxChars: 400 }, CLAUDE_CAPS);
  return !r.error && r.effective.history === 'off';
});
// turning an unsupported option OFF is the safe direction — never validated.
check('resolve: sidechains=false / history="off" never error (codex)', () => {
  const r = resolveExportOptions({ sidechains: false, history: 'off', maxChars: 400 }, CODEX_CAPS);
  return !r.error && r.effective.history === 'off';
});
// fail-closed: missing/unknown capability for an explicitly enabled option → reject.
check('resolve: fail-closed on empty caps for enabled option', () => {
  const r = resolveExportOptions({ tools: true, maxChars: 400 }, {});
  return r.error && r.option === 'tools' && r.state === 'unavailable';
});
check('resolve: fail-closed on unknown capability value', () => {
  const r = resolveExportOptions({ tools: true, maxChars: 400 }, { tools: 'weird' });
  return r.error && r.option === 'tools';
});
check('resolve: default (no flags) succeeds with empty caps', () => {
  const r = resolveExportOptions({ history: 'auto', maxChars: 400 }, {});
  return !r.error && r.tokens.length === 0;
});

// /api/sources exposes the tri-value maps for export-capable sources only.
await acheck('/api/sources exposes tri-value exportCapabilities', async () => {
  const res = await callApi('/api/sources');
  const body = JSON.parse(res.body);
  if (body.claude.exportCapabilities?.sidechains !== 'unavailable') throw new Error('claude caps missing/incorrect');
  if (body.codex.exportCapabilities?.embedImages !== 'notApplicable') throw new Error('codex caps missing/incorrect');
  if ('exportCapabilities' in body.grok) throw new Error('non-export source should not expose capabilities');
});

// Endpoint 400s an explicitly-selected unavailable/notApplicable option, naming it.
await acheck('export endpoint: codex sidechains=1 → 400 names the option', async () => {
  const res = await callApi('/api/export?source=codex&ref=x&sidechains=1');
  if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
  if (res.getHeader('cache-control') !== 'no-store') throw new Error('missing no-store');
  const msg = JSON.parse(res.body).error;
  if (msg !== "sidechains not applicable to source 'codex'") throw new Error(`unexpected message: ${msg}`);
});
await acheck('export endpoint: claude history=on → 400 names the option', async () => {
  const res = await callApi('/api/export?source=claude&ref=x&history=on');
  if (res.statusCode !== 400) throw new Error(`expected 400, got ${res.statusCode}`);
  const msg = JSON.parse(res.body).error;
  if (msg !== "history not available for source 'claude'") throw new Error(`unexpected message: ${msg}`);
});

// Happy-path THROUGH the endpoint: `full` must reach the renderer with all four flags
// on. The parity harness expands full manually, so only an endpoint test catches a
// mis-wired handler. Data-dependent: runs only when a real session exists.
for (const src of ['codex', 'claude']) {
  if (!bySource[src]?.length) continue;
  await acheck(`export endpoint: full=1 reaches renderer with four flags (${src})`, async () => {
    const ref = encodeURIComponent(bySource[src][0].ref);
    const res = await callApi(`/api/export?source=${src}&ref=${ref}&full=1`);
    if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body.slice(0, 120)}`);
    if (!/- \*\*filters\*\*: tools=on, tool_results=on, thinking=on, sidechains=on\b/.test(res.body))
      throw new Error('full did not expand to all four filters at the endpoint');
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
