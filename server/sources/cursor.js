// Cursor CLI agent: ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<id>/<id>.jsonl
// Lines are { role, message: { content: [...] } } using Anthropic-style blocks.
// No cwd/timestamp is stored inline, so cwd is decoded from the project dir
// name and recency comes from the file mtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, flattenAnthropic, isInside } from './_shared.js';

const ROOT = path.join(os.homedir(), '.cursor', 'projects');
export const source = 'cursor';

// "Users-jane-code-my-app" -> "/Users/jane/code/my-app".
// Best-effort: dashes inside a path segment can't be told from separators.
function decodeProject(name) {
  if (/^\d+$/.test(name) || name === 'empty-window' || name.startsWith('var-folders')) return null;
  return '/' + name.replace(/-/g, '/');
}

function cleanQuery(text) {
  const m = /^\s*<user_query>\n?([\s\S]*?)\n?<\/user_query>\s*$/.exec(text || '');
  return (m ? m[1] : text || '').trim();
}

async function readSession(file, { wantMessages = false, lastN = 30 } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let firstUserText = '', userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;
  for await (const line of rl) {
    const t = line.trim(); if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const content = o.message && o.message.content;
    const text = flattenAnthropic(content);
    if (o.role === 'user') {
      userCount++;
      if (!firstUserText) { const c = cleanQuery(text); if (c) firstUserText = c; }
      if (messages) messages.push({ role: 'user', text: cleanQuery(text) });
    } else if (o.role === 'assistant') {
      assistantCount++;
      if (messages) messages.push({ role: 'assistant', text });
    }
  }
  return {
    summary: { firstUserText, userCount, assistantCount },
    messages: messages ? messages.slice(-lastN) : null,
  };
}

function findTranscripts() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const tdir = path.join(ROOT, proj.name, 'agent-transcripts');
    let sessions = [];
    try { sessions = fs.readdirSync(tdir, { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const file = path.join(tdir, s.name, `${s.name}.jsonl`);
      if (fs.existsSync(file)) out.push({ file, id: s.name, project: proj.name });
    }
  }
  return out;
}

const cache = new Map();

export async function list() {
  const out = [];
  for (const { file, id, project } of findTranscripts()) {
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
    const cwd = decodeProject(project);
    out.push(makeEntry({
      source, id, ref: file,
      title: summary.firstUserText ? summary.firstUserText.slice(0, 80) : null,
      cwd, gitBranch: null,
      userCount: summary.userCount, assistantCount: summary.assistantCount,
      lastActivity: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs,
      firstUserText: summary.firstUserText,
      resume: `${cdPrefix(cwd)}cursor-agent --resume ${id}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  const { summary, messages } = await readSession(resolved, { wantMessages: true, lastN });
  const id = path.basename(resolved).replace(/\.jsonl$/, '');
  const project = path.basename(path.dirname(path.dirname(path.dirname(resolved))));
  const cwd = decodeProject(project);
  return {
    source, id, title: (summary.firstUserText || '(untitled)').slice(0, 80),
    projectPath: cwd || '', gitBranch: null,
    resume: `${cdPrefix(cwd)}cursor-agent --resume ${id}`,
    messages: messages || [],
  };
}
