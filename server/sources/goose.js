// Goose (Block): JSONL session logs under ~/.local/share/goose/sessions/*.jsonl
// (also ~/.config/goose/sessions). A leading metadata line may carry the
// description + working_dir; remaining lines are messages with role + content.
//
// NOTE: format-based adapter (Goose not installed here). Returns [] when absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEntry, cdPrefix, flattenText, isInside } from './_shared.js';

const ROOTS = [
  path.join(os.homedir(), '.local', 'share', 'goose', 'sessions'),
  path.join(os.homedir(), '.config', 'goose', 'sessions'),
];
export const source = 'goose';

function files() {
  const out = [];
  for (const root of ROOTS) {
    let ents; try { ents = fs.readdirSync(root); } catch { continue; }
    for (const f of ents) if (f.endsWith('.jsonl')) out.push(path.join(root, f));
  }
  return out;
}

function read(file, { wantMessages = false, lastN = 30 } = {}) {
  let data; try { data = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  let description = null, cwd = null, firstUserText = '', userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;
  for (const line of data.split('\n')) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (!o.role) { // metadata line
      description = description || o.description || o.title || null;
      cwd = cwd || o.working_dir || o.workingDir || o.cwd || null;
      continue;
    }
    const role = o.role === 'assistant' || o.role === 'model' ? 'assistant' : o.role === 'user' ? 'user' : null;
    if (!role) continue;
    const text = flattenText(o.content ?? o.text);
    if (role === 'user') { userCount++; if (!firstUserText && text) firstUserText = text; }
    else assistantCount++;
    if (messages) messages.push({ role, text });
  }
  return { description, cwd, firstUserText, userCount, assistantCount, messages: messages ? messages.slice(-lastN) : null };
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
    const name = path.basename(file).replace(/\.jsonl$/, '');
    out.push(makeEntry({
      source, id: name, ref: file,
      title: s.description || (s.firstUserText ? s.firstUserText.slice(0, 80) : null),
      cwd: s.cwd, gitBranch: null,
      userCount: s.userCount, assistantCount: s.assistantCount,
      lastActivity: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs,
      firstUserText: s.firstUserText,
      resume: `${cdPrefix(s.cwd)}goose session resume --name ${name}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!ROOTS.some((r) => isInside(resolved, r))) throw new Error('forbidden');
  const s = read(resolved, { wantMessages: true, lastN });
  if (!s) throw new Error('forbidden');
  const name = path.basename(resolved).replace(/\.jsonl$/, '');
  return {
    source, id: name, title: (s.description || s.firstUserText || '(untitled)').slice(0, 80),
    projectPath: s.cwd || '', gitBranch: null,
    resume: `${cdPrefix(s.cwd)}goose session resume --name ${name}`,
    messages: s.messages || [],
  };
}
