// Grok CLI: ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/
//   summary.json      -> list metadata (title, cwd, branch, counts)
//   chat_history.jsonl -> the transcript ({ type, content, reasoning, tool_calls })
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';

const ROOT = path.join(os.homedir(), '.grok', 'sessions');
export const source = 'grok';

// Find every <enc-cwd>/<sessionId> dir that holds a summary.json.
function findSessionDirs() {
  const dirs = [];
  let top = [];
  try { top = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return dirs; }
  for (const enc of top) {
    if (!enc.isDirectory()) continue;
    const encPath = path.join(ROOT, enc.name);
    let subs = [];
    try { subs = fs.readdirSync(encPath, { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const dir = path.join(encPath, s.name);
      if (fs.existsSync(path.join(dir, 'summary.json'))) dirs.push({ dir, id: s.name });
    }
  }
  return dirs;
}

function extractContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use' || b.type === 'tool_call') {
      parts.push(toolUseLine(b.name || (b.function && b.function.name), b.input || b.arguments || (b.function && b.function.arguments)));
    } else if (b.type === 'image' || b.type === 'image_url') parts.push('🖼️ [image]');
  }
  return parts.join('\n').trim();
}

function readChat(dir, lastN) {
  const file = path.join(dir, 'chat_history.jsonl');
  let data; try { data = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const messages = [];
  for (const line of data.split('\n')) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'system') continue;
    if (o.type === 'user') {
      messages.push({ role: 'user', text: extractContent(o.content) });
    } else if (o.type === 'assistant') {
      const segs = [];
      if (o.reasoning && o.reasoning.text) segs.push(thinkingLine(o.reasoning.text));
      const body = extractContent(o.content);
      if (body) segs.push(body);
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          segs.push(toolUseLine(tc.name || (tc.function && tc.function.name), tc.arguments || (tc.function && tc.function.arguments)));
        }
      }
      messages.push({ role: 'assistant', text: segs.join('\n').trim() });
    } else if (o.type === 'tool_result' || o.type === 'tool') {
      messages.push({ role: 'tool', text: toolResultLine(o.content) });
    }
  }
  return lastN ? messages.slice(-lastN) : messages;
}

const cache = new Map(); // dir -> { mtimeMs, summary }

function loadSummary(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf-8'));
  const info = raw.info || {};
  return {
    id: info.id || null,
    cwd: info.cwd || null,
    title: raw.generated_title || raw.session_summary || null,
    gitBranch: raw.head_branch || null,
    model: raw.current_model_id || null,
    count: raw.num_chat_messages || raw.num_messages || 0,
    firstActivity: raw.created_at || null,
    lastActivity: raw.last_active_at || raw.updated_at || raw.created_at || null,
  };
}

export async function list() {
  const out = [];
  for (const { dir, id: dirId } of findSessionDirs()) {
    const summaryPath = path.join(dir, 'summary.json');
    let stat; try { stat = fs.statSync(summaryPath); } catch { continue; }
    let s;
    const hit = cache.get(dir);
    if (hit && hit.mtimeMs === stat.mtimeMs) s = hit.summary;
    else {
      try { s = loadSummary(dir); } catch { continue; }
      cache.set(dir, { mtimeMs: stat.mtimeMs, summary: s });
    }
    if (!s.count) continue;
    const id = s.id || dirId;
    const cwd = s.cwd || decodeURIComponent(path.basename(path.dirname(dir)));
    out.push(makeEntry({
      source, id, ref: dir,
      title: s.title, cwd, gitBranch: s.gitBranch,
      messageCount: s.count,
      firstActivity: s.firstActivity,
      lastActivity: s.lastActivity || stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
      resume: `${cdPrefix(cwd)}grok --resume ${id}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  let s; try { s = loadSummary(resolved); } catch { s = { id: path.basename(resolved), cwd: '', title: null, gitBranch: null }; }
  const cwd = s.cwd || decodeURIComponent(path.basename(path.dirname(resolved)));
  const id = s.id || path.basename(resolved);
  return {
    source, id, title: s.title || '(untitled)', projectPath: cwd, gitBranch: s.gitBranch,
    resume: `${cdPrefix(cwd)}grok --resume ${id}`,
    messages: readChat(resolved, lastN),
  };
}
