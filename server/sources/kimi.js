// Kimi Code CLI: ~/.kimi-code/session_index.jsonl maps sessionId → sessionDir;
// each sessionDir holds state.json ({ title, workDir, agents: {key: {homedir}} })
// and every agent homedir holds a wire.jsonl EVENT STREAM (turn.prompt /
// context.append_message / context.append_loop_event / llm.request / usage.record),
// not an Anthropic-style message log. See docs/kimi-k1-implementation-notes-2026-07-27.md.
//
// K1 scope: list + detail only. No collectEvents / exportCapabilities — Kimi stays
// correctly non-exportable through the source-capability mechanism until the K2 ADR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';

const HOME = os.homedir();
const ROOT = path.join(HOME, '.kimi-code');
const INDEX = path.join(ROOT, 'session_index.jsonl');
export const source = 'kimi';

// Containment here has to survive SYMLINKS, not just lexical prefixes. Every
// path this adapter opens comes from locally stored metadata (the index's
// `sessionDir`, state.json's `agents[*].homedir`) rather than from the caller,
// and `path.resolve()` does not dereference links — so a symlink planted inside
// ~/.kimi-code that points outside it passes an `isInside()` check while reading
// an external file. Verified: lexical isInside() returns true for exactly that
// shape. Hence realpath-then-check below.
//
// NOTE: the other file-based adapters in this repo use the lexical check alone.
// Hardening them is a separate, deliberate change — see NEXT-STEPS.md.
export const REAL_ROOT = (() => {
  try { return fs.realpathSync(ROOT); } catch { return ROOT; }
})();

// → the symlink-free path when it exists and is genuinely inside `parent`;
// null when it escapes. A path that does not exist yet is NOT an escape: it
// returns the lexical resolution so callers keep their existing missing-file
// semantics (not_found) instead of reporting a containment failure.
export function contained(p, parent) {
  const resolved = path.resolve(p);
  let real;
  try { real = fs.realpathSync(resolved); } catch { return isInside(resolved, parent) ? resolved : null; }
  return isInside(real, parent) ? real : null;
}

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function notFound() {
  const e = new Error('not found');
  e.code = 'not_found';
  return e;
}

// ---- session index -----------------------------------------------------------

// sessionId -> { sessionDir, workDir }, parsed from the append-only index.
// Malformed lines are skipped; duplicate ids resolve last-record-wins.
const indexCache = { sig: null, map: new Map() };

function loadIndex() {
  const stat = statOrNull(INDEX);
  const sig = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
  if (indexCache.sig === sig) return indexCache.map;
  const map = new Map();
  if (stat) {
    let data;
    try { data = fs.readFileSync(INDEX, 'utf-8'); } catch { data = null; }
    if (data) {
      for (const line of data.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let o;
        try { o = JSON.parse(t); } catch { continue; }
        if (o && typeof o.sessionId === 'string' && o.sessionId
          && typeof o.sessionDir === 'string' && o.sessionDir) {
          map.set(o.sessionId, {
            sessionDir: o.sessionDir,
            workDir: typeof o.workDir === 'string' ? o.workDir : '',
          });
        }
      }
    }
  }
  indexCache.sig = sig;
  indexCache.map = map;
  return map;
}

// ---- session resolution (containment enforced on STORED metadata) ------------

// Resolve state.json + every agent wire for a session directory.
// Returns { forbidden: true } when the index-provided sessionDir escapes ROOT,
// null when state.json is unreadable/unparseable, otherwise
// { state, stateStat, wires, invalidKeys, resolvedDir }. An agent whose stored
// homedir escapes the session dir or the Kimi root is NEVER followed — it lands
// in invalidKeys and its wire is not opened.
function resolveSession(sessionDir) {
  const resolvedDir = contained(sessionDir, REAL_ROOT);
  if (!resolvedDir) return { forbidden: true };
  // state.json is re-checked in its own right: the directory can be legitimate
  // while the file inside it is a symlink out.
  const statePath = contained(path.join(resolvedDir, 'state.json'), resolvedDir);
  if (!statePath) return { forbidden: true };
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { return null; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const agents = state.agents && typeof state.agents === 'object' ? state.agents : {};
  const wires = [];
  const invalidKeys = [];
  for (const key of Object.keys(agents)) {
    const a = agents[key];
    const homedir = a && typeof a.homedir === 'string' ? a.homedir : null;
    if (!homedir) { invalidKeys.push(key); continue; }
    // Both boundaries, symlink-aware: inside the session dir AND inside the root.
    const resolvedHome = contained(homedir, resolvedDir);
    if (!resolvedHome || !contained(resolvedHome, REAL_ROOT)) {
      invalidKeys.push(key);
      continue;
    }
    // The wire itself is checked too — a legitimate homedir can still contain a
    // symlinked wire.jsonl pointing anywhere on disk.
    const file = contained(path.join(resolvedHome, 'wire.jsonl'), resolvedHome);
    if (!file) { invalidKeys.push(key); continue; }
    const stat = statOrNull(file);
    if (stat && stat.isFile()) wires.push({ key, file, stat });
  }
  // main first, then subagents in lexical key order — this order drives both
  // the merge tie-break rank and a stable composite signature.
  wires.sort((a, b) => (
    a.key === 'main' ? -1 : b.key === 'main' ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  ));
  return { state, stateStat: statOrNull(statePath), wires, invalidKeys, resolvedDir };
}

// Composite invalidation signature covering state.json AND every included wire,
// so a subagent-only append invalidates search (which reads detail()).
function buildSignature(stateStat, wires) {
  const parts = [];
  if (stateStat) parts.push(`state.json@${stateStat.mtimeMs}:${stateStat.size}`);
  for (const w of wires) parts.push(`${w.key}/wire.jsonl@${w.stat.mtimeMs}:${w.stat.size}`);
  return parts.sort().join('|');
}

// ---- wire parsing ------------------------------------------------------------

// Wire `time` is epoch milliseconds; tolerate ISO strings too.
// Out-of-range values are rejected here rather than at format time: `new
// Date(1e100).toISOString()` throws RangeError, and a single such record in an
// otherwise-good wire would drop the whole card from list() (swallowed by the
// failure-isolation catch) and make detail() throw. 8.64e15 is the ECMAScript
// time-value limit — the same guard claude.js applies to history timestamps.
const MAX_TIME = 8.64e15;
function tsMs(t) {
  if (Number.isFinite(t)) return Math.abs(t) > MAX_TIME ? null : t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME ? ms : null;
  }
  return null;
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Parse one agent wire. Canonical human turns come ONLY from turn.prompt with
// origin.kind === 'user' — context.append_message carries injected reminders,
// skill bodies and duplicated prompts, so it is never a user-turn source.
// Assistant text/thinking/tool calls group per step (step.begin..step.end)
// into ONE assistant message; tool results stay separate tool-role messages
// in wire order. Model/effort is the LAST llm.request pair: a later request
// with a model but no thinkingEffort clears the earlier effort.
async function readWire(file, { wantMessages = false } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let firstConvMs = null; // earliest timestamp of a message-producing record
  let lastMs = null;      // newest timestamp of ANY record
  let firstUserText = '';
  let firstUserMs = null;
  let userCount = 0;
  let assistantCount = 0; // grouped steps only — tool rows do not count
  const modelPair = { model: null, effort: null };
  const messages = wantMessages ? [] : null;
  let order = 0;
  let cur = null; // open assistant-step buffer

  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join('\n').trim();
    if (text) {
      assistantCount++;
      if (messages) messages.push({ role: 'assistant', text, tsMs: cur.tsMs, order: cur.order });
    }
    if (messages) for (const r of cur.results) messages.push(r);
    cur = null;
  };
  const openStep = (ms) => {
    if (!cur) cur = { tsMs: ms, order: order++, parts: [], results: [] };
  };

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; } // malformed wire line: skip
    const ms = tsMs(o.time);
    if (ms != null && (lastMs == null || ms > lastMs)) lastMs = ms;
    const conversational = () => {
      if (ms != null && (firstConvMs == null || ms < firstConvMs)) firstConvMs = ms;
    };

    if (o.type === 'turn.prompt') {
      if (o.origin && o.origin.kind === 'user') {
        const text = (Array.isArray(o.input) ? o.input : [])
          .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean).join('\n').trim();
        if (text) {
          conversational();
          userCount++;
          if (!firstUserText) { firstUserText = text; firstUserMs = ms; }
          if (messages) messages.push({ role: 'user', text, tsMs: ms, order: order++ });
        }
      }
      continue;
    }

    if (o.type === 'llm.request') {
      // Treat model + effort as ONE pair (B2 contract): a later request with a
      // model but no thinkingEffort clears an earlier effort.
      if ('model' in o) {
        modelPair.model = o.model ?? null;
        modelPair.effort = o.thinkingEffort ?? null;
      }
      continue;
    }

    if (o.type !== 'context.append_loop_event') continue;
    const ev = o.event;
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'step.begin') {
      flush();
      cur = { tsMs: ms, order: order++, parts: [], results: [] };
    } else if (ev.type === 'step.end') {
      flush();
    } else if (ev.type === 'content.part') {
      const part = ev.part || {};
      let lineText = null;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        lineText = part.text;
      } else if (part.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
        lineText = thinkingLine(part.think);
      }
      if (lineText) {
        conversational();
        openStep(ms);
        cur.parts.push(lineText);
      }
    } else if (ev.type === 'tool.call') {
      conversational();
      openStep(ms);
      cur.parts.push(toolUseLine(ev.name, ev.args));
    } else if (ev.type === 'tool.result') {
      conversational();
      const out = ev.result && typeof ev.result === 'object' ? ev.result.output : ev.result;
      const msg = { role: 'tool', text: toolResultLine(out ?? ''), tsMs: ms, order: order++ };
      if (cur) cur.results.push(msg);
      else if (messages) messages.push(msg);
    }
  }
  flush();
  return {
    summary: { firstConvMs, lastMs, firstUserText, firstUserMs, userCount, assistantCount, modelPair },
    messages,
  };
}

const wireCache = new Map(); // file -> { sig, summary }

async function summarizeWire(file, stat) {
  const sig = `${stat.mtimeMs}:${stat.size}`;
  const hit = wireCache.get(file);
  if (hit && hit.sig === sig) return hit.summary;
  const { summary } = await readWire(file);
  wireCache.set(file, { sig, summary });
  return summary;
}

// ---- list --------------------------------------------------------------------

const entryCache = new Map(); // sessionId -> { sig, entry }

export async function list() {
  const index = loadIndex();
  const out = [];
  for (const [sessionId, idx] of index) {
    try {
      const sess = resolveSession(idx.sessionDir);
      if (!sess || sess.forbidden || sess.wires.length === 0) continue;
      const sig = buildSignature(sess.stateStat, sess.wires);
      const hit = entryCache.get(sessionId);
      if (hit && hit.sig === sig) { out.push(hit.entry); continue; }

      let userCount = 0, assistantCount = 0;
      let firstConvMs = null, lastMs = null, firstUserText = '', firstUserMs = null;
      const mainModel = { model: null, effort: null };
      let mtimeMs = sess.stateStat ? sess.stateStat.mtimeMs : 0;
      for (const w of sess.wires) {
        const s = await summarizeWire(w.file, w.stat);
        userCount += s.userCount;
        assistantCount += s.assistantCount;
        if (s.firstConvMs != null && (firstConvMs == null || s.firstConvMs < firstConvMs)) firstConvMs = s.firstConvMs;
        if (s.lastMs != null && (lastMs == null || s.lastMs > lastMs)) lastMs = s.lastMs;
        // wires iterate main-first, so strict < keeps main's prompt on ties
        if (s.firstUserText && (firstUserMs == null || (s.firstUserMs != null && s.firstUserMs < firstUserMs))) {
          firstUserText = s.firstUserText;
          firstUserMs = s.firstUserMs;
        }
        // Model + effort come from the last llm.request of the MAIN agent only —
        // a subagent on another model must never relabel the session.
        if (w.key === 'main') { mainModel.model = s.modelPair.model; mainModel.effort = s.modelPair.effort; }
        if (w.stat.mtimeMs > mtimeMs) mtimeMs = w.stat.mtimeMs;
      }
      if (userCount === 0 && assistantCount === 0) continue;

      const state = sess.state;
      const cwd = (typeof state.workDir === 'string' && state.workDir) || idx.workDir || '';
      const entry = makeEntry({
        source, id: sessionId, ref: sessionId,
        title: typeof state.title === 'string' ? state.title : '',
        cwd, gitBranch: null,
        userCount, assistantCount,
        firstActivity: iso(firstConvMs) || (typeof state.createdAt === 'string' ? state.createdAt : null),
        // Wire timestamps win; state.updatedAt is only a fallback — it can
        // trail live wire activity.
        lastActivity: iso(lastMs) || (typeof state.updatedAt === 'string' ? state.updatedAt : null)
          || new Date(mtimeMs).toISOString(),
        mtimeMs, firstUserText,
        resume: `${cdPrefix(cwd)}kimi -S ${sessionId}`,
        cacheSignature: sig,
        model: mainModel.model, effort: mainModel.effort,
      });
      entryCache.set(sessionId, { sig, entry });
      out.push(entry);
    } catch {
      continue; // failure isolation: one bad session never aborts the source
    }
  }
  return out;
}

// ---- detail ------------------------------------------------------------------

// Refs are session ids resolved through the index — NEVER filesystem paths.
// Anything path-shaped fails closed before any index lookup.
function assertIdShapedRef(ref) {
  if (typeof ref !== 'string' || !ref
    || ref.includes('/') || ref.includes('\\') || ref.includes('\0')
    || ref.startsWith('.') || path.isAbsolute(ref)) {
    throw new Error('forbidden');
  }
}

// Visible low-noise sidechain provenance for the expanded preview; roles stay
// exactly user | assistant | tool for the shared UI contract.
const sidechainMark = (key) => `⎇ subagent:${key}`;

export async function detail(ref, lastN = 30) {
  assertIdShapedRef(ref);
  const idx = loadIndex().get(ref);
  if (!idx) throw notFound();
  const sess = resolveSession(idx.sessionDir);
  if (!sess) throw notFound();
  if (sess.forbidden) throw new Error('forbidden');
  // A malicious state-provided homedir on the MAIN agent fails closed; bad
  // subagent homedirs are simply never followed.
  if (sess.invalidKeys.includes('main')) throw new Error('forbidden');

  // Parse every included agent through the same path, then merge by wire
  // timestamp; ties break main-before-subagents, then lexical key (both folded
  // into `rank`), then original record order. lastN applies AFTER the merge.
  const merged = [];
  for (let rank = 0; rank < sess.wires.length; rank++) {
    const w = sess.wires[rank];
    const { messages } = await readWire(w.file, { wantMessages: true });
    for (const m of messages || []) merged.push({ ...m, rank, key: w.key });
  }
  merged.sort((a, b) => (
    (a.tsMs ?? 0) - (b.tsMs ?? 0) || a.rank - b.rank || a.order - b.order
  ));
  const sliced = merged.slice(-lastN);
  const messages = sliced.map((m) => {
    // Keyed off the agent NAME, not the sort rank: rank 0 is only 'main' when a
    // main agent exists, so a main-less session would otherwise promote its
    // first subagent to main and drop the provenance marker.
    const sidechain = m.key !== 'main';
    return {
      role: m.role,
      text: sidechain ? `${sidechainMark(m.key)}\n${m.text}` : m.text,
      ts: iso(m.tsMs),
      source: sidechain ? `subagent:${m.key}` : 'main',
      sidechain,
    };
  });

  const state = sess.state;
  const cwd = (typeof state.workDir === 'string' && state.workDir) || idx.workDir || '';
  let title = typeof state.title === 'string' && state.title ? state.title : null;
  if (!title) {
    const firstUser = merged.find((m) => m.role === 'user');
    title = firstUser ? firstUser.text.slice(0, 80) : null;
  }
  return {
    source, id: ref, title,
    projectPath: cwd, gitBranch: null,
    resume: `${cdPrefix(cwd)}kimi -S ${ref}`,
    messages,
  };
}
