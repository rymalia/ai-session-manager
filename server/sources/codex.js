// OpenAI Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Each line is { timestamp, type, payload }. Titles come from session_index.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';

const HOME = os.homedir();
const ROOT = path.join(HOME, '.codex', 'sessions');
const INDEX = path.join(HOME, '.codex', 'session_index.jsonl');
export const source = 'codex';

function walkRollouts(dir, acc) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, acc);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) acc.push(p);
  }
}

// id -> thread_name, parsed from the lightweight session index (last wins).
function loadTitles() {
  const map = new Map();
  let data; try { data = fs.readFileSync(INDEX, 'utf-8'); } catch { return map; }
  for (const line of data.split('\n')) {
    const t = line.trim(); if (!t) continue;
    try { const o = JSON.parse(t); if (o.id && o.thread_name) map.set(o.id, o.thread_name); } catch {}
  }
  return map;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'input_image' || b.type === 'image') parts.push('🖼️ [image]');
  }
  return parts.join('\n').trim();
}

function reasoningText(payload) {
  const arr = payload.summary || payload.content;
  if (Array.isArray(arr)) return arr.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n').trim();
  return typeof payload.text === 'string' ? payload.text : '';
}

async function readSession(file, { wantMessages = false, lastN = 30 } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let id = null, cwd = null, gitBranch = null, lastTs = null, firstUserText = '';
  let userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;

  for await (const line of rl) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.timestamp) lastTs = o.timestamp;
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      if (p.id) id = p.id;
      if (p.cwd) cwd = p.cwd;
      const g = p.git || p.git_info;
      if (g && (g.branch || g.current_branch)) gitBranch = g.branch || g.current_branch;
      continue;
    }
    if (o.type !== 'response_item') continue;

    if (p.type === 'message') {
      const role = p.role;
      const text = textFromContent(p.content);
      if (role === 'user') {
        // Codex prepends scaffolding user messages (environment context, user
        // instructions) before the real prompt — skip them for title/count.
        const head = text.trimStart();
        if (head.startsWith('<environment_context') || head.startsWith('<user_instructions')) continue;
        userCount++;
        if (!firstUserText && text) firstUserText = text;
        if (messages) messages.push({ role: 'user', text, ts: o.timestamp || null });
      } else if (role === 'assistant') {
        assistantCount++;
        if (messages) messages.push({ role: 'assistant', text, ts: o.timestamp || null });
      }
      // developer / system messages are instruction scaffolding: skip.
    } else if (messages && p.type === 'reasoning') {
      const r = reasoningText(p);
      if (r) messages.push({ role: 'assistant', text: thinkingLine(r), ts: o.timestamp || null });
    } else if (messages && p.type === 'function_call') {
      messages.push({ role: 'assistant', text: toolUseLine(p.name, p.arguments), ts: o.timestamp || null });
    } else if (messages && (p.type === 'function_call_output' || p.type === 'local_shell_call_output')) {
      let out = p.output;
      if (out && typeof out === 'object') out = out.content ?? out.output ?? JSON.stringify(out);
      messages.push({ role: 'tool', text: toolResultLine(out), ts: o.timestamp || null });
    }
  }
  return {
    summary: { id, cwd, gitBranch, lastTs, firstUserText, userCount, assistantCount },
    messages: messages ? messages.slice(-lastN) : null,
  };
}

const cache = new Map(); // file -> { mtimeMs, summary }

export async function list() {
  const files = [];
  walkRollouts(ROOT, files);
  if (files.length === 0) return [];
  const titles = loadTitles();
  const out = [];
  for (const file of files) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    let summary;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) summary = hit.summary;
    else {
      try { ({ summary } = await readSession(file)); } catch { continue; }
      cache.set(file, { mtimeMs: stat.mtimeMs, summary });
    }
    if (summary.userCount === 0 && summary.assistantCount === 0) continue;
    const id = summary.id || path.basename(file).replace(/\.jsonl$/, '');
    const cwd = summary.cwd || '';
    out.push(makeEntry({
      source, id, ref: file,
      title: titles.get(id), cwd, gitBranch: summary.gitBranch,
      userCount: summary.userCount, assistantCount: summary.assistantCount,
      lastActivity: summary.lastTs || stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs, firstUserText: summary.firstUserText,
      resume: `${cdPrefix(cwd)}codex resume ${id}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  const { summary, messages } = await readSession(resolved, { wantMessages: true, lastN });
  const id = summary.id || path.basename(resolved).replace(/\.jsonl$/, '');
  const titles = loadTitles();
  const cwd = summary.cwd || '';
  return {
    source, id, title: titles.get(id) || (summary.firstUserText || '').slice(0, 80),
    projectPath: cwd, gitBranch: summary.gitBranch,
    resume: `${cdPrefix(cwd)}codex resume ${id}`,
    messages: messages || [],
  };
}

// ---------------------------------------------------------------------------
// Full-fidelity export: convert a Codex rollout into the shared normalized-event
// contract the renderer (server/export.js) consumes. Direct port of
// extract-session.py's load_codex_events + _codex_tool_input + _codex_output_text
// (session-tools v1.7.0). Conversion is flag-independent — EVERYTHING is emitted;
// the renderer filters. This reproduces `/replay <id> --full` byte-for-byte.
// ---------------------------------------------------------------------------

// Normalize a Codex tool-call payload into a Claude-style `input` object so
// summarizeToolUse() renders a one-liner (mirrors _codex_tool_input).
function codexToolInput(payload) {
  if (payload.type === 'function_call') {
    const raw = payload.arguments;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { arguments: raw };
      } catch { return { arguments: raw }; }
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  // custom_tool_call: `input` is usually a raw string (often a code snippet).
  const inp = payload.input;
  if (inp && typeof inp === 'object' && !Array.isArray(inp)) return inp;
  return { input: typeof inp === 'string' ? inp : '' };
}

// Flatten a Codex tool-call output (string | list of {type,text}) to text.
function codexOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      if (item && typeof item === 'object') parts.push(item.text || '');
      else if (typeof item === 'string') parts.push(item);
    }
    return parts.filter(Boolean).join('\n');
  }
  return '';
}

// `opts` accepted for registry-signature parity but intentionally unused — like
// load_codex_events(), conversion keeps every event; filtering is render-time.
export async function collectEvents(ref, _opts = {}) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');

  const rl = readline.createInterface({
    input: fs.createReadStream(resolved, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const events = [];
  const meta = {
    source, isCodex: true, mainPath: resolved,
    sessionId: null, cwd: null, model: null, cliVersion: null,
    historyOn: false, // no ~/.claude/history.jsonl equivalent for Codex
  };
  const emit = (role, ts, blocks) =>
    events.push({ role, ts: ts || '', source: 'main', sidechain: false, meta: false, blocks });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const ts = o.timestamp || '';
    const etype = o.type;
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;

    if (etype === 'session_meta') {
      if (meta.sessionId == null) meta.sessionId = p.session_id || p.id || null;
      if (meta.cwd == null) meta.cwd = p.cwd || null;
      if (meta.model == null) meta.model = p.model || p.model_provider || null;
      if (meta.cliVersion == null) meta.cliVersion = p.cli_version || null;
      continue;
    }

    if (etype === 'event_msg') {
      // The clean, user-typed prompt. Other event_msg subtypes duplicate
      // response_items or are bookkeeping — skip.
      if (p.type === 'user_message') {
        let text = p.message || '';
        const imgs = p.images || p.local_images || [];
        if (imgs.length) {
          const note = `[${imgs.length} image(s) attached]`;
          text = text.trim() ? `${text}\n\n${note}` : note;
        }
        if (text.trim()) emit('user', ts, [{ kind: 'text', text }]);
      }
      continue;
    }

    if (etype === 'response_item') {
      const pt = p.type;
      if (pt === 'message') {
        if (p.role !== 'assistant') continue; // user/developer = injected context / system
        const text = (Array.isArray(p.content) ? p.content : [])
          .filter((b) => b && typeof b === 'object')
          .map((b) => b.text || '').join('');
        if (text.trim()) emit('assistant', ts, [{ kind: 'text', text }]);
      } else if (pt === 'function_call' || pt === 'custom_tool_call') {
        emit('assistant', ts, [{ kind: 'tool_use', name: p.name || '?', input: codexToolInput(p) }]);
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        const text = codexOutputText(p.output);
        if (text.trim()) emit('user', ts, [{ kind: 'tool_result', text }]);
      } else if (pt === 'reasoning') {
        const summary = Array.isArray(p.summary) ? p.summary : [];
        const text = summary.filter((s) => s && typeof s === 'object')
          .map((s) => s.text || '').join('\n').trim();
        emit('assistant', ts, [{ kind: 'reasoning', text }]); // '' → renderer prints "[encrypted by Codex]"
      }
      continue;
    }
    // turn_context / compacted / token_count / task_* : bookkeeping — dropped.
  }

  if (!meta.sessionId) meta.sessionId = path.basename(resolved).replace(/\.jsonl$/, '');
  // extract-session.py sorts all events by ISO timestamp; Array.sort is stable
  // (Node 12+) so equal-ts events keep emission order, matching Python.
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { meta, events };
}
