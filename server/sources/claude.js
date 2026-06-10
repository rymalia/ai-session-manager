// Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Every line is one record (user / assistant / meta).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, clip, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
export const source = 'claude';

function decodeProjectDir(name) {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

// Collapse an Anthropic-style content array into one readable string.
function flatten(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text': parts.push(block.text || ''); break;
      case 'thinking':
        if (block.thinking && block.thinking.trim()) parts.push(thinkingLine(block.thinking));
        break;
      case 'tool_use': parts.push(toolUseLine(block.name, block.input)); break;
      case 'tool_result': {
        let c = block.content;
        if (Array.isArray(c)) c = c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
        parts.push(toolResultLine(c));
        break;
      }
      case 'image': parts.push('🖼️ [image]'); break;
      default: break;
    }
  }
  return parts.join('\n').trim();
}

function classifyUser(content) {
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) return 'tool';
  return 'user';
}

async function readSession(file, { wantMessages = false, lastN = 30 } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let title = null, firstUserText = '', cwd = null, gitBranch = null, lastTs = null;
  let userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; }
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (o.timestamp) lastTs = o.timestamp;

    if (o.type === 'user' && o.message) {
      const role = classifyUser(o.message.content);
      const text = flatten(o.message.content);
      if (role === 'user') { userCount++; if (!firstUserText && text) firstUserText = text; }
      if (messages) messages.push({ role, text, ts: o.timestamp || null });
    } else if (o.type === 'assistant' && o.message) {
      assistantCount++;
      const text = flatten(o.message.content);
      if (messages) messages.push({ role: 'assistant', text, ts: o.timestamp || null, model: o.message.model });
    }
  }
  return {
    summary: { title, firstUserText, cwd, gitBranch, lastTs, userCount, assistantCount },
    messages: messages ? messages.slice(-lastN) : null,
  };
}

const cache = new Map(); // file -> { mtimeMs, summary }

export async function list() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }

  const out = [];
  for (const dir of dirs) {
    const dirPath = path.join(ROOT, dir);
    let files = [];
    try { files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dirPath, f);
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
      const id = f.replace(/\.jsonl$/, '');
      const cwd = summary.cwd || decodeProjectDir(dir);
      out.push(makeEntry({
        source, id, ref: file,
        title: summary.title, cwd, gitBranch: summary.gitBranch,
        userCount: summary.userCount, assistantCount: summary.assistantCount,
        lastActivity: summary.lastTs || stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs, firstUserText: summary.firstUserText,
        resume: `${cdPrefix(cwd)}claude --resume ${id}`,
      }));
    }
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  const { summary, messages } = await readSession(resolved, { wantMessages: true, lastN });
  const id = path.basename(resolved).replace(/\.jsonl$/, '');
  const cwd = summary.cwd || '';
  return {
    source, id, title: summary.title, projectPath: cwd, gitBranch: summary.gitBranch,
    resume: `${cdPrefix(cwd)}claude --resume ${id}`,
    messages: messages || [],
  };
}
