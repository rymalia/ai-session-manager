import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { makeEntry, cdPrefix, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';

const HOME = os.homedir();
const ROOT = path.join(HOME, '.gemini', 'antigravity-cli');
export const REAL_ROOT = (() => {
  try { return fs.realpathSync(ROOT); } catch { return ROOT; }
})();
export const source = 'antigravity';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PATH_REGEX = /file:\/\/(\/[^\0-\x1f"\\]+)/g;

export function isSessionId(x) {
  return typeof x === 'string' && UUID_REGEX.test(x);
}

function assertIdShapedRef(ref) {
  if (!isSessionId(ref)) throw new Error('forbidden');
}

// Resolve a session's full transcript through symlinks and require it to stay
// inside the Antigravity root. Returns the real path, or null if the id is
// malformed, the file is missing, or it links outside the root. list() and
// server/usage.js both go through this so a transcript symlinked out of a real
// session directory can never leak into a card or a usage tally (detail() has
// its own realpath guard for client-supplied refs).
export function containedTranscript(sessionId) {
  if (!isSessionId(sessionId)) return null;
  const p = path.join(ROOT, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  return isInside(real, REAL_ROOT) ? real : null;
}

// A user rename (`agy` "/rename") is stored as text-protobuf in
// annotations/<id>.pbtxt: a `title:"…"` line. It takes precedence over the
// derived first-prompt title. Tiny file, read fresh (only renamed sessions have
// one). Realpath-guarded like every other read.
function readCustomTitle(sessionId) {
  if (!isSessionId(sessionId)) return null;
  const p = path.join(ROOT, 'annotations', `${sessionId}.pbtxt`);
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  if (!isInside(real, REAL_ROOT)) return null;
  let text;
  try { text = fs.readFileSync(real, 'utf8'); } catch { return null; }
  const m = /^\s*title:\s*"((?:[^"\\]|\\.)*)"/m.exec(text);
  if (!m) return null;
  const title = unescapePbText(m[1]).trim();
  return title || null;
}

// Decode a protobuf text-format string literal's C-style escapes. A naive
// `\\(.)→$1` would turn `\n` into a literal "n"; do it properly.
function unescapePbText(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[abfnrtv"'\\?])/g, (_, e) => {
    switch (e) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
      case 'a': return '\x07'; case 'b': return '\b'; case 'f': return '\f';
      case 'v': return '\v'; case '"': return '"'; case "'": return "'";
      case '\\': return '\\'; case '?': return '?';
    }
    return e[0] === 'x'
      ? String.fromCharCode(parseInt(e.slice(1), 16))
      : String.fromCharCode(parseInt(e, 8));
  });
}

function notFound() {
  const e = new Error('not found');
  e.code = 'not_found';
  return e;
}

// The canonical human prompt is the <USER_REQUEST> body; <ADDITIONAL_METADATA>
// and <USER_SETTINGS_CHANGE> are injected context, not user content.
function extractUserText(content) {
  if (typeof content !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (m) return m[1].trim();
  // No wrapper: drop any <TAG>…</TAG> blocks. If that leaves nothing, the content
  // was purely injected context (e.g. a lone <USER_SETTINGS_CHANGE>) and there is
  // no user text — do NOT fall back to the raw content, which would surface the
  // injected block. Fall back only when there were no tag blocks at all.
  const TAG_BLOCK = /<[^>]+>[\s\S]*?<\/[^>]+>/;
  const stripped = content.replace(new RegExp(TAG_BLOCK, 'g'), '').trim();
  if (stripped) return stripped;
  return TAG_BLOCK.test(content) ? '' : content.trim();
}

// Render each tool_call as a 🔧 line. `args` values arrive JSON-encoded; unwrap
// one level of quoting where possible, else hand the raw value to toolUseLine.
function toolCallLines(tool_calls) {
  const out = [];
  if (!Array.isArray(tool_calls)) return out;
  for (const tc of tool_calls) {
    if (!tc || !tc.name) continue;
    let args = '';
    if (tc.args) {
      try { args = typeof tc.args === 'string' ? JSON.parse(tc.args) : tc.args; }
      catch { args = tc.args; }
    }
    out.push(toolUseLine(tc.name, args));
  }
  return out;
}

const workspaceCache = new Map();

// Best-effort project attribution, protobuf-free and fails-open (returns null).
// Exported so server/usage.js shares ONE implementation (no divergent copy).
export function resolveCwd(sessionId, mtimeMs) {
  const hit = workspaceCache.get(sessionId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cwd;

  let cwd = null;

  try {
    const dbPath = path.join(ROOT, 'conversations', `${sessionId}.db`);
    const buffer = fs.readFileSync(dbPath);
    let shortest = null;
    let match;
    const text = buffer.toString('utf8');
    const geminiDir = path.join(HOME, '.gemini');
    while ((match = PATH_REGEX.exec(text)) !== null) {
      try {
        // Resolve `..` before the containment test, or `/Users/me/../../etc`
        // would pass the HOME prefix check yet statSync outside it.
        const decoded = path.resolve(decodeURIComponent(match[1]));
        if (!isInside(decoded, HOME) || isInside(decoded, geminiDir)) continue;
        const stat = fs.statSync(decoded);
        if (stat.isDirectory()) {
          if (!shortest || decoded.length < shortest.length) {
            shortest = decoded;
          }
        }
      } catch {}
    }
    if (shortest) cwd = shortest;
  } catch {}

  if (!cwd) {
    try {
      const cachePath = path.join(ROOT, 'cache', 'last_conversations.json');
      const json = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const [workspace, id] of Object.entries(json)) {
        if (id === sessionId) {
          cwd = workspace;
          break;
        }
      }
    } catch {}
  }

  if (!cwd) {
    try {
      const dbPath = path.join(ROOT, 'conversation_summaries.db');
      if (fs.existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?').get(sessionId);
        db.close();
        if (row && row.workspace_uris) {
          const uris = JSON.parse(row.workspace_uris);
          if (Array.isArray(uris) && uris.length > 0) {
            const uri = uris[0];
            if (uri.startsWith('file://')) cwd = decodeURIComponent(uri.slice(7));
            else cwd = uri;
          }
        }
      }
    } catch {}
  }

  workspaceCache.set(sessionId, { mtimeMs, cwd });
  return cwd;
}

let summariesDbCache = { mtimeMs: 0, map: new Map() };
function getSummaryMeta(sessionId) {
  try {
    const dbPath = path.join(ROOT, 'conversation_summaries.db');
    const stat = fs.statSync(dbPath);
    if (summariesDbCache.mtimeMs !== stat.mtimeMs) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare('SELECT conversation_id, title, preview FROM conversation_summaries').all();
      const map = new Map();
      for (const r of rows) map.set(r.conversation_id, { title: r.title, preview: r.preview });
      db.close();
      summariesDbCache = { mtimeMs: stat.mtimeMs, map };
    }
    return summariesDbCache.map.get(sessionId) || null;
  } catch {
    return null;
  }
}

async function parseTranscript(file, { wantMessages = false } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let firstActivity = null;
  let lastActivity = null;
  let firstUserText = '';
  let userCount = 0;
  let assistantCount = 0;
  let model = null;
  let effort = null;
  const messages = wantMessages ? [] : null;

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    // Valid JSON that isn't an object (e.g. a bare `null`) must isolate like a
    // malformed line, not throw on the field accesses below.
    if (!o || typeof o !== 'object') continue;

    const ms = typeof o.created_at === 'string' ? new Date(o.created_at).getTime() : null;
    const iso = ms && !Number.isNaN(ms) ? new Date(ms).toISOString() : null;

    if (iso) {
      if (!firstActivity || iso < firstActivity) firstActivity = iso;
      if (!lastActivity || iso > lastActivity) lastActivity = iso;
    }

    if (o.type === 'CONVERSATION_HISTORY' || o.type === 'CHECKPOINT') continue;

    if (o.type === 'USER_INPUT' && o.source === 'USER_EXPLICIT') {
      userCount++;
      const content = typeof o.content === 'string' ? o.content : '';

      // Model/effort ride in <USER_SETTINGS_CHANGE> as one pair; a later change
      // overwrites both together, never splitting a stale effort across a switch.
      // agy runs non-Gemini models too, and the parenthetical carries the
      // reasoning mode for ALL of them — Gemini "(High|Medium|Low)", Claude
      // "(Thinking)", GPT-OSS "(Medium)", … — so accept ANY parenthetical, not
      // just the Gemini levels. (`[^)]+` up to the first close-paren; the model
      // name may contain dots like "Claude Opus 4.6", so the paren, not a ".",
      // is the delimiter.)
      const sm = /Model Selection.*?\bto\s+(.+?)\s*\(([^)]+)\)/i.exec(content);
      if (sm) { model = sm[1].trim(); effort = sm[2].trim().toLowerCase(); }

      const text = extractUserText(content);
      if (!firstUserText && text) firstUserText = text;
      if (messages) messages.push({ role: 'user', text });
      continue;
    }

    // An assistant turn = thinking (💭) + text + tool calls (🔧), in that order,
    // as ONE message. Empty status/streaming steps (no thinking/content/tools)
    // are skipped entirely — not emitted, not counted.
    if (o.source === 'MODEL' && (o.type === 'PLANNER_RESPONSE' || (Array.isArray(o.tool_calls) && !o.content))) {
      const parts = [];
      if (o.thinking) parts.push(thinkingLine(o.thinking));
      if (o.content) parts.push(o.content);
      parts.push(...toolCallLines(o.tool_calls));
      if (parts.length === 0) continue;
      assistantCount++;
      if (messages) messages.push({ role: 'assistant', text: parts.join('\n') });
      continue;
    }

    // Any other MODEL step carrying content is a tool-execution record
    // (VIEW_FILE, LIST_DIRECTORY, RUN_COMMAND, …) → a tool-role result.
    if (o.source === 'MODEL' && o.content) {
      if (messages) messages.push({ role: 'tool', text: toolResultLine(o.content) });
      continue;
    }
  }

  return { firstActivity, lastActivity, firstUserText, userCount, assistantCount, model, effort, messages };
}

const parseCache = new Map();

export async function list() {
  const out = [];
  const brainDir = path.join(ROOT, 'brain');
  let entries;
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!UUID_REGEX.test(entry.name)) continue;

    // Resolve through symlinks and require containment BEFORE reading — a real
    // session dir whose transcript links outside the root must not leak.
    const transcriptFull = containedTranscript(entry.name);
    if (!transcriptFull) continue;
    const transcript = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');

    let statFull = null, stat = null;
    try { statFull = fs.statSync(transcriptFull); } catch {}
    try { stat = fs.statSync(transcript); } catch {}

    if (!statFull) continue;

    const mtimeMs = Math.max(statFull.mtimeMs, stat ? stat.mtimeMs : 0);
    const hit = parseCache.get(entry.name);

    let summary;
    if (hit && hit.mtimeMs === mtimeMs) {
      summary = hit.summary;
    } else {
      try {
        summary = await parseTranscript(transcriptFull);
        parseCache.set(entry.name, { mtimeMs, summary });
      } catch {
        continue;
      }
    }

    const { firstActivity, lastActivity, firstUserText, userCount, assistantCount, model, effort } = summary;
    // An empty transcript is not a real session (matches gemini/kimi).
    if (userCount === 0 && assistantCount === 0) continue;
    const cwd = resolveCwd(entry.name, mtimeMs);
    const sm = getSummaryMeta(entry.name);
    
    let title = readCustomTitle(entry.name) || sm?.title || sm?.preview;
    if (!title) title = firstUserText ? firstUserText.slice(0, 80) : '';

    out.push(makeEntry({
      source, id: entry.name, ref: entry.name,
      title, cwd: cwd || '', gitBranch: null,
      userCount, assistantCount,
      firstActivity, lastActivity,
      mtimeMs, firstUserText,
      resume: `${cdPrefix(cwd)}agy --conversation ${entry.name}`,
      cacheSignature: null,
      model, effort
    }));
  }

  return out;
}

export async function detail(ref, lastN = 30) {
  assertIdShapedRef(ref);
  const transcriptFull = path.join(ROOT, 'brain', ref, '.system_generated', 'logs', 'transcript_full.jsonl');
  let resolved;
  try {
    resolved = fs.realpathSync(transcriptFull);
  } catch {
    throw notFound();
  }
  if (!isInside(resolved, REAL_ROOT)) throw new Error('forbidden');

  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw notFound();
  }

  const { messages } = await parseTranscript(resolved, { wantMessages: true });
  
  let mtimeMs = 0;
  try {
     const stat = fs.statSync(resolved);
     mtimeMs = stat.mtimeMs;
  } catch {}

  const cwd = resolveCwd(ref, mtimeMs);
  const sm = getSummaryMeta(ref);
  
  // First NON-EMPTY user message, matching list()'s firstUserText rule — a
  // metadata-only first turn (empty text) must not become an empty title.
  const userFirst = messages.find(m => m.role === 'user' && m.text && m.text.trim());
  let title = readCustomTitle(ref) || sm?.title || sm?.preview;
  if (!title && userFirst) title = userFirst.text.slice(0, 80);

  const sliced = messages.slice(-lastN);
  
  return {
    source, id: ref, title: title || '', projectPath: cwd || '', gitBranch: null,
    resume: `${cdPrefix(cwd)}agy --conversation ${ref}`,
    messages: sliced,
  };
}
