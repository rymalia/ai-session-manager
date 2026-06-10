// Droid (Factory.ai): per-session JSON under ~/.factory/sessions/*.json
// (one file per session: { id, cwd, title, updated_at, messages:[{role,content}] }).
//
// NOTE: format-based adapter (Droid not installed here). Returns [] when absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEntry, cdPrefix, flattenText, isInside } from './_shared.js';

const ROOTS = [
  path.join(os.homedir(), '.factory', 'sessions'),
  path.join(os.homedir(), '.droid', 'sessions'),
];
export const source = 'droid';

function files() {
  const out = [];
  for (const root of ROOTS) {
    let ents; try { ents = fs.readdirSync(root); } catch { continue; }
    for (const f of ents) if (f.endsWith('.json')) out.push(path.join(root, f));
  }
  return out;
}

function read(file, { wantMessages = false, lastN = 30 } = {}) {
  let o; try { o = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
  const msgs = Array.isArray(o) ? o : (o.messages || o.history || []);
  const id = o.id || o.sessionId || path.basename(file).replace(/\.json$/, '');
  const cwd = o.cwd || o.workingDirectory || o.directory || null;
  const ts = o.updated_at || o.updatedAt || o.timestamp || null;
  const title = o.title || o.name || null;
  let firstUserText = '', userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' || m.role === 'model' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text = flattenText(m.content ?? m.text);
    if (role === 'user') { userCount++; if (!firstUserText && text) firstUserText = text; }
    else assistantCount++;
    if (messages) messages.push({ role, text });
  }
  return { id, cwd, ts, title, firstUserText, userCount, assistantCount, messages: messages ? messages.slice(-lastN) : null };
}

const cache = new Map();

export async function list() {
  const out = [];
  for (const file of files()) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    let s;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) s = hit.summary;
    else { s = read(file); if (!s) continue; cache.set(file, { mtimeMs: stat.mtimeMs, summary: s }); }
    if (s.userCount === 0 && s.assistantCount === 0) continue;
    out.push(makeEntry({
      source, id: s.id, ref: file,
      title: s.title || (s.firstUserText ? s.firstUserText.slice(0, 80) : null),
      cwd: s.cwd, gitBranch: null,
      userCount: s.userCount, assistantCount: s.assistantCount,
      lastActivity: s.ts || stat.mtime.toISOString(), mtimeMs: stat.mtimeMs,
      firstUserText: s.firstUserText,
      resume: `${cdPrefix(s.cwd)}droid --resume ${s.id}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!ROOTS.some((r) => isInside(resolved, r))) throw new Error('forbidden');
  const s = read(resolved, { wantMessages: true, lastN });
  if (!s) throw new Error('forbidden');
  return {
    source, id: s.id, title: (s.title || s.firstUserText || '(untitled)').slice(0, 80),
    projectPath: s.cwd || '', gitBranch: null,
    resume: `${cdPrefix(s.cwd)}droid --resume ${s.id}`,
    messages: s.messages || [],
  };
}
