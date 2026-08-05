// Hermetic acceptance harness for the Antigravity CLI (agy) adapter.
// Stages fixtures under a temp HOME and imports the adapter in a child process,
// because the source root is captured at module load. Mirrors the structure of
// scripts/kimi-adapter-test.mjs. Proves the contract in
// docs/antigravity-a1-implementation-notes-2026-08-05.md.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_URL = pathToFileURL(fileURLToPath(new URL('../server/sources/antigravity.js', import.meta.url))).href;
const USAGE_URL = pathToFileURL(fileURLToPath(new URL('../server/usage.js', import.meta.url))).href;

let pass = 0;
const fails = [];
const check = (name, cond) => {
  try { (typeof cond === 'function' ? cond() : cond) ? pass++ : fails.push(name); }
  catch (e) { fails.push(`${name}: threw ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const CHILD_SCRIPT = `
const [adapterUrl, scenario, ...args] = process.argv.slice(1);
const adapter = await import(adapterUrl);
const wrap = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.message, code: e.code || null } } };
let result;
if (scenario === 'list') result = await wrap(() => adapter.list());
else if (scenario === 'detail') result = await wrap(() => adapter.detail(args[0], args[1] !== undefined ? Number(args[1]) : undefined));
else if (scenario === 'usage') {
  const usage = await import(args[0]);
  result = await wrap(async () => (await usage.getUsage()).find((u) => u.source === 'antigravity'));
} else throw new Error('unknown scenario ' + scenario);
console.log(JSON.stringify(result));
`;

function runChild(tempHome, scenario, ...args) {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD_SCRIPT, ADAPTER_URL, scenario, ...args],
    { env: { ...process.env, HOME: tempHome }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.trim());
}

const T0 = 1785200000000;
const isoOf = (ms) => new Date(ms).toISOString();
const CANARY = 'SECRET-LEAK-CANARY';

const A = '00000000-0000-0000-0000-000000000001'; // rich
const B = '00000000-0000-0000-0000-000000000002'; // malformed + null lines, renamed
const C = '00000000-0000-0000-0000-000000000005'; // metadata-only user input
const D = '00000000-0000-0000-0000-000000000007'; // metadata-only FIRST turn, real prompt later
const EMPTY = '00000000-0000-0000-0000-000000000004';
const SYMFILE = '00000000-0000-0000-0000-000000000006'; // transcript file symlinked out

function stageFixtures() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-agy-adapter-'));
  const root = path.join(tempHome, '.gemini', 'antigravity-cli');
  const brain = path.join(root, 'brain');
  const convs = path.join(root, 'conversations');
  fs.mkdirSync(brain, { recursive: true });
  fs.mkdirSync(convs, { recursive: true });

  // Objects are JSON-encoded; a raw STRING line is written verbatim, so a
  // genuinely malformed / non-object line survives to the parser.
  const writeSession = (id, dbCwd, lines) => {
    const d = path.join(brain, id, '.system_generated', 'logs');
    fs.mkdirSync(d, { recursive: true });
    const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
    fs.writeFileSync(path.join(d, 'transcript_full.jsonl'), body);
    if (dbCwd !== undefined) {
      fs.writeFileSync(path.join(convs, `${id}.db`), dbCwd ? `noise "file://${dbCwd}" tail` : 'no uris here');
    }
    return d;
  };

  // ---- A: rich transcript, workspace = tempHome (db byte-scan) ---------------
  writeSession(A, tempHome, [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: isoOf(T0),
      content: '<USER_REQUEST>\nwhat model am I running?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime: whenever\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.6 Flash (High). No need to comment.\n</USER_SETTINGS_CHANGE>' },
    { step_index: 1, type: 'CONVERSATION_HISTORY', source: 'SYSTEM', created_at: isoOf(T0 + 1000) },
    { step_index: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 2000),
      thinking: 'Let me look at the guide.', tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/some/skill.md' } }] },
    { step_index: 3, type: 'VIEW_FILE', source: 'MODEL', created_at: isoOf(T0 + 3000), content: 'line 1\nline 2 of the file' },
    { step_index: 4, type: 'CHECKPOINT', source: 'SYSTEM', created_at: isoOf(T0 + 4000), content: 'checkpoint blob' },
    // An empty status/streaming PLANNER_RESPONSE — must be skipped, not counted.
    { step_index: 5, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 4500) },
    { step_index: 6, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 5000), content: 'You are running Gemini 3.6 Flash.' },
  ]);

  // ---- B: malformed AND valid-non-object lines both isolated -----------------
  writeSession(B, '/does/not/exist', [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: isoOf(T0 + 100), content: '<USER_REQUEST>plain prompt</USER_REQUEST>' },
    '{ this is not valid json',   // malformed → JSON.parse throws
    'null',                        // valid JSON, non-object → must not throw
    '42',                          // valid JSON, non-object
    { step_index: 4, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 200), content: 'plain reply' },
  ]);

  // ---- C: metadata-only USER_INPUT ⇒ no user text leaks, model/effort still set
  writeSession(C, undefined, [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: isoOf(T0 + 300),
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.6 Flash (Low).\n</USER_SETTINGS_CHANGE>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 400), content: 'ok' },
  ]);

  // ---- D: metadata-only FIRST turn, then a real prompt -----------------------
  // Both list() and detail() must title from the real prompt, never the empty
  // first turn.
  // D also runs a NON-Gemini model: Claude "(Thinking)" — the parenthetical is
  // not one of High/Medium/Low, so the badge must still resolve.
  writeSession(D, undefined, [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: isoOf(T0 + 500),
      content: '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Claude Opus 4.6 (Thinking). No need to comment.\n</USER_SETTINGS_CHANGE>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 600), content: 'first reply' },
    { step_index: 2, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: isoOf(T0 + 700), content: '<USER_REQUEST>the real question</USER_REQUEST>' },
    { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: isoOf(T0 + 800), content: 'second reply' },
  ]);

  // ---- EMPTY: no real turns ⇒ not listed -------------------------------------
  writeSession(EMPTY, undefined, []);

  // A DECOY transcript nested under a non-UUID dir. Recursive enumeration would
  // derive A's uuid and double-count it; direct-child enumeration must ignore it.
  const decoyLogs = path.join(brain, 'junk', A, '.system_generated', 'logs');
  fs.mkdirSync(decoyLogs, { recursive: true });
  fs.writeFileSync(path.join(decoyLogs, 'transcript_full.jsonl'),
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'decoy', created_at: isoOf(T0) }) + '\n');

  // User renames, stored as text-protobuf in annotations/<id>.pbtxt. B's carries
  // an escaped quote to exercise C-style unescaping (not a naive \\(.)→$1).
  fs.mkdirSync(path.join(root, 'annotations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'annotations', `${B}.pbtxt`), 'title:"renamed \\"session\\""\n');

  // ---- Evil root + escapes ---------------------------------------------------
  const evilDir = path.join(tempHome, '.gemini', 'antigravity-cli-evil');
  const evilLogs = path.join(evilDir, 'brain', '00000000-0000-0000-0000-000000000003', '.system_generated', 'logs');
  fs.mkdirSync(evilLogs, { recursive: true });
  fs.writeFileSync(path.join(evilLogs, 'transcript_full.jsonl'),
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: CANARY, created_at: isoOf(T0) }) + '\n');

  // A canary transcript that lives outside the root.
  const outsideFile = path.join(evilDir, 'outside-transcript.jsonl');
  fs.writeFileSync(outsideFile, JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: CANARY, created_at: isoOf(T0) }) + '\n');

  // Symlinked whole brain dir escaping root (list skips a non-dir symlink; detail realpath-rejects).
  const symTarget = path.join(evilDir, 'sym-target');
  fs.mkdirSync(path.join(symTarget, '.system_generated', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(symTarget, '.system_generated', 'logs', 'transcript_full.jsonl'),
    JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: CANARY, created_at: isoOf(T0) }) + '\n');
  fs.symlinkSync(symTarget, path.join(brain, '00000000-0000-0000-0000-000000000009'));

  // A REAL uuid session dir whose transcript FILE is symlinked outside the root:
  // list()/usage must realpath it and refuse, so the canary never surfaces.
  const symFileLogs = path.join(brain, SYMFILE, '.system_generated', 'logs');
  fs.mkdirSync(symFileLogs, { recursive: true });
  fs.symlinkSync(outsideFile, path.join(symFileLogs, 'transcript_full.jsonl'));

  return { tempHome };
}

const { tempHome } = stageFixtures();
try {
  const listResult = runChild(tempHome, 'list');
  check('list() did not throw', () => { assert(listResult.ok, `list threw: ${listResult.err}`); return true; });
  const entries = listResult.ok || [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  check('list: good sessions listed; bad/empty/symlinked/decoy isolated', () => {
    const ids = [...byId.keys()].sort();
    assert(JSON.stringify(ids) === JSON.stringify([A, B, C, D]),
      `expected [${A}, ${B}, ${C}, ${D}] — EMPTY/decoy/symlinks/evil never listed, got: ${ids.join(',')}`);
    return true;
  });

  const a = byId.get(A);
  check('A list-entry: title strips wrapper, model+effort, project, times, count', () => {
    assert(a && a.source === 'antigravity' && a.ref === A, 'A identity');
    assert(a.title === 'what model am I running?', `title (USER_REQUEST body only): ${JSON.stringify(a.title)}`);
    assert(a.model === 'Gemini 3.6 Flash' && a.effort === 'high', `model/effort: ${a.model}/${a.effort}`);
    assert(a.projectPath === tempHome, `projectPath from db byte-scan: ${a.projectPath}`);
    assert(a.firstActivity === isoOf(T0) && a.lastActivity === isoOf(T0 + 5000), `times: ${a.firstActivity}..${a.lastActivity}`);
    assert(a.messageCount === 3, `1 user + 2 assistant (markers/tool/empty excluded): ${a.messageCount}`);
    assert(a.resume === `cd ${JSON.stringify(tempHome)} && agy --conversation ${A}`, `resume: ${a.resume}`);
    return true;
  });

  const b = byId.get(B);
  check('B list-entry: malformed + non-object lines isolated, session survives', () => {
    assert(b, 'missing entry B');
    assert(b.model === null && b.effort === null, `no settings-change ⇒ null: ${b.model}/${b.effort}`);
    assert(b.messageCount === 2, `1 user + 1 assistant (bad + null + 42 dropped): ${b.messageCount}`);
    return true;
  });
  check('B: a user rename (annotations pbtxt) overrides the derived title, escapes decoded', () => {
    assert(b.title === 'renamed "session"', `custom title (unescaped) must win: ${JSON.stringify(b.title)}`);
    assert(b.firstUserText === 'plain prompt', `firstUserText still the derived prompt: ${JSON.stringify(b.firstUserText)}`);
    const dB = runChild(tempHome, 'detail', B);
    assert(dB.ok && dB.ok.title === 'renamed "session"', `detail title must also be the rename: ${dB.ok && dB.ok.title}`);
    return true;
  });

  const d = byId.get(D);
  check('D: metadata-only FIRST turn ⇒ list AND detail title from the real prompt', () => {
    assert(d && d.title === 'the real question', `list title: ${JSON.stringify(d && d.title)}`);
    const dD = runChild(tempHome, 'detail', D);
    assert(dD.ok && dD.ok.title === 'the real question', `detail title must not be empty: ${JSON.stringify(dD.ok && dD.ok.title)}`);
    return true;
  });
  check('D: a NON-Gemini model badge resolves — Claude "(Thinking)"', () => {
    assert(d.model === 'Claude Opus 4.6', `model (dots preserved, paren delimits): ${JSON.stringify(d.model)}`);
    assert(d.effort === 'thinking', `effort from any parenthetical: ${JSON.stringify(d.effort)}`);
    return true;
  });

  const c = byId.get(C);
  check('C list-entry: metadata-only user input never leaks injected text', () => {
    assert(c, 'missing entry C');
    assert(c.model === 'Gemini 3.6 Flash' && c.effort === 'low', `model/effort: ${c.model}/${c.effort}`);
    assert(!/SETTINGS_CHANGE|Model Selection/.test(c.title || ''), `title leaked injected block: ${JSON.stringify(c.title)}`);
    assert(!/SETTINGS_CHANGE|Model Selection/.test(c.firstUserText || ''), `firstUserText leaked: ${JSON.stringify(c.firstUserText)}`);
    return true;
  });

  const detailA = runChild(tempHome, 'detail', A);
  check('A detail: role/marker mapping in transcript order', () => {
    assert(detailA.ok, `detail threw: ${detailA.err}`);
    const m = detailA.ok.messages;
    assert(m.length === 4, `4 messages (2 SYSTEM markers + empty step skipped): ${m.length}`);
    assert(m[0].role === 'user' && m[0].text === 'what model am I running?', `m0: ${JSON.stringify(m[0])}`);
    assert(!/ADDITIONAL_METADATA|SETTINGS_CHANGE/.test(m[0].text), 'm0 leaked injected block');
    assert(m[1].role === 'assistant', 'm1 assistant');
    const iThink = m[1].text.indexOf('💭'), iTool = m[1].text.indexOf('🔧');
    assert(iThink >= 0 && iTool >= 0 && iThink < iTool, `m1 must be 💭 before 🔧: ${JSON.stringify(m[1].text)}`);
    assert(m[1].text.includes('view_file'), 'm1 tool name present');
    assert(m[2].role === 'tool' && m[2].text.startsWith('↳'), `m2 tool-result: ${JSON.stringify(m[2].text)}`);
    assert(m[3].role === 'assistant' && m[3].text === 'You are running Gemini 3.6 Flash.', `m3: ${JSON.stringify(m[3])}`);
    return true;
  });

  const detailC = runChild(tempHome, 'detail', C);
  check('C detail: metadata-only user message renders as empty, no leak', () => {
    assert(detailC.ok, `detail threw: ${detailC.err}`);
    const u = detailC.ok.messages.find((m) => m.role === 'user');
    assert(u && u.text === '', `metadata-only user text must be empty: ${JSON.stringify(u && u.text)}`);
    assert(!JSON.stringify(detailC.ok.messages).includes('SETTINGS_CHANGE'), 'injected block leaked into detail');
    return true;
  });

  const detailLastN = runChild(tempHome, 'detail', A, '2');
  check('A detail: lastN truncates after the full merge', () => {
    const m = detailLastN.ok.messages;
    assert(m.length === 2 && m[0].role === 'tool' && m[1].role === 'assistant', `lastN=2 keeps final two: ${m.length}`);
    return true;
  });

  check('security: no canary from any evil/symlink path leaks into list()', () => {
    assert(!JSON.stringify(entries).includes(CANARY), 'canary leaked into list()');
    return true;
  });

  check('security: symlinked brain dir → detail rejected, no canary', () => {
    const r = runChild(tempHome, 'detail', '00000000-0000-0000-0000-000000000009');
    assert(!r.ok && !JSON.stringify(r).includes(CANARY), 'symlink-dir escape leaked');
    return true;
  });

  check('security: symlinked transcript FILE → detail rejected, no canary', () => {
    const r = runChild(tempHome, 'detail', SYMFILE);
    assert(!r.ok && !JSON.stringify(r).includes(CANARY), 'symlinked-transcript escape leaked');
    return true;
  });

  const forbidden = [
    ['traversal ref', '../../etc/passwd'],
    ['absolute path ref', '/etc/passwd'],
    ['sibling-prefix root ref', path.join(tempHome, '.gemini', 'antigravity-cli-evil', 'brain', '00000000-0000-0000-0000-000000000003')],
  ];
  for (const [label, ref] of forbidden) {
    check(`security: ${label} → rejected`, () => {
      const r = runChild(tempHome, 'detail', ref);
      assert(!r.ok && (r.err === 'forbidden' || r.code === 'not_found' || r.err === 'not found'),
        `expected forbidden/not-found, got: ${r.err} (code ${r.code})`);
      return true;
    });
  }
  check('security: non-UUID ref → forbidden BY CHARSET GUARD (not not-found)', () => {
    const r = runChild(tempHome, 'detail', 'not-a-uuid-at-all');
    assert(!r.ok && (r.err === 'forbidden' || r.code === 'forbidden'),
      `charset guard must reject with 'forbidden', got: ${r.err} (code ${r.code})`);
    return true;
  });

  const usageResult = runChild(tempHome, 'usage', USAGE_URL);
  check('usage: activity kind, counts match the adapter (no decoy double-count)', () => {
    assert(usageResult.ok && usageResult.ok.kind === 'activity', `kind: ${usageResult.ok && usageResult.ok.kind}`);
    const val = (k) => usageResult.ok.metrics.find((m) => m.key === k)?.value;
    assert(val('sessions') === 4, `sessions expected 4 (A,B,C,D; decoy ignored), got ${val('sessions')}`);
    assert(val('messages') === 11, `messages expected 11 (A:3 + B:2 + C:2 + D:4), got ${val('messages')}`);
    return true;
  });

} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log(`\nPASS ${pass} FAIL ${fails.length}`);
for (const f of fails) console.log(`  FAIL: ${f}`);
process.exit(fails.length ? 1 : 0);
