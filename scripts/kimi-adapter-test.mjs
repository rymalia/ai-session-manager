// Kimi adapter (K1) hermetic test harness. Stages fixture sessions under a
// temporary HOME and imports server/sources/kimi.js in CHILD processes, because
// the adapter captures ROOT from os.homedir() at module load (same constraint
// as scripts/smoke-test.mjs). Run: node scripts/kimi-adapter-test.mjs
// Exits non-zero on any failure.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_URL = pathToFileURL(fileURLToPath(new URL('../server/sources/kimi.js', import.meta.url))).href;
const USAGE_URL = pathToFileURL(fileURLToPath(new URL('../server/usage.js', import.meta.url))).href;

let pass = 0;
const fails = [];
const check = (name, cond) => {
  try { (typeof cond === 'function' ? cond() : cond) ? pass++ : fails.push(name); }
  catch (e) { fails.push(`${name}: threw ${e.message}`); }
};
const acheck = async (name, fn) => { try { await fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// Child-process runner: imports the adapter with HOME pointed at the staged
// fixture root, runs one scenario, prints a single JSON result line.
const CHILD_SCRIPT = `
import fs from 'node:fs';
const [adapterUrl, scenario, ...args] = process.argv.slice(1);
const adapter = await import(adapterUrl);
const wrap = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { err: e.message, code: e.code || null } } };
let result;
if (scenario === 'list') result = await wrap(() => adapter.list());
else if (scenario === 'detail') result = await wrap(() => adapter.detail(args[0], args[1] !== undefined ? Number(args[1]) : undefined));
else if (scenario === 'list-append-list') {
  const first = await adapter.list();
  fs.appendFileSync(args[0], args[1] + '\\n');
  const second = await adapter.list();
  result = { ok: { first, second } };
}
else if (scenario === 'usage') {
  const usage = await import(args[0]);
  result = await wrap(async () => (await usage.getUsage()).find((u) => u.source === 'kimi'));
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

// ---- fixture staging ---------------------------------------------------------

const T0 = 1785200000000; // ~2026-07-27, epoch ms (wire `time` units)
const isoOf = (ms) => new Date(ms).toISOString();
const CANARY = 'SECRET-LEAK-CANARY';
const INJECTED = 'INJECTED-REMINDER-CANARY';

const line = (o) => JSON.stringify(o);
const prompt = (text, time, origin = { kind: 'user' }) =>
  line({ type: 'turn.prompt', input: [{ type: 'text', text }], origin, time });
const appendMsg = (text, time) =>
  line({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text }] }, time });
const stepBegin = (uuid, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'step.begin', uuid, step: 1 }, time });
const stepEnd = (uuid, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'step.end', uuid, step: 1, usage: { inputOther: 10, output: 5 } }, time });
const textPart = (text, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } }, time });
const thinkPart = (think, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think } }, time });
const toolCall = (name, args, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'tool.call', name, args, toolCallId: 'tc1' }, time });
const toolResult = (output, time) =>
  line({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tc1', result: { output } }, time });
const llmRequest = (fields, time) => line({ type: 'llm.request', kind: 'loop', ...fields, time });
const usageRecord = (time, usage = { inputOther: 10, output: 5 }) =>
  line({ type: 'usage.record', model: 'x', usage, usageScope: 'turn', time });

function writeSession(tempHome, dirName, sessionId, { state, wires }) {
  const dir = path.join(tempHome, '.kimi-code', 'sessions', dirName, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  if (state !== null) fs.writeFileSync(path.join(dir, 'state.json'), state);
  for (const [key, lines] of Object.entries(wires || {})) {
    const home = path.join(dir, 'agents', key);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'wire.jsonl'), lines.join('\n') + '\n');
  }
  return dir;
}

const agentEntry = (dir, key) => ({ homedir: path.join(dir, 'agents', key), type: key === 'main' ? 'main' : 'subagent' });

function stageFixtures() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-kimi-adapter-'));
  const root = path.join(tempHome, '.kimi-code');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });

  // A: main-only session. state.updatedAt is deliberately STALE (older than
  // the wire) to prove wire-derived recency.
  const dirA = writeSession(tempHome, 'wd_main_aaaa', 'session_main-only-1', {
    state: JSON.stringify({
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T01:00:00.000Z',
      title: 'Flaky test session', isCustomTitle: true, workDir: '/work/main',
      agents: { main: agentEntry(path.join(root, 'sessions', 'wd_main_aaaa', 'session_main-only-1'), 'main') },
    }),
    wires: {
      main: [
        line({ type: 'metadata', protocol_version: '1.4', created_at: T0 }),
        prompt('fix the flaky test', T0 + 2000),
        appendMsg('fix the flaky test', T0 + 2100), // duplicated prompt — must NOT double-count
        appendMsg(`<system-reminder>${INJECTED}</system-reminder>`, T0 + 2200), // injected — must NOT surface
        stepBegin('s1', T0 + 3000),
        llmRequest({ model: 'k2-think', modelAlias: 'kimi-code/k2-think', thinkingEffort: 'high' }, T0 + 3100),
        thinkPart('pondering deeply', T0 + 3200),
        textPart('Let me look at the test.', T0 + 3300),
        toolCall('Read', { path: 'test.js' }, T0 + 3400),
        toolResult('file contents here', T0 + 3500),
        stepEnd('s1', T0 + 3600),
        usageRecord(T0 + 3700),
        prompt('now ship it', T0 + 4000),
        stepBegin('s2', T0 + 4100),
        llmRequest({ model: 'k3-256k', modelAlias: 'kimi-code/k3-256k' }, T0 + 4200), // model, NO effort → pair clears
        textPart('Done.', T0 + 4300),
        stepEnd('s2', T0 + 4400),
      ],
    },
  });

  // B: main + subagent, with an exact-timestamp tie (main must sort first) and
  // a subagent on a DIFFERENT model (must not relabel the session).
  const dirB = writeSession(tempHome, 'wd_sub_bbbb', 'session_with-sub-2', {
    state: JSON.stringify({
      createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T01:00:00.000Z',
      title: 'Subagent session', isCustomTitle: false, workDir: '/work/sub',
      agents: {
        main: agentEntry(path.join(root, 'sessions', 'wd_sub_bbbb', 'session_with-sub-2'), 'main'),
        'sub-research': agentEntry(path.join(root, 'sessions', 'wd_sub_bbbb', 'session_with-sub-2'), 'sub-research'),
      },
    }),
    wires: {
      main: [
        prompt('main prompt', T0 + 1000),
        stepBegin('m1', T0 + 2900),
        llmRequest({ model: 'main-model', thinkingEffort: 'low' }, T0 + 2950),
        textPart('main reply', T0 + 3000),
        stepEnd('m1', T0 + 3100),
        usageRecord(T0 + 3150, { inputOther: 100, output: 50, inputCacheRead: 1000, inputCacheCreation: 200 }),
      ],
      'sub-research': [
        prompt('sub task brief', T0 + 2000),
        stepBegin('u1', T0 + 2900), // exact step-begin tie with the main step
        llmRequest({ model: 'sub-model', thinkingEffort: 'high' }, T0 + 2950),
        textPart('sub reply', T0 + 3000),
        stepEnd('u1', T0 + 3050),
        usageRecord(T0 + 3060, { inputOther: 7, output: 3 }),
      ],
    },
  });

  // C: malformed state.json — list must skip it, never abort.
  writeSession(tempHome, 'wd_badstate_cccc', 'session_bad-state-3', {
    state: '{not json at all',
    wires: { main: [prompt('unreachable', T0)] },
  });

  // D: one malformed wire line among good ones — session still lists.
  writeSession(tempHome, 'wd_badwire_dddd', 'session_bad-wire-4', {
    state: JSON.stringify({
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T01:00:00.000Z',
      title: 'Bad wire session', workDir: '/work/badwire',
      agents: { main: agentEntry(path.join(root, 'sessions', 'wd_badwire_dddd', 'session_bad-wire-4'), 'main') },
    }),
    wires: {
      main: [
        prompt('good prompt', T0 + 100),
        '{definitely not json',
        stepBegin('b1', T0 + 200),
        textPart('good reply', T0 + 300),
        stepEnd('b1', T0 + 400),
      ],
    },
  });

  // Duplicate id: two index lines for session_dupe-5 — last record wins.
  const dirDupeOld = writeSession(tempHome, 'wd_dupeold_eeee', 'session_dupe-5', {
    state: JSON.stringify({
      createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T01:00:00.000Z',
      title: 'Dupe old', workDir: '/work/dupe-old',
      agents: { main: agentEntry(path.join(root, 'sessions', 'wd_dupeold_eeee', 'session_dupe-5'), 'main') },
    }),
    wires: { main: [prompt('old dupe prompt', T0)] },
  });
  const dirDupeNew = writeSession(tempHome, 'wd_dupenew_ffff', 'session_dupe-5', {
    state: JSON.stringify({
      createdAt: '2026-07-23T02:00:00.000Z', updatedAt: '2026-07-23T03:00:00.000Z',
      title: 'Dupe new', workDir: '/work/dupe-final',
      agents: { main: agentEntry(path.join(root, 'sessions', 'wd_dupenew_ffff', 'session_dupe-5'), 'main') },
    }),
    wires: { main: [prompt('final dupe prompt', T0 + 5000)] },
  });

  // Evil canary content OUTSIDE the Kimi root — must never be read.
  // Leading dot is load-bearing: the whole point is the startsWith() prefix trap,
  // and 'kimi-code-evil' is not a prefix-sibling of '.kimi-code' — a BROKEN
  // implementation would reject it too, making the case vacuous (Codex review).
  const evilDir = path.join(tempHome, '.kimi-code-evil');
  const evilSessionDir = path.join(evilDir, 'session_evil-dir-6');
  fs.mkdirSync(path.join(evilSessionDir, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(evilSessionDir, 'state.json'), JSON.stringify({
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    title: CANARY, workDir: '/evil',
    agents: { main: { homedir: path.join(evilSessionDir, 'agents', 'main'), type: 'main' } },
  }));
  fs.writeFileSync(path.join(evilSessionDir, 'agents', 'main', 'wire.jsonl'), prompt(CANARY, T0) + '\n');

  // I/J/K: SYMLINK escapes. Each is lexically inside its boundary but resolves
  // outside it, so only realpath-based containment stops them.
  const symTarget = path.join(evilDir, 'sym-target');
  fs.mkdirSync(path.join(symTarget, 'agents', 'main'), { recursive: true });
  fs.writeFileSync(path.join(symTarget, 'state.json'), JSON.stringify({
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    title: CANARY, workDir: '/evil',
    agents: { main: { homedir: path.join(symTarget, 'agents', 'main'), type: 'main' } },
  }));
  fs.writeFileSync(path.join(symTarget, 'agents', 'main', 'wire.jsonl'), prompt(CANARY, T0) + '\n');

  // I: sessionDir is a symlink inside the root pointing out of it.
  const symDir = path.join(root, 'sessions', 'session_symdir-9');
  fs.mkdirSync(path.dirname(symDir), { recursive: true });
  fs.symlinkSync(symTarget, symDir);

  // J: a real session dir whose agent homedir is a symlink pointing out.
  const dirI = path.join(root, 'sessions', 'wd_symhome_iiii', 'session_symhome-10');
  fs.mkdirSync(path.join(dirI, 'agents'), { recursive: true });
  fs.symlinkSync(path.join(symTarget, 'agents', 'main'), path.join(dirI, 'agents', 'main'));
  fs.writeFileSync(path.join(dirI, 'state.json'), JSON.stringify({
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    title: 'Sym home', workDir: '/work/symhome',
    agents: { main: { homedir: path.join(dirI, 'agents', 'main'), type: 'main' } },
  }));

  // K: real dir, real homedir, but wire.jsonl itself is a symlink pointing out.
  const dirJ = path.join(root, 'sessions', 'wd_symwire_jjjj', 'session_symwire-11');
  fs.mkdirSync(path.join(dirJ, 'agents', 'main'), { recursive: true });
  fs.symlinkSync(path.join(symTarget, 'agents', 'main', 'wire.jsonl'),
    path.join(dirJ, 'agents', 'main', 'wire.jsonl'));
  fs.writeFileSync(path.join(dirJ, 'state.json'), JSON.stringify({
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    title: 'Sym wire', workDir: '/work/symwire',
    agents: { main: { homedir: path.join(dirJ, 'agents', 'main'), type: 'main' } },
  }));

  // G: state.json whose MAIN homedir points outside the session dir.
  const evilMainHome = path.join(evilDir, 'stolen-main');
  fs.mkdirSync(evilMainHome, { recursive: true });
  fs.writeFileSync(path.join(evilMainHome, 'wire.jsonl'), prompt(CANARY, T0) + '\n');
  const dirG = path.join(root, 'sessions', 'wd_evilhome_gggg', 'session_evil-home-7');
  fs.mkdirSync(dirG, { recursive: true });
  fs.writeFileSync(path.join(dirG, 'state.json'), JSON.stringify({
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
    title: 'Evil home', workDir: '/work/evilhome',
    agents: { main: { homedir: evilMainHome, type: 'main' } },
  }));

  // H: main is fine but a SUBAGENT homedir escapes the session dir — the
  // subagent is never followed; detail still serves the main wire.
  const dirH = writeSession(tempHome, 'wd_evilsub_hhhh', 'session_evil-sub-8', {
    state: JSON.stringify({
      createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T01:00:00.000Z',
      title: 'Evil sub home', workDir: '/work/evilsub',
      agents: {
        main: agentEntry(path.join(root, 'sessions', 'wd_evilsub_hhhh', 'session_evil-sub-8'), 'main'),
        'sub-evil': { homedir: path.join(evilDir, 'stolen-main'), type: 'subagent' },
      },
    }),
    wires: { main: [prompt('honest prompt', T0 + 100)] },
  });

  const indexLines = [
    JSON.stringify({ sessionId: 'session_main-only-1', sessionDir: dirA, workDir: '/work/main' }),
    JSON.stringify({ sessionId: 'session_with-sub-2', sessionDir: dirB, workDir: '/work/sub' }),
    JSON.stringify({ sessionId: 'session_bad-state-3', sessionDir: path.join(root, 'sessions', 'wd_badstate_cccc', 'session_bad-state-3'), workDir: '/work/badstate' }),
    JSON.stringify({ sessionId: 'session_bad-wire-4', sessionDir: path.join(root, 'sessions', 'wd_badwire_dddd', 'session_bad-wire-4'), workDir: '/work/badwire' }),
    'this line is not json at all',
    JSON.stringify({ sessionId: 'session_no-dir-9' }), // missing sessionDir — skipped
    JSON.stringify({ sessionId: 'session_dupe-5', sessionDir: dirDupeOld, workDir: '/work/dupe-old' }),
    JSON.stringify({ sessionId: 'session_dupe-5', sessionDir: dirDupeNew, workDir: '/work/dupe-final' }), // last wins
    JSON.stringify({ sessionId: 'session_evil-dir-6', sessionDir: evilSessionDir, workDir: '/evil' }), // outside root
    // Symlink escapes: each sessionDir below is LEXICALLY inside the root.
    JSON.stringify({ sessionId: 'session_symdir-9', sessionDir: symDir, workDir: '/work/symdir' }),
    JSON.stringify({ sessionId: 'session_symhome-10', sessionDir: dirI, workDir: '/work/symhome' }),
    JSON.stringify({ sessionId: 'session_symwire-11', sessionDir: dirJ, workDir: '/work/symwire' }),
    JSON.stringify({ sessionId: 'session_evil-home-7', sessionDir: dirG, workDir: '/work/evilhome' }),
    JSON.stringify({ sessionId: 'session_evil-sub-8', sessionDir: dirH, workDir: '/work/evilsub' }),
  ];
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), indexLines.join('\n') + '\n');

  return { tempHome, subWireB: path.join(dirB, 'agents', 'sub-research', 'wire.jsonl') };
}

// ---- tests -------------------------------------------------------------------

const { tempHome, subWireB } = stageFixtures();
try {
  const listResult = runChild(tempHome, 'list');
  check('fixture list() did not throw', () => { assert(listResult.ok, `list threw: ${listResult.err}`); return true; });
  const entries = listResult.ok || [];
  const byId = new Map(entries.map((e) => [e.id, e]));

  check('list: good sessions returned, bad ones isolated', () => {
    const ids = [...byId.keys()].sort();
    assert(JSON.stringify(ids) === JSON.stringify([
      'session_bad-wire-4', 'session_dupe-5', 'session_evil-sub-8',
      'session_main-only-1', 'session_with-sub-2',
    ]), `unexpected id set: ${ids.join(',')}`);
    return true;
  });

  const A = byId.get('session_main-only-1');
  check('A: entry fields (ref/title/project/model pair cleared)', () => {
    assert(A, 'missing entry A');
    assert(A.source === 'kimi', 'source');
    assert(A.ref === 'session_main-only-1' && A.id === 'session_main-only-1', 'ref/id must be the sessionId');
    assert(A.key === 'kimi:session_main-only-1', 'key');
    assert(A.title === 'Flaky test session', `title: ${A.title}`);
    assert(A.projectPath === '/work/main', `projectPath: ${A.projectPath}`);
    assert(A.projectLabel === 'main', `projectLabel: ${A.projectLabel}`);
    assert(A.model === 'k3-256k', `model must be last main llm.request: ${A.model}`);
    assert(A.effort === null, `later request without effort must clear it: ${A.effort}`);
    return true;
  });

  check('A: counts, recency from wire (stale updatedAt loses), resume string', () => {
    // 2 canonical user turns + 2 grouped assistant steps; tool rows do NOT count.
    assert(A.messageCount === 4, `messageCount: ${A.messageCount}`);
    assert(A.firstUserText === 'fix the flaky test', `firstUserText: ${A.firstUserText}`);
    assert(A.firstActivity === isoOf(T0 + 2000), `firstActivity: ${A.firstActivity}`);
    assert(A.lastActivity === isoOf(T0 + 4400), `lastActivity must come from the wire, not stale state.updatedAt: ${A.lastActivity}`);
    assert(Date.parse(A.lastActivity) > Date.parse('2026-07-20T01:00:00.000Z'), 'wire recency must beat state.updatedAt');
    assert(A.resume === 'cd "/work/main" && kimi -S session_main-only-1', `resume: ${A.resume}`);
    assert(typeof A.cacheSignature === 'string' && A.cacheSignature.includes('state.json@') && A.cacheSignature.includes('main/wire.jsonl@'), `cacheSignature: ${A.cacheSignature}`);
    return true;
  });

  const detailA = runChild(tempHome, 'detail', 'session_main-only-1');
  check('A: detail — canonical prompts only, grouped step, wire order', () => {
    assert(detailA.ok, `detail threw: ${detailA.err}`);
    const d = detailA.ok;
    assert(d.source === 'kimi' && d.id === 'session_main-only-1', 'source/id');
    assert(d.title === 'Flaky test session', 'title');
    assert(d.projectPath === '/work/main' && d.gitBranch === null, 'projectPath/gitBranch');
    assert(d.resume === 'cd "/work/main" && kimi -S session_main-only-1', 'resume');
    const roles = d.messages.map((m) => m.role);
    assert(JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'tool', 'user', 'assistant']),
      `roles in wire order: ${roles.join(',')}`);
    const stepMsg = d.messages[1];
    assert(stepMsg.text.includes('💭 pondering deeply'), 'thinking marker missing');
    assert(stepMsg.text.includes('Let me look at the test.'), 'text part missing');
    assert(stepMsg.text.includes('🔧 Read('), 'tool-call marker missing');
    assert(stepMsg.text.indexOf('💭') < stepMsg.text.indexOf('Let me look') && stepMsg.text.indexOf('Let me look') < stepMsg.text.indexOf('🔧'),
      'step parts out of order');
    assert(d.messages[2].text.startsWith('↳ file contents here'), `tool result marker: ${d.messages[2].text}`);
    const users = d.messages.filter((m) => m.role === 'user');
    assert(users.length === 2, `append_message must not add user turns: ${users.length}`);
    assert(!JSON.stringify(d.messages).includes(INJECTED), 'injected reminder leaked into messages');
    assert(d.messages.every((m) => m.sidechain === false && m.source === 'main'), 'main-only provenance fields');
    return true;
  });

  const detailAlastN = runChild(tempHome, 'detail', 'session_main-only-1', '2');
  check('A: lastN applies to merged normalized messages', () => {
    assert(detailAlastN.ok, `detail threw: ${detailAlastN.err}`);
    const msgs = detailAlastN.ok.messages;
    assert(msgs.length === 2, `length: ${msgs.length}`);
    assert(msgs[0].role === 'user' && msgs[0].text === 'now ship it', 'lastN[0]');
    assert(msgs[1].role === 'assistant' && msgs[1].text === 'Done.', 'lastN[1]');
    return true;
  });

  const B = byId.get('session_with-sub-2');
  check('B: entry — model from last MAIN request despite subagent model', () => {
    assert(B, 'missing entry B');
    assert(B.model === 'main-model', `model: ${B.model}`);
    assert(B.effort === 'low', `effort: ${B.effort}`);
    assert(B.messageCount === 4, `messageCount: ${B.messageCount}`);
    assert(B.cacheSignature.includes('sub-research/wire.jsonl@'), `cacheSignature must cover the subagent wire: ${B.cacheSignature}`);
    return true;
  });

  const detailB = runChild(tempHome, 'detail', 'session_with-sub-2');
  check('B: detail — deterministic merge order + visible sidechain provenance', () => {
    assert(detailB.ok, `detail threw: ${detailB.err}`);
    const msgs = detailB.ok.messages;
    const sig = msgs.map((m) => `${m.role}:${m.source}`);
    // tie at T0+3000: main reply before sub reply (main-before-subagents)
    assert(JSON.stringify(sig) === JSON.stringify([
      'user:main', 'user:subagent:sub-research', 'assistant:main', 'assistant:subagent:sub-research',
    ]), `merge order: ${sig.join(' | ')}`);
    assert(msgs[1].sidechain === true && msgs[3].sidechain === true, 'sidechain flags');
    assert(msgs[0].sidechain === false && msgs[2].sidechain === false, 'main sidechain flags');
    assert(msgs[1].text.startsWith('⎇ subagent:sub-research\n'), `visible provenance marker: ${JSON.stringify(msgs[1].text)}`);
    assert(msgs[3].text.startsWith('⎇ subagent:sub-research\n'), 'visible provenance marker on sub reply');
    assert(['user', 'assistant', 'tool'].includes(msgs[1].role), 'roles unchanged');
    return true;
  });

  check('cache: subagent-only append mutates cacheSignature and re-parses', () => {
    const r = runChild(tempHome, 'list-append-list', subWireB,
      prompt('late subagent prompt', T0 + 9000));
    assert(r.ok, `child threw: ${r.err}`);
    const b1 = r.ok.first.find((e) => e.id === 'session_with-sub-2');
    const b2 = r.ok.second.find((e) => e.id === 'session_with-sub-2');
    assert(b1 && b2, 'entry missing across append');
    assert(b1.cacheSignature !== b2.cacheSignature, 'cacheSignature must change on subagent-only append');
    assert(b2.messageCount === b1.messageCount + 1, `re-parse must see the appended turn: ${b1.messageCount} -> ${b2.messageCount}`);
    return true;
  });

  check('usage: usage.record only, aggregated across resolved agent wires', () => {
    const r = runChild(tempHome, 'usage', USAGE_URL);
    assert(r.ok, `usage child threw: ${r.err}`);
    const u = r.ok;
    assert(u && u.available === true, `kimi usage unavailable: ${u && u.note}`);
    assert(u.kind === 'consumed', `kind must be consumed, got: ${u.kind}`);
    const blob = JSON.stringify(u);
    assert(!/quota/i.test(blob.replace(/No remaining-quota stored locally[^"]*/, '')),
      'no quota framing allowed beyond the honest note');
    assert(!blob.includes('%'), 'percentage treatment is quota framing — not allowed');
    const tokens = u.metrics.find((m) => m.key === 'tokens');
    // usage.record lines only: A(10+5) + B-main(100+50+1000+200) + B-sub(7+3) = 1375.
    // stepEnd fixtures carry usage {inputOther:10, output:5} x4 — counting them
    // too would inflate input from 117 to 157.
    assert(tokens.value === 1375, `tokens total (double-count check): ${tokens.value}`);
    assert(tokens.detail.includes('in 117'), `input: ${tokens.detail}`);
    assert(tokens.detail.includes('out 58'), `output: ${tokens.detail}`);
    assert(tokens.detail.includes('cache 1.2K'), `cache: ${tokens.detail}`);
    assert(u.metrics.find((m) => m.key === 'records').value === 3, 'usage records counted');
    // A, B, bad-wire-4, dupe-5(last-wins), evil-sub-8 → 5 sessions; evil-dir-6
    // (outside root) and evil-home-7 (escaping homedir) never contribute.
    assert(u.metrics.find((m) => m.key === 'sessions').value === 5, 'contained sessions only');
    assert(!blob.includes(CANARY), 'canary leaked into usage');
    return true;
  });

  check('failure isolation: malformed index/state/wire skipped, good sessions intact', () => {
    assert(byId.has('session_bad-wire-4'), 'malformed wire line must not kill the session');
    assert(byId.get('session_bad-wire-4').messageCount === 2, `bad-wire count: ${byId.get('session_bad-wire-4').messageCount}`);
    assert(!byId.has('session_bad-state-3'), 'malformed state.json must be skipped');
    assert(!byId.has('session_no-dir-9'), 'index line without sessionDir must be skipped');
    assert(!byId.has('session_evil-dir-6'), 'index sessionDir outside root must be skipped');
    assert(!byId.has('session_evil-home-7'), 'session whose only homedir escapes the root must be skipped');
    return true;
  });

  check('duplicates: last index record wins', () => {
    const dupe = byId.get('session_dupe-5');
    assert(dupe, 'missing dupe entry');
    assert(dupe.projectPath === '/work/dupe-final', `last-record-wins: ${dupe.projectPath}`);
    assert(dupe.title === 'Dupe new', `title: ${dupe.title}`);
    return true;
  });

  check('security: nothing outside the root ever leaks into list()', () => {
    const blob = JSON.stringify(entries);
    assert(!blob.includes(CANARY), 'canary content leaked into list()');
    return true;
  });

  // Symlink escapes (Codex review, Critical). path.resolve() does NOT
  // dereference links, so a symlink planted INSIDE the Kimi root that points
  // outside it passes a purely lexical isInside() check while reading an
  // external file. These three cases each fail against a resolve()-only
  // implementation and pass only with realpath-based containment.
  const symCases = [
    ['symlinked sessionDir escapes root', 'session_symdir-9'],
    ['symlinked agent homedir escapes session', 'session_symhome-10'],
    ['symlinked wire.jsonl escapes homedir', 'session_symwire-11'],
  ];
  for (const [label, ref] of symCases) {
    check(`security: ${label} → no canary read`, () => {
      const r = runChild(tempHome, 'detail', ref);
      // Either a hard 'forbidden' or a clean empty read is acceptable; what is
      // NOT acceptable is the canary crossing the boundary.
      const blob = JSON.stringify(r);
      assert(!blob.includes(CANARY), `canary leaked through ${label}: ${blob.slice(0, 200)}`);
      return true;
    });
  }
  check('security: symlinked sessions never appear in list()', () => {
    const r = runChild(tempHome, 'list');
    assert(r.ok, 'list failed');
    assert(!JSON.stringify(r.ok).includes(CANARY), 'canary leaked into list() via a symlink');
    return true;
  });

  const forbiddenCases = [
    ['traversal ref', '../../etc/passwd'],
    ['absolute path ref', '/etc/passwd'],
    ['sibling-prefix root ref', path.join(tempHome, '.kimi-code-evil', 'session_evil-dir-6')],
    ['malicious index sessionDir', 'session_evil-dir-6'],
    ['malicious main homedir', 'session_evil-home-7'],
  ];
  for (const [label, ref] of forbiddenCases) {
    check(`security: ${label} → forbidden`, () => {
      const r = runChild(tempHome, 'detail', ref);
      assert(!r.ok, `detail unexpectedly succeeded for ${ref}`);
      assert(r.err === 'forbidden', `expected 'forbidden', got: ${r.err} (code ${r.code})`);
      return true;
    });
  }

  check('security: unknown-but-well-formed id → not_found', () => {
    const r = runChild(tempHome, 'detail', 'session_00000000-0000-0000-0000-000000000000');
    assert(!r.ok, 'detail unexpectedly succeeded');
    assert(r.code === 'not_found', `expected code 'not_found', got: ${r.code} (${r.err})`);
    return true;
  });

  check('security: escaping subagent homedir is never followed (main still served)', () => {
    const r = runChild(tempHome, 'detail', 'session_evil-sub-8');
    assert(r.ok, `detail threw: ${r.err}`);
    const blob = JSON.stringify(r.ok.messages);
    assert(!blob.includes(CANARY), 'canary leaked through malicious subagent homedir');
    assert(r.ok.messages.length === 1 && r.ok.messages[0].text === 'honest prompt', 'main wire must still be served');
    assert(r.ok.messages.every((m) => m.sidechain === false), 'no sidechain messages may appear');
    return true;
  });
} finally {
  fs.rmSync(tempHome, { recursive: true, force: true });
}

// Agents registry: the real local install is probed (read-only version check).
await acheck('agents: Kimi registry entry resolves against the real install', async () => {
  const { getAgents } = await import('../server/agents.js');
  const agents = await getAgents();
  const k = agents.find((a) => a.id === 'kimi');
  assert(k, 'no kimi entry in getAgents()');
  assert(k.label === 'Kimi Code', `label: ${k.label}`);
  assert(k.installed === true, 'kimi binary must resolve on this machine');
  assert(k.version === '0.28.1', `version: ${k.version}`);
  assert(k.configDir === '~/.kimi-code' && k.configDirExists === true, 'configDir');
  assert(k.configFile === '~/.kimi-code/config.toml' && k.configFileExists === true, 'configFile');
  assert(k.runCommand === 'kimi', `runCommand: ${k.runCommand}`);
  assert(k.updateCommand === 'kimi upgrade', `updateCommand: ${k.updateCommand}`);
});

// ---- real-data sanity --------------------------------------------------------

console.log('\n--- real ~/.kimi-code list() sanity ---');
const real = await import(ADAPTER_URL);
const realEntries = await real.list();
console.log(`count: ${realEntries.length}`);
if (realEntries.length) {
  const richest = realEntries.reduce((a, b) => ((b.messageCount || 0) > (a.messageCount || 0) ? b : a));
  console.log(JSON.stringify(richest, null, 2));
} else {
  console.log('(no sessions found)');
}

console.log(`\nPASS ${pass} FAIL ${fails.length}`);
for (const f of fails) console.log(`  FAIL: ${f}`);
process.exit(fails.length ? 1 : 0);
