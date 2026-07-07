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
import { searchContent, entrySignature } from '../server/search.js';
import { renderMarkdown, truncate, deriveContentDisposition, deriveFlagTokens, deriveExportFilename, resolveExportOptions, summarizeToolUse, pyRepr } from '../server/export.js';
import { parseClaudeUsage, finalizeContextUsage, createClaudeContextTracker } from '../server/contextUsage.js';
import { apiMiddleware } from '../vite.config.js';
import { normalizeExportOpts, buildExportQuery, clampMaxChars, DEFAULT_EXPORT_OPTS } from '../src/exportOptions.js';
import { encodeClaudeRef, decodeClaudeRef, resolveBundle, loadProjectIndexMap } from '../server/sources/claudeBundle.js';
import { decodeStarred, encodeStarred } from '../src/starred.js';

let pass = 0;
const fails = [];
// A function `cond` is INVOKED — passing `() => expr` without invoking it here
// used to make the check vacuously pass (a function object is always truthy).
const check = (name, cond) => {
  try { (typeof cond === 'function' ? cond() : cond) ? pass++ : fails.push(name); }
  catch (e) { fails.push(`${name}: threw ${e.message}`); }
};
const acheck = async (name, fn) => { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

const t0 = Date.now();

// Keep scripts + fixtures textual. A literal NUL (or invalid UTF-8) makes
// tooling — including Claude Code's grep shim, whose -I skips "binary" files —
// silently drop the file from searches (bit us via a raw 0x00 in a codec test
// string, landed in 9fed1aa). Extension-ALLOWLISTED on purpose: a future
// genuinely-binary fixture can exist without tripping this; only files meant
// to be text are scanned. Failure names the offending file.
check('scripts + text fixtures contain no NUL / invalid UTF-8', () => {
  const SCAN = [
    { dir: new URL('.', import.meta.url), exts: ['.mjs'] },
    { dir: new URL('./fixtures/', import.meta.url), exts: ['.js', '.mjs', '.json', '.jsonl', '.md', '.txt'] },
  ];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const offenders = [];
  for (const { dir, exts } of SCAN) {
    const dirPath = fileURLToPath(dir);
    let names = [];
    try { names = fs.readdirSync(dirPath); } catch { continue; }
    for (const name of names) {
      if (!exts.some((e) => name.endsWith(e))) continue;
      const buf = fs.readFileSync(path.join(dirPath, name));
      if (buf.includes(0)) { offenders.push(`${name}: literal NUL`); continue; }
      try { utf8.decode(buf); } catch { offenders.push(`${name}: invalid UTF-8`); }
    }
  }
  if (offenders.length) throw new Error(offenders.join('; '));
  return true;
});

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
    // Recovered Claude sessions (resume '') legitimately return no resume
    // command and empty messages — probe a live-transcript entry.
    const probe = list.find((c) => c.resume) || list[0];
    const d = await getConversation(src, probe.ref, 10);
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
check('export filename: clamp-boundary maxChars → max1 / max20000', () =>
  deriveFlagTokens({ maxChars: 1 }).join(',') === 'max1'
  && deriveFlagTokens({ maxChars: 20000 }).join(',') === 'max20000');

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
// Recovered Claude sessions (exportable:false, F2) have no exporter until F3 —
// endpoint happy-path tests must pick an entry with a main transcript.
const firstExportable = (src) => bySource[src]?.find((c) => c.exportable !== false);
for (const src of ['codex', 'claude']) {
  if (!firstExportable(src)) continue;
  await acheck(`export endpoint: full=1 reaches renderer with four flags (${src})`, async () => {
    const ref = encodeURIComponent(firstExportable(src).ref);
    const res = await callApi(`/api/export?source=${src}&ref=${ref}&full=1`);
    if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body.slice(0, 120)}`);
    if (!/- \*\*filters\*\*: tools=on, tool_results=on, thinking=on, sidechains=on\b/.test(res.body))
      throw new Error('full did not expand to all four filters at the endpoint');
  });
}

// maxChars clamp [1,20000] through the real endpoint (ADR-0011's documented
// deviation from unbounded /replay), pinned by body equivalence against the
// in-range value each out-of-range/malformed input must clamp/fall back to.
// parseInt semantics: '12abc' truncates to 12; 'abc' is NaN → default 400.
if (firstExportable('claude')) {
  const ref = encodeURIComponent(firstExportable('claude').ref);
  const getBody = async (params) => {
    const res = await callApi(`/api/export?source=claude&ref=${ref}${params}`);
    if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}: ${res.body.slice(0, 120)}`);
    return res.body;
  };
  await acheck('export endpoint: maxChars clamps to [1,20000] (ADR-0011)', async () => {
    if (await getBody('&maxChars=0') !== await getBody('&maxChars=1')) throw new Error('0 should clamp to 1');
    if (await getBody('&maxChars=99999') !== await getBody('&maxChars=20000')) throw new Error('99999 should clamp to 20000');
    if (await getBody('&maxChars=abc') !== await getBody('')) throw new Error('non-numeric should fall back to default 400');
    if (await getBody('&maxChars=12abc') !== await getBody('&maxChars=12')) throw new Error('parseInt should truncate 12abc to 12');
  });
  await acheck('export endpoint: Content-Disposition carries the CLAMPED max token', async () => {
    const res = await callApi(`/api/export?source=claude&ref=${ref}&maxChars=0&download=1`);
    if (res.statusCode !== 200) throw new Error(`expected 200, got ${res.statusCode}`);
    const cd = res.getHeader('content-disposition') || '';
    if (!cd.includes('max1')) throw new Error(`expected a max1 token in: ${cd}`);
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

// ---- ADR-0009 enumerated exceptions + the item-2 fix (items D+E) -----------
// Every accepted parity exception gets a deterministic fixture pinning the JS
// behavior; the ensure_ascii fix gets an exact-output check. Non-ASCII inputs
// are built from code points so this file stays free of invisible characters.
const CP = (...cps) => String.fromCodePoint(...cps);

// ADR-0009 #2 (FIXED): structured values escape non-ASCII exactly like Python
// json.dumps ensure_ascii — lowercase \uXXXX, astral chars as surrogate halves.
// pyRepr then doubles the backslashes, hence \\u in the expected literal.
check('summarize: ensure_ascii escapes in structured values (ADR-0009 #2)',
  summarizeToolUse('Task', { input: { msg: `caf${CP(0xe9)} ${CP(0x1f600)}` } })
    === `Task(input='{"msg":"caf\\\\u00e9 \\\\ud83d\\\\ude00"}')`);

// ADR-0009 #4, surface 1: V8 promotes integer-like keys ascending, so the
// .slice(0,3) fallback keeps a different key SET than Python (which preserves
// insertion order: 'T(a=…, b=…, 9=…)').
check('summarize: V8 integer-key promotion changes fallback key set (ADR-0009 #4)',
  summarizeToolUse('T', JSON.parse('{"a":1,"b":2,"9":3,"1":4}')) === 'T(1=…, 9=…, a=…)');

// ADR-0009 #4, surface 2: same canonicalization inside a structured value
// under a priority key (Python keeps '{"2": "x", "0": "y"}' insertion order).
check('summarize: V8 integer-key order in structured values (ADR-0009 #4)',
  summarizeToolUse('T', { input: JSON.parse('{"2":"x","0":"y"}') }) === `T(input='{"0":"y","2":"x"}')`);

// ADR-0009 #5: JSON.parse collapses 1.0 → 1 / -0.0 → -0 before the serializer
// runs, so Python's '{"a":1.0,"b":1e-07,"c":-0.0}' is unreproducible by design.
check('summarize: float-ness lost at JSON.parse (ADR-0009 #5)',
  summarizeToolUse('T', { input: JSON.parse('{"a":1.0,"b":1e-7,"c":-0.0}') }) === `T(input='{"a":1,"b":1e-7,"c":0}')`);

// ADR-0009 #3: pyRepr keeps exotic non-printable Unicode literal where
// CPython's !r would emit \u200b.
check('pyRepr: exotic Unicode kept literal (ADR-0009 #3)',
  pyRepr(`a${CP(0x200b)}b`) === `'a${CP(0x200b)}b'`);

// maxChars boundary through the renderer: exactly N code points stays intact,
// N+1 gains the '… [+1 chars]' marker (ts:'' keeps output TZ-independent).
await acheck('render: maxChars boundary on tool_result (N intact, N+1 marked)', async () => {
  const evs = (txt) => [{ role: 'user', ts: '', source: 'main', blocks: [{ kind: 'tool_result', text: txt }] }];
  const at = renderMarkdown(evs('x'.repeat(80)), META, { toolResults: true, maxChars: 80 });
  const over = renderMarkdown(evs('y'.repeat(81)), META, { toolResults: true, maxChars: 80 });
  if (!at.includes('x'.repeat(80)) || at.includes('chars]')) throw new Error('N code points must not truncate');
  if (!over.includes('y'.repeat(80) + '… [+1 chars]')) throw new Error('N+1 must truncate with a +1 marker');
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

// (6b) Claude live-main index enrichment (ADR-0015): a synthetic main
// transcript staged BESIDE an overlapping sessions-index.json — the fixture
// ADR-0015 requires. Golden-diffed against the Python reference across the
// full flag matrix. Runs in a CHILD process because claude.js captures
// ROOT from os.homedir() at import time — mutating HOME in this process
// cannot re-point the containment root.
const CLAUDE_IDX_SESSION = 'c1a0de00-1111-4222-8333-444455556666';
const stageClaudeProject = (tempHome, slug, {
  index,
  fixture = './fixtures/claude-index-enrichment.jsonl',
  sessionId = CLAUDE_IDX_SESSION,
} = {}) => {
  const proj = path.join(tempHome, '.claude', 'projects', slug);
  fs.mkdirSync(proj, { recursive: true });
  const staged = path.join(proj, `${sessionId}.jsonl`);
  fs.copyFileSync(fileURLToPath(new URL(fixture, import.meta.url)), staged);
  if (index !== undefined) fs.writeFileSync(path.join(proj, 'sessions-index.json'), index);
  return staged;
};

await acheck('claude export: index enrichment golden diff (ADR-0015)', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-index-'));
  try {
    const staged = stageClaudeProject(tempHome, '-Users-test-project', {
      index: fs.readFileSync(
        fileURLToPath(new URL('./fixtures/claude-index-enrichment-sessions-index.json', import.meta.url)),
      ),
    });
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./export-parity.mjs', import.meta.url)), 'claude', staged],
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

// (6c) Hermetic index-enrichment variants (no Python needed): run the real
// adapter + renderer in a child Node process (same HOME-at-import constraint
// as above) and assert the adapter→renderer contract for each boundary.
await acheck('claude export: index enrichment variants (match/none/no-match/invalid/falsey)', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-index-'));
  try {
    const runExport = (ref) => JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const [ref, adapterUrl, exportUrl] = process.argv.slice(1);
        const { collectEvents } = await import(adapterUrl);
        const { renderMarkdown } = await import(exportUrl);
        const { meta, events } = await collectEvents(ref);
        process.stdout.write(JSON.stringify({
          summary: meta.summary ?? null, created: meta.created ?? null,
          gitBranch: meta.gitBranch ?? null,
          messageCount: meta.messageCount ?? null,
          md: renderMarkdown(events, meta, {}),
        }));
      `,
        ref,
        new URL('../server/sources/claude.js', import.meta.url).href,
        new URL('../server/export.js', import.meta.url).href,
      ],
      { env: { ...process.env, HOME: tempHome }, encoding: 'utf8' },
    ));
    const HEADER_LINES = ['- **summary**: ', '- **created**: ', '- **branch**: ', '- **original messages**: '];
    const assertNoIndexLines = (j, label) => {
      for (const l of HEADER_LINES) if (j.md.includes(l)) throw new Error(`${label}: unexpected "${l.trim()}" line`);
    };

    // Matching entry → all four fields populate and render, in /replay's order.
    const match = runExport(stageClaudeProject(tempHome, '-proj-match', {
      index: fs.readFileSync(
        fileURLToPath(new URL('./fixtures/claude-index-enrichment-sessions-index.json', import.meta.url)),
      ),
    }));
    if (match.summary !== 'Index enrichment fixture session') throw new Error('summary not populated from index');
    if (match.created !== '2026-01-05T09:59:58.000Z') throw new Error('created not taken from index');
    if (match.gitBranch !== 'fixture-branch' || match.messageCount !== 4) throw new Error('branch/messageCount not populated');
    if (!/- \*\*created\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n/.test(match.md)) throw new Error('created line missing/malformed');
    const order = [
      '- **summary**: Index enrichment fixture session\n', '- **main**: ',
      '- **cwd**: ', '- **created**: ', '- **branch**: fixture-branch\n',
      '- **original messages**: 4\n', '- **turns**: ',
    ].map((s) => match.md.indexOf(s));
    if (order.some((i) => i === -1)) throw new Error('expected header line missing');
    if (order.some((i, n) => n > 0 && i < order[n - 1])) throw new Error('header lines out of /replay order');
    if (match.md.includes('MUST-NOT-RENDER') || match.md.includes('- **modified**')) throw new Error('non-rendered index fields leaked');

    // No index file at all → nothing enriched.
    assertNoIndexLines(runExport(stageClaudeProject(tempHome, '-proj-none')), 'no index');
    // Index present, no matching sessionId → nothing enriched.
    assertNoIndexLines(runExport(stageClaudeProject(tempHome, '-proj-nomatch', {
      index: JSON.stringify({ version: 1, entries: [{ sessionId: 'other', summary: 'nope' }] }),
    })), 'no match');
    // Malformed JSON → treated as no index (Python catches JSONDecodeError).
    assertNoIndexLines(runExport(stageClaudeProject(tempHome, '-proj-malformed', { index: '{not json' })), 'malformed');
    // Structurally invalid (array root) → treated as no index; the tolerant
    // error-path divergence documented in claude.js loadSessionIndex.
    assertNoIndexLines(runExport(stageClaudeProject(tempHome, '-proj-structural', { index: '[]' })), 'structural');
    // Matching entry with falsey fields → populated but suppressed by the
    // renderer's truthiness checks, mirroring Python's `if idx.field:`.
    const falsey = runExport(stageClaudeProject(tempHome, '-proj-falsey', {
      index: JSON.stringify({ version: 1, entries: [{
        sessionId: CLAUDE_IDX_SESSION, summary: '', created: '', gitBranch: '', messageCount: 0,
      }] }),
    }));
    if (falsey.messageCount !== 0) throw new Error('falsey fields should still populate meta');
    assertNoIndexLines(falsey, 'falsey fields');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// (6d) Render-edges fixture (item D): non-ASCII body text + ensure_ascii
// structured tool input (ADR-0009 item 2 fix, golden-proven against real
// json.dumps), a base64 image (hermetic embed-images coverage), equal and
// missing timestamps, noise/command-name tags (cleanUserText vs verbatim), and
// an 80/81-code-point tool_result pair hitting the full+max80 matrix boundary.
// Deliberately NO integer-like keys and NO floats — ADR-0009 items 4/5 diverge
// by design and are pinned by the hermetic checks above instead.
await acheck('claude export: render-edges golden diff (unicode/image/ts/boundary)', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-edges-'));
  try {
    const staged = stageClaudeProject(tempHome, '-Users-test-edges', {
      fixture: './fixtures/claude-render-edges.jsonl',
      sessionId: 'edce5000-1111-4222-8333-444455556666',
    });
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./export-parity.mjs', import.meta.url)), 'claude', staged],
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

// (6e) F1 identity layer (ADR-0017): opaque ref codec, bundle resolver,
// dual-scheme ref acceptance, endpoint 404 mapping, versioned star storage.
// No 1B parsing is exercised here — resolver/identity only (ADR-0012 gate).

// Codec: pure string work, no fs — safe to test in-process.
check('claude ref codec: roundtrip', (() => {
  const id = { projectSlug: '-Users-test-proj.1_x', sessionId: 'c1a0de00-1111-4222-8333-444455556666' };
  const d = decodeClaudeRef(encodeClaudeRef(id));
  return d && d.projectSlug === id.projectSlug && d.sessionId === id.sessionId;
})());
check('claude ref codec: rejects malformed/traversal refs', (() => {
  const bad = [
    'v2:a:b', 'v1:a', 'v1:a:b:c', 'v1::b', 'v1:a:', 'v1:.:b', 'v1:..:b',
    'v1:a:..', 'v1:a/b:c', 'v1:a\\b:c', 'v1:a b:c', 'v1:a:b\x00',
    'v1:é:b', '/etc/passwd', '', null, undefined, 42,
  ];
  return bad.every((r) => decodeClaudeRef(r) === null);
})());
check('claude ref codec: encode throws on invalid identity', (() => {
  for (const id of [{ projectSlug: '..', sessionId: 'x' }, { projectSlug: 'a', sessionId: 'b/c' }]) {
    try { encodeClaudeRef(id); return false; } catch { /* good */ }
  }
  return true;
})());
await acheck('claude ref codec: __proto__ slug decodes clean and resolves to null', async () => {
  const d = decodeClaudeRef('v1:__proto__:00000000-0000-4000-8000-00000000f1f1');
  if (!d || d.projectSlug !== '__proto__') throw new Error('charset-valid slug should decode');
  if (Object.prototype.polluted !== undefined) throw new Error('prototype polluted');
  // Real ROOT, read-only: no such session dir → not a bundle.
  if (await resolveBundle(d) !== null) throw new Error('expected null bundle');
});

// Resolver: artifact-era matrix in a CHILD process (claudeBundle.js captures
// ROOT from os.homedir() at import time, same constraint as claude.js).
await acheck('claude bundle resolver: era matrix + composite signature', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-f1-'));
  try {
    const proj = (slug) => {
      const p = path.join(tempHome, '.claude', 'projects', slug);
      fs.mkdirSync(p, { recursive: true });
      return p;
    };
    let p = proj('-f1-main-only');
    fs.writeFileSync(path.join(p, 's1.jsonl'), '{}\n');
    p = proj('-f1-full');
    fs.writeFileSync(path.join(p, 's1.jsonl'), '{}\n');
    fs.mkdirSync(path.join(p, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(p, 's1', 'subagents', 'agent-b.jsonl'), '{}\n');
    fs.writeFileSync(path.join(p, 's1', 'subagents', 'agent-a.jsonl'), '{}\n');
    p = proj('-f1-folder-only');
    fs.mkdirSync(path.join(p, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(p, 's1', 'subagents', 'agent-x.jsonl'), '{}\n');
    p = proj('-f1-index-only');
    fs.writeFileSync(path.join(p, 'sessions-index.json'),
      JSON.stringify({ version: 1, entries: [{ sessionId: 's1', summary: 'from-index' }] }));
    p = proj('-f1-empty-folder');
    fs.mkdirSync(path.join(p, 's1'), { recursive: true });

    const CASES = ['-f1-main-only', '-f1-full', '-f1-folder-only', '-f1-index-only', '-f1-empty-folder', '-f1-missing'];
    const run = () => JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const [bundleUrl, ...slugs] = process.argv.slice(1);
        const { resolveBundle } = await import(bundleUrl);
        const out = [];
        for (const projectSlug of slugs) {
          const b = await resolveBundle({ projectSlug, sessionId: 's1' });
          out.push(b && {
            main: !!b.mainPath, folder: !!b.folderPath,
            subs: b.subagentPaths.map((f) => f.split('/').pop()),
            idx: b.indexMeta ? b.indexMeta.summary : null,
            sig: b.compositeSignature,
          });
        }
        process.stdout.write(JSON.stringify(out));
      `,
        new URL('../server/sources/claudeBundle.js', import.meta.url).href,
        ...CASES,
      ],
      { env: { ...process.env, HOME: tempHome }, encoding: 'utf8' },
    ));

    const [mainOnly, full, folderOnly, indexOnly, emptyFolder, missing] = run();
    if (!mainOnly || !mainOnly.main || mainOnly.folder || mainOnly.subs.length || mainOnly.idx)
      throw new Error('main-only bundle wrong shape');
    if (!full || !full.main || !full.folder || full.subs.join(',') !== 'agent-a.jsonl,agent-b.jsonl')
      throw new Error('full bundle wrong shape or subagents not lexically sorted');
    if (!folderOnly || folderOnly.main || folderOnly.subs.join(',') !== 'agent-x.jsonl')
      throw new Error('folder-only bundle wrong shape');
    if (!indexOnly || indexOnly.main || indexOnly.folder || indexOnly.subs.length || indexOnly.idx !== 'from-index')
      throw new Error('index-only bundle wrong shape');
    if (emptyFolder !== null) throw new Error('bare empty folder must be "nothing to replay" (null)');
    if (missing !== null) throw new Error('missing session must resolve to null');

    // Composite signature: stable across identical runs; changes when ANY
    // artifact changes (here: a subagent file, invisible to main-file mtime).
    const again = run();
    if (again[1].sig !== full.sig) throw new Error('signature not stable across identical calls');
    if (again[0].sig !== mainOnly.sig) throw new Error('main-only signature not stable');
    fs.appendFileSync(path.join(tempHome, '.claude', 'projects', '-f1-full', 's1', 'subagents', 'agent-a.jsonl'), '{}\n');
    const mutated = run();
    if (mutated[1].sig === full.sig) throw new Error('signature must change when a subagent changes');
    if (mutated[0].sig !== mainOnly.sig) throw new Error('unrelated bundle signature must not change');
    // Main-transcript and index-file mutations must move the signature too —
    // pinning the FULL artifact set the signature contract documents (Codex
    // impl-review Info: subagent-only mutation left these unpinned).
    fs.appendFileSync(path.join(tempHome, '.claude', 'projects', '-f1-full', 's1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(tempHome, '.claude', 'projects', '-f1-index-only', 'sessions-index.json'),
      JSON.stringify({ version: 1, entries: [{ sessionId: 's1', summary: 'from-index', modified: 'x' }] }));
    const mutated2 = run();
    if (mutated2[1].sig === mutated[1].sig) throw new Error('signature must change when the main transcript changes');
    if (mutated2[3].sig === indexOnly.sig) throw new Error('signature must change when sessions-index.json changes');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// Dual-scheme acceptance: the SAME session through a path ref and an opaque
// ref must be byte-identical (export) and deep-equal (detail); a folder-only
// identity has no main transcript in F1 → code 'not_found'.
await acheck('claude dual-scheme refs: opaque ≡ path; folder-only → not_found', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-f1dual-'));
  try {
    const staged = stageClaudeProject(tempHome, '-f1-dual');
    const foDir = path.join(tempHome, '.claude', 'projects', '-f1-dual', 'fo11de00-1111-4222-8333-444455556666', 'subagents');
    fs.mkdirSync(foDir, { recursive: true });
    fs.writeFileSync(path.join(foDir, 'agent-a.jsonl'), '{}\n');

    const out = JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const [pathRef, opaqueRef, foRef, adapterUrl, exportUrl] = process.argv.slice(1);
        const claude = await import(adapterUrl);
        const { renderMarkdown } = await import(exportUrl);
        const a = await claude.collectEvents(pathRef);
        const b = await claude.collectEvents(opaqueRef);
        const mdA = renderMarkdown(a.events, a.meta, { full: true });
        const mdB = renderMarkdown(b.events, b.meta, { full: true });
        const dA = JSON.stringify(await claude.detail(pathRef, 10));
        const dB = JSON.stringify(await claude.detail(opaqueRef, 10));
        let foCode = null;
        try { await claude.collectEvents(foRef); } catch (e) { foCode = e.code || e.message; }
        process.stdout.write(JSON.stringify({ sameMd: mdA === mdB, mdLen: mdA.length, sameDetail: dA === dB, foCode }));
      `,
        staged,
        `v1:-f1-dual:${CLAUDE_IDX_SESSION}`,
        'v1:-f1-dual:fo11de00-1111-4222-8333-444455556666',
        new URL('../server/sources/claude.js', import.meta.url).href,
        new URL('../server/export.js', import.meta.url).href,
      ],
      { env: { ...process.env, HOME: tempHome }, encoding: 'utf8' },
    ));
    if (!out.sameMd || out.mdLen === 0) throw new Error('opaque-ref export differs from path-ref export');
    if (!out.sameDetail) throw new Error('opaque-ref detail differs from path-ref detail');
    if (out.foCode !== 'not_found') throw new Error(`folder-only opaque ref: expected code 'not_found', got ${out.foCode}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// Endpoint mapping: a decoded-but-absent opaque identity is client input →
// 404 on BOTH ref-consuming endpoints (real ROOT, read-only, no staging;
// sibling containment keeps asserting 403 above per ADR-0011).
const F1_MISSING_REF = 'v1:-f1-no-such-slug:00000000-0000-4000-8000-00000000dead';
await acheck('conversation endpoint: missing opaque identity → 404', async () => {
  const res = await callApi(`/api/conversation?source=claude&ref=${encodeURIComponent(F1_MISSING_REF)}`);
  if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
});
await acheck('export endpoint: missing opaque identity → 404 + no-store', async () => {
  const res = await callApi(`/api/export?source=claude&ref=${encodeURIComponent(F1_MISSING_REF)}&full=1`);
  if (res.statusCode !== 404) throw new Error(`expected 404, got ${res.statusCode}`);
  if (res.getHeader('cache-control') !== 'no-store') throw new Error('missing Cache-Control: no-store');
});

// Versioned star storage (src/starred.js): envelope precedence, one-shot
// migration, fail-closed parsing.
check('starred: legacy array migrates once into the v1 envelope', (() => {
  const first = decodeStarred(null, JSON.stringify(['claude:/a', 'codex:/b']));
  if (first.keys.join(',') !== 'claude:/a,codex:/b' || !first.needsWrite) return false;
  const second = decodeStarred(encodeStarred(first.keys), JSON.stringify(['claude:/a', 'codex:/b']));
  return second.keys.join(',') === 'claude:/a,codex:/b' && !second.needsWrite;
})());
check('starred: valid envelope wins over legacy', () =>
  decodeStarred(encodeStarred(['new:key']), JSON.stringify(['old:key'])).keys.join(',') === 'new:key');
check('starred: malformed/unknown-version envelope falls back to legacy', (() => {
  const legacy = JSON.stringify(['a:b']);
  return ['{not json', JSON.stringify({ version: 3, keys: ['x'] }), JSON.stringify({ keys: ['x'] }),
    JSON.stringify({ version: 1, keys: 'x' }), JSON.stringify(['bare-array'])]
    .every((v1) => { const r = decodeStarred(v1, legacy); return r.keys.join(',') === 'a:b' && r.needsWrite; });
})());
check('starred: everything malformed → empty, never throws', (() => {
  const r = decodeStarred('{bad', '{worse');
  const empty = decodeStarred(null, null);
  return r.keys.length === 0 && r.needsWrite && empty.keys.length === 0 && empty.needsWrite;
})());
check('starred: non-string members are filtered', () =>
  decodeStarred(null, JSON.stringify(['ok', 42, null, 'also'])).keys.join(',') === 'ok,also'
  && decodeStarred(JSON.stringify({ version: 1, keys: ['ok', {}, 'also'] }), null).keys.join(',') === 'ok,also');

// (6f) F2 listing/search integration (ADR-0017): one card per identity with
// opaque refs + recovered (folder-only/index-only) metadata cards, the
// starred v1→v2 Claude key rewrite, and cacheSignature invalidation.

// Starred v2: the Claude path-key rewrite.
const F2_PATH_KEY = 'claude:/Users/x/.claude/projects/-Users-x-proj/ab1250f2-1111-4222-8333-444455556666.jsonl';
const F2_OPAQUE_KEY = 'claude:v1:-Users-x-proj:ab1250f2-1111-4222-8333-444455556666';
check('starred v2: v1 envelope rewrites claude path keys, others untouched', (() => {
  const v1 = JSON.stringify({ version: 1, keys: [F2_PATH_KEY, 'codex:/Users/x/.codex/sessions/r.jsonl', 'plain:key'] });
  const r = decodeStarred(v1, null);
  return r.needsWrite
    && r.keys.join('|') === `${F2_OPAQUE_KEY}|codex:/Users/x/.codex/sessions/r.jsonl|plain:key`;
})());
check('starred v2: legacy bare array gets the same rewrite', () =>
  decodeStarred(null, JSON.stringify([F2_PATH_KEY])).keys.join(',') === F2_OPAQUE_KEY);
check('starred v2: non-conforming claude keys pass through unchanged', (() => {
  const weird = [
    'claude:v1:-slug:id',                       // already opaque (no .jsonl)
    'claude:/x/no-jsonl-suffix',                // not a .jsonl path
    'claude:relative.jsonl',                    // <2 path segments
    'claude:/x/bad slug/aa.jsonl',              // slug fails charset
    'claude:/x/../aa.jsonl',                    // traversal-shaped slug
  ];
  const r = decodeStarred(JSON.stringify({ version: 1, keys: weird }), null);
  return r.keys.join('|') === weird.join('|');
})());
check('starred v2: rewrite is one-shot (v2 envelope is terminal)', (() => {
  const migrated = decodeStarred(JSON.stringify({ version: 1, keys: [F2_PATH_KEY] }), null);
  const again = decodeStarred(encodeStarred(migrated.keys), JSON.stringify([F2_PATH_KEY]));
  return !again.needsWrite && again.keys.join(',') === F2_OPAQUE_KEY;
})());

// Search invalidation comparator (the F1-pinned contract, now live).
check('search: entrySignature prefers cacheSignature, falls back to mtimeMs', () =>
  entrySignature({ cacheSignature: 'a@1:2', mtimeMs: 7 }) === 'a@1:2'
  && entrySignature({ cacheSignature: null, mtimeMs: 7 }) === 7
  && entrySignature({ mtimeMs: 7 }) === 7);

await acheck('claude index map: read errors do not poison same-stat cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-index-cache-'));
  const indexPath = path.join(dir, 'sessions-index.json');
  const originalReadFile = fs.promises.readFile;
  try {
    fs.writeFileSync(indexPath, JSON.stringify({
      entries: [{ sessionId: 'cache-test', summary: 'Recovered after read error' }],
    }));
    fs.promises.readFile = async (...args) => {
      if (args[0] === indexPath) {
        const e = new Error('permission denied');
        e.code = 'EACCES';
        throw e;
      }
      return originalReadFile(...args);
    };
    const unreadable = await loadProjectIndexMap(dir);
    if (unreadable.size !== 0) throw new Error('read error should produce empty map');
    fs.promises.readFile = originalReadFile;
    const recovered = await loadProjectIndexMap(dir);
    if (recovered.get('cache-test')?.summary !== 'Recovered after read error') {
      throw new Error('same-stat recovery should re-read instead of returning stale empty map');
    }
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// List integration: era matrix through the REAL adapter list()+detail() in a
// child process (HOME-at-import constraint). One project stages every era +
// decoys; assertions pin one-card-per-identity, opaque refs, recovered-card
// field derivations, and that main cards ignore index display fields.
await acheck('claude list (F2): one card per identity, recovered cards, opaque refs', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-claude-f2-'));
  try {
    const SLUG = '-f2-proj';
    const proj = path.join(tempHome, '.claude', 'projects', SLUG);
    const MAIN1 = 'aa000001-1111-4222-8333-444455556666'; // main-only
    const MAIN2 = 'aa000002-1111-4222-8333-444455556666'; // main + folder (ONE card)
    const FOLD = 'bb000001-1111-4222-8333-444455556666';  // folder-only + index entry
    const IDX = 'cc000001-1111-4222-8333-444455556666';   // index-only
    const IDXBAD = 'cc000002-1111-4222-8333-444455556666'; // index-only, garbage `modified`
    const SIDE = 'dd000001-1111-4222-8333-444455556666';  // isSidechain → NO card
    const fixture = fileURLToPath(new URL('./fixtures/claude-index-enrichment.jsonl', import.meta.url));
    fs.mkdirSync(path.join(proj, `${MAIN2}`, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(proj, `${FOLD}`, 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'memory'), { recursive: true }); // decoy dir
    fs.copyFileSync(fixture, path.join(proj, `${MAIN1}.jsonl`));
    fs.copyFileSync(fixture, path.join(proj, `${MAIN2}.jsonl`));
    fs.writeFileSync(path.join(proj, `${MAIN2}`, 'subagents', 'agent-a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(proj, `${FOLD}`, 'subagents', 'agent-a.jsonl'), '{}\n');
    fs.writeFileSync(path.join(proj, '_notes.txt'), 'decoy'); // decoy file
    fs.writeFileSync(path.join(proj, 'sessions-index.json'), JSON.stringify({
      version: 1,
      entries: [
        { sessionId: MAIN1, summary: 'INDEX-DECOY', messageCount: 999 },
        { sessionId: FOLD, summary: 'Recovered folder session', firstPrompt: 'hello recovered', messageCount: 42, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-03T00:00:00.000Z', gitBranch: 'rec-branch', projectPath: '/tmp/proj-x' },
        { sessionId: IDX, summary: 'Index only session', messageCount: 7, created: '2026-01-02T00:00:00.000Z', modified: '2026-01-02T03:04:05.000Z' },
        { sessionId: IDXBAD, summary: 'Bad modified', modified: 'garbage', fileMtime: 1234567890123 },
        { sessionId: SIDE, summary: 'sidechain leg', isSidechain: true },
      ],
    }));

    // Three list() runs in ONE process so the module-level index-map cache is
    // actually exercised: initial state → index REWRITTEN (must evict via
    // mtime/size signature) → index DELETED (must evict via 'missing' state).
    const out = JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const [adapterUrl, idxPath, idxId] = process.argv.slice(1);
        const fsc = await import('node:fs');
        const claude = await import(adapterUrl);
        const run = async () => {
          const entries = await claude.list();
          const details = {};
          for (const e of entries) if (!e.resume) details[e.id] = await claude.detail(e.ref);
          return { entries, details };
        };
        const first = await run();
        const data = JSON.parse(fsc.readFileSync(idxPath, 'utf-8'));
        for (const e of data.entries) if (e.sessionId === idxId) e.summary = 'Index only session UPDATED';
        fsc.writeFileSync(idxPath, JSON.stringify(data));
        const second = await run();
        fsc.unlinkSync(idxPath);
        const third = await run();
        process.stdout.write(JSON.stringify({ ...first, second, third }));
      `,
        new URL('../server/sources/claude.js', import.meta.url).href,
        path.join(proj, 'sessions-index.json'),
        IDX,
      ],
      { env: { ...process.env, HOME: tempHome }, encoding: 'utf8' },
    ));

    const byId = Object.fromEntries(out.entries.map((e) => [e.id, e]));
    const ids = out.entries.map((e) => e.id).sort();
    const expect = [MAIN1, MAIN2, FOLD, IDX, IDXBAD].sort();
    if (ids.join(',') !== expect.join(','))
      throw new Error(`expected cards ${expect.join(',')}, got ${ids.join(',')}`);
    if (new Set(out.entries.map((e) => e.key)).size !== out.entries.length) throw new Error('duplicate keys');
    for (const e of out.entries) {
      if (!decodeClaudeRef(e.ref)) throw new Error(`ref not opaque: ${e.ref}`);
      if (typeof e.cacheSignature !== 'string' || !e.cacheSignature) throw new Error(`missing cacheSignature on ${e.id}`);
    }

    for (const id of [MAIN1, MAIN2]) {
      const m = byId[id];
      if (m.title === 'INDEX-DECOY' || m.messageCount === 999) throw new Error('main card took index display fields');
      if (!(m.messageCount > 0)) throw new Error('main card lost transcript-derived counts');
      if (!m.resume.includes(`claude --resume ${id}`)) throw new Error('main card lost resume');
      if (m.exportable === false) throw new Error('main card must stay exportable');
    }
    const f = byId[FOLD];
    if (f.title !== 'Recovered folder session' || f.gitBranch !== 'rec-branch' || f.messageCount !== 42
      || f.projectPath !== '/tmp/proj-x' || f.resume !== '' || f.exportable !== false || f.contextUsage !== null)
      throw new Error('folder-only card fields wrong');
    if (!(f.mtimeMs > 0)) throw new Error('folder-only mtime should come from subagent');
    const ix = byId[IDX];
    if (ix.mtimeMs !== Date.parse('2026-01-02T03:04:05.000Z') || ix.lastActivity !== '2026-01-02T03:04:05.000Z'
      || ix.firstActivity !== '2026-01-02T00:00:00.000Z' || ix.messageCount !== 7)
      throw new Error('index-only card fields wrong');
    const bad = byId[IDXBAD];
    if (bad.mtimeMs !== 1234567890123 || bad.lastActivity !== new Date(1234567890123).toISOString()
      || !Number.isFinite(bad.mtimeMs))
      throw new Error('garbage modified should fall back to numeric fileMtime + visible activity');

    if (out.details[FOLD]?.recovered !== 'folder-only' || out.details[FOLD].messages.length !== 0)
      throw new Error('folder-only detail should be recovered + empty');
    if (out.details[IDX]?.recovered !== 'index-only') throw new Error('index-only detail should be recovered');
    if (out.details[FOLD].title !== 'Recovered folder session') throw new Error('recovered detail lost index title');

    // Index-map cache eviction (same process): a rewrite must surface the new
    // summary; deletion must drop index-only cards while folder-only survives
    // on its subagent artifact (title falls back — no index left to name it).
    const secondIdx = out.second.entries.find((e) => e.id === IDX);
    if (secondIdx?.title !== 'Index only session UPDATED')
      throw new Error('index rewrite did not evict the cached index map');
    const thirdIds = out.third.entries.map((e) => e.id).sort();
    if (thirdIds.includes(IDX) || thirdIds.includes(IDXBAD))
      throw new Error('deleted index should drop index-only cards');
    const thirdFold = out.third.entries.find((e) => e.id === FOLD);
    if (!thirdFold || thirdFold.title !== '(untitled)' || thirdFold.exportable !== false)
      throw new Error('folder-only card should survive index deletion via its subagents');
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

// Claude 1M default (post-2026-03-14, non-Haiku; no timestamp ⇒ treated as
// current): total 150,000 → 85% left, assumed-1m.
check('ctx: claude 150k/1M → 85% assumed-1m', (() => {
  const c = runTracker([asst({ input_tokens: 100000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 5000, output_tokens: 5000 })]);
  return c && c.usedTokens === 150000 && c.percentLeft === 85 && c.windowBasis === 'assumed-1m' && c.basis === 'estimated';
})());

// Haiku keeps the 200k window regardless of date.
check('ctx: haiku 150k/200k → 25% assumed-200k', (() => {
  const c = runTracker([{ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 145000, output_tokens: 5000 } } }]);
  return c && c.usedTokens === 150000 && c.percentLeft === 25 && c.windowBasis === 'assumed-200k';
})());

// Sessions ending before the 2026-03-14 cutover keep the old 200k default.
check('ctx: pre-cutover session → assumed-200k', (() => {
  const c = runTracker([asst({ input_tokens: 150000, output_tokens: 0 }, { timestamp: '2026-02-01T12:00:00.000Z' })]);
  return c && c.windowBasis === 'assumed-200k' && c.windowTokens === 200000;
})());

// Sessions on/after the cutover get the 1M default.
check('ctx: post-cutover session → assumed-1m', (() => {
  const c = runTracker([asst({ input_tokens: 150000, output_tokens: 0 }, { timestamp: '2026-03-14T00:00:00.000Z' })]);
  return c && c.windowBasis === 'assumed-1m' && c.windowTokens === 1000000;
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
  return c && c.usedTokens === 70000 && c.windowBasis === 'assumed-1m'; // sidechain peak ignored (else observed-1m)
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
    && ['recorded', 'assumed-200k', 'assumed-1m', 'observed-1m', null].includes(cu.windowBasis)
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

// ---- frontend export-option helpers (src/exportOptions.js) ----
// These enforce the UI's two promises: persisted options are always
// schema-validated, and the built query can NEVER carry an option the source
// doesn't support (so the UI can't trigger /api/export's explicit-unavailable
// 400). Pure functions, so they're testable without a browser (Codex plan
// review, Major #5/#6/#7). CLAUDE_CAPS / CODEX_CAPS are the real adapter
// capabilities declared above.
const parseQ = (qs) => new URLSearchParams(qs);

check('exportOpts: null root → defaults', () =>
  JSON.stringify(normalizeExportOpts(null)) === JSON.stringify(DEFAULT_EXPORT_OPTS));
check('exportOpts: array root → defaults', () =>
  JSON.stringify(normalizeExportOpts([1, 2])) === JSON.stringify(DEFAULT_EXPORT_OPTS));
check('exportOpts: string root → defaults', () =>
  JSON.stringify(normalizeExportOpts('nope')) === JSON.stringify(DEFAULT_EXPORT_OPTS));
check('exportOpts: bad types coerced, unknown keys dropped', () => {
  const o = normalizeExportOpts({ tools: 'yes', full: 1, history: 'weird', maxChars: '999', bogus: true });
  return o.tools === false && o.full === false && o.history === 'auto' && o.maxChars === 999 && !('bogus' in o);
});
check('exportOpts: valid values preserved', () => {
  const o = normalizeExportOpts({ tools: true, full: true, history: 'off', maxChars: 1200 });
  return o.tools === true && o.full === true && o.history === 'off' && o.maxChars === 1200;
});
check('clampMaxChars: bounds + non-numeric', () =>
  clampMaxChars(0) === 1 && clampMaxChars(999999) === 20000 && clampMaxChars('x') === 400 && clampMaxChars(400) === 400);

check('buildQuery: full excludes its four constituents (no 400 for codex sidechains)', () => {
  const q = parseQ(buildExportQuery({ source: 'codex', ref: '/r', opts: { full: true, sidechains: true, tools: true }, capabilities: CODEX_CAPS }));
  return q.get('full') === '1' && !q.has('sidechains') && !q.has('tools') && !q.has('toolResults') && !q.has('thinking');
});
check('buildQuery: claude history="on" (unavailable) is dropped', () => {
  const q = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: { history: 'on' }, capabilities: CLAUDE_CAPS }));
  return !q.has('history');
});
check('buildQuery: codex notApplicable flags dropped, supported kept', () => {
  const q = parseQ(buildExportQuery({ source: 'codex', ref: '/r', opts: { verbatim: true, embedImages: true, thinking: true, raw: true }, capabilities: CODEX_CAPS }));
  return !q.has('verbatim') && !q.has('embedImages') && q.get('thinking') === '1' && q.get('raw') === '1';
});
check('buildQuery: history sent only when supported and not auto', () => {
  const caps = { ...CLAUDE_CAPS, history: 'supported' };
  const on = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: { history: 'off' }, capabilities: caps }));
  const auto = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: { history: 'auto' }, capabilities: caps }));
  return on.get('history') === 'off' && !auto.has('history');
});
check('buildQuery: maxChars omitted at default, included otherwise', () => {
  const def = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: { maxChars: 400 }, capabilities: CLAUDE_CAPS }));
  const big = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: { maxChars: 8000 }, capabilities: CLAUDE_CAPS }));
  return !def.has('maxChars') && big.get('maxChars') === '8000';
});
check('buildQuery: download flag adds download=1', () => {
  const q = parseQ(buildExportQuery({ source: 'claude', ref: '/r', opts: {}, capabilities: CLAUDE_CAPS, download: true }));
  return q.get('download') === '1';
});
check('buildQuery: reserved/unicode ref round-trips via URLSearchParams', () => {
  const ref = '/Users/x/proj & co/a+b#c/日本語/rollout.jsonl';
  const q = parseQ(buildExportQuery({ source: 'codex', ref, opts: {}, capabilities: CODEX_CAPS }));
  return q.get('ref') === ref && q.get('source') === 'codex';
});

// ---- report ----
const ms = Date.now() - t0;
console.log(`\nsources: ${Object.keys(bySource).length}/${Object.keys(SOURCE_META).length} with data · conversations: ${all.length} · ${ms}ms`);
console.log(`PASS ${pass}  FAIL ${fails.length}`);
if (fails.length) {
  console.log('FAILURES:\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('✓ all checks passed');
