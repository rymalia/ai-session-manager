// Gemini CLI: ~/.gemini/tmp/<projectHash>/checkpoint*.json
// Each saved-chat checkpoint is an array of Gemini Content
// ({ role: 'user'|'model', parts: [{text}|{functionCall}|{functionResponse}] }).
//
// NOTE: format-based adapter written to Gemini CLI's documented checkpoint
// layout; it is defensive and returns [] when ~/.gemini is absent. Saved chats
// are resumed inside gemini via `/chat resume <tag>`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, isInside } from './_shared.js';

const ROOT = path.join(os.homedir(), '.gemini', 'tmp');
export const source = 'gemini';

function flattenParts(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') out.push(p.text);
    else if (p.functionCall) out.push(toolUseLine(p.functionCall.name, p.functionCall.args));
    else if (p.functionResponse) out.push(toolResultLine(p.functionResponse.response ?? p.functionResponse));
    else if (p.inlineData || p.fileData) out.push('🖼️ [media]');
  }
  return out.join('\n').trim();
}

// Read a checkpoint into { messages, userCount, assistantCount, firstUserText }.
function readCheckpoint(file, { wantMessages = false, lastN = 30 } = {}) {
  let arr; try { arr = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { arr = null; }
  const history = Array.isArray(arr) ? arr : Array.isArray(arr && arr.history) ? arr.history : [];
  let userCount = 0, assistantCount = 0, firstUserText = '';
  const messages = wantMessages ? [] : null;
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue;
    const text = flattenParts(turn.parts);
    if (turn.role === 'user') {
      userCount++;
      if (!firstUserText && text) firstUserText = text;
      if (messages) messages.push({ role: 'user', text });
    } else if (turn.role === 'model' || turn.role === 'assistant') {
      assistantCount++;
      if (messages) messages.push({ role: 'assistant', text });
    }
  }
  return { userCount, assistantCount, firstUserText, messages: messages ? messages.slice(-lastN) : null };
}

function tagFromFile(file) {
  const m = /checkpoint-?(.*)\.json$/.exec(path.basename(file));
  return m && m[1] ? m[1] : 'default';
}

// Walk ~/.gemini/tmp/<hash>/ (and a level deeper, e.g. a chats/ subdir) for
// any checkpoint*.json saved-chat file.
function findCheckpoints() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^checkpoint.*\.json$/.test(e.name)) out.push(p);
    }
  };
  walk(ROOT, 0);
  return out;
}

const cache = new Map();

export async function list() {
  const out = [];
  for (const file of findCheckpoints()) {
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (stat.size === 0) continue;
    let s;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) s = hit.summary;
    else {
      s = readCheckpoint(file);
      cache.set(file, { mtimeMs: stat.mtimeMs, summary: s });
    }
    if (s.userCount === 0 && s.assistantCount === 0) continue;
    const tag = tagFromFile(file);
    out.push(makeEntry({
      source, id: tag, ref: file,
      title: s.firstUserText ? s.firstUserText.slice(0, 80) : `Saved chat: ${tag}`,
      cwd: null, gitBranch: null,
      userCount: s.userCount, assistantCount: s.assistantCount,
      lastActivity: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs,
      firstUserText: s.firstUserText,
      resume: `gemini  # then: /chat resume ${tag}`,
    }));
  }
  return out;
}

export async function detail(ref, lastN = 30) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  const s = readCheckpoint(resolved, { wantMessages: true, lastN });
  const tag = tagFromFile(resolved);
  return {
    source, id: tag, title: (s.firstUserText || `Saved chat: ${tag}`).slice(0, 80),
    projectPath: '', gitBranch: null,
    resume: `gemini  # then: /chat resume ${tag}`,
    messages: s.messages || [],
  };
}
