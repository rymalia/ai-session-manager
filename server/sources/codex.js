// OpenAI Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// Each line is { timestamp, type, payload }. Titles come from session_index.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';
import { finalizeContextUsage } from '../contextUsage.js';

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
  // Context health: model comes from session_meta / turn_context (latest wins);
  // used/window come from the LAST token_count event (last_token_usage is the
  // most recent request's real footprint — the resume-relevant number).
  let ctxModel = null, ctxUsed = null, ctxWindow = null, ctxTs = null;
  const messages = wantMessages ? [] : null;

  for await (const line of rl) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.timestamp) lastTs = o.timestamp;
    const p = o.payload || {};

    if (o.type === 'session_meta') {
      if (p.id) id = p.id;
      if (p.cwd) cwd = p.cwd;
      if (p.model) ctxModel = p.model;
      const g = p.git || p.git_info;
      if (g && (g.branch || g.current_branch)) gitBranch = g.branch || g.current_branch;
      continue;
    }
    if (o.type === 'turn_context') { if (p.model) ctxModel = p.model; continue; }
    if (o.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const last = p.info.last_token_usage;
      if (last && Number.isFinite(last.total_tokens)) {
        ctxUsed = last.total_tokens;
        ctxWindow = Number.isFinite(p.info.model_context_window) ? p.info.model_context_window : null;
        ctxTs = o.timestamp || lastTs;
      }
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
  const contextUsage = ctxUsed != null
    ? finalizeContextUsage({
        usedTokens: ctxUsed, windowTokens: ctxWindow, model: ctxModel,
        measuredAt: ctxTs, basis: 'reported', windowBasis: 'recorded', compactions: 0,
      })
    : null;
  return {
    summary: { id, cwd, gitBranch, lastTs, firstUserText, userCount, assistantCount, contextUsage },
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
      contextUsage: summary.contextUsage,
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
