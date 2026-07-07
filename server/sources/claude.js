// Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Every line is one record (user / assistant / meta).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, clip, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';
import { createClaudeContextTracker } from '../contextUsage.js';
import { ROOT, encodeClaudeRef, decodeClaudeRef, resolveBundle, resolveProjectBundles, loadSessionIndex } from './claudeBundle.js';

export const source = 'claude';

// Phase-accurate export capabilities (ADR-0013). Tri-value:
//   supported     — honored now
//   unavailable   — a real /replay feature this source WILL gain, not built in 1A
//   notApplicable — the source has no such concept (see codex.js)
// sidechains + history are 'unavailable' (not notApplicable): Claude has subagents
// and a history.jsonl, but 1A reads neither yet (1B, ADR-0012). The endpoint 400s an
// explicit request for them (ADR-0014) so history=on can't yield an empty -history.md.
export const exportCapabilities = {
  tools: 'supported',
  toolResults: 'supported',
  thinking: 'supported',
  sidechains: 'unavailable',
  history: 'unavailable',
  verbatim: 'supported',
  raw: 'supported',
  embedImages: 'supported',
};

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
  let title = null, firstUserText = '', cwd = null, gitBranch = null, firstTs = null, lastTs = null;
  let userCount = 0, assistantCount = 0;
  const messages = wantMessages ? [] : null;
  const ctx = createClaudeContextTracker();

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    ctx.push(o); // per-session context health — ignores non-eligible records
    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; }
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }

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
    summary: { title, firstUserText, cwd, gitBranch, firstTs, lastTs, userCount, assistantCount, contextUsage: ctx.finalize() },
    messages: messages ? messages.slice(-lastN) : null,
  };
}

const cache = new Map(); // file -> { mtimeMs, summary }

// One card per logical identity (ADR-0017, F2): each project is resolved to
// bundles in one batched pass, so a main transcript and its companion folder
// are a single card, and folder-only / index-only sessions (main deleted by
// the CLI's cleanup) get metadata-only cards instead of vanishing. Refs are
// opaque `v1:<slug>:<id>` from here on; entries carry `cacheSignature` so
// search/list invalidation sees subagent/index changes, while `mtimeMs`
// remains the numeric sort key.
export async function list() {
  let slugs = [];
  try {
    slugs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }

  const out = [];
  for (const slug of slugs) {
    let bundles;
    try { bundles = await resolveProjectBundles(slug); } catch { continue; }
    for (const b of bundles.values()) {
      const { sessionId } = b.identity;
      const ref = encodeClaudeRef(b.identity);
      if (b.mainPath) {
        // Live main transcript — display fields derive from readSession
        // exactly as before F2 (context health included; the index is NOT
        // consulted for these cards). Only ref scheme + cacheSignature changed.
        const stat = b.stats.main;
        if (stat.size === 0) continue;
        let summary;
        const hit = cache.get(b.mainPath);
        if (hit && hit.mtimeMs === stat.mtimeMs) summary = hit.summary;
        else {
          try { ({ summary } = await readSession(b.mainPath)); } catch { continue; }
          cache.set(b.mainPath, { mtimeMs: stat.mtimeMs, summary });
        }
        if (summary.userCount === 0 && summary.assistantCount === 0) continue;
        const cwd = summary.cwd || decodeProjectDir(slug);
        out.push(makeEntry({
          source, id: sessionId, ref,
          title: summary.title, cwd, gitBranch: summary.gitBranch,
          userCount: summary.userCount, assistantCount: summary.assistantCount,
          firstActivity: summary.firstTs,
          lastActivity: summary.lastTs || stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs, firstUserText: summary.firstUserText,
          resume: `${cdPrefix(cwd)}claude --resume ${sessionId}`,
          contextUsage: summary.contextUsage,
          cacheSignature: b.compositeSignature,
        }));
      } else {
        // Recovered session (folder-only / index-only): metadata-only card,
        // no transcript parsing (ADR-0012 — the converter is F3). Context
        // health needs the main transcript (ADR-0017) → null. resume '' —
        // the CLI cleaned this session up, a resume command would be a lie.
        // exportable:false — export 404s until the F3 converter exists.
        const idx = b.indexMeta;
        const isFolderOnly = b.subagentPaths.length > 0;
        let mtimeMs = 0;
        let lastActivity = null;
        if (isFolderOnly) {
          mtimeMs = b.stats.newestSubagentMs || 0;
          lastActivity = mtimeMs ? new Date(mtimeMs).toISOString() : null;
        } else {
          // Index timestamps are external input: only Number.isFinite-parsed
          // values may reach lastActivity/firstActivity — an invalid string
          // would sort as 0 (burying the card) and blank the time badge.
          const mod = idx && typeof idx.modified === 'string' ? Date.parse(idx.modified) : NaN;
          if (Number.isFinite(mod)) {
            mtimeMs = mod;
            lastActivity = idx.modified;
          } else {
            if (idx && Number.isFinite(idx.fileMtime)) {
              mtimeMs = idx.fileMtime;
              lastActivity = new Date(idx.fileMtime).toISOString();
            } else {
              const cre = idx && typeof idx.created === 'string' ? Date.parse(idx.created) : NaN;
              if (Number.isFinite(cre)) lastActivity = idx.created;
            }
          }
        }
        const created = idx && typeof idx.created === 'string' && Number.isFinite(Date.parse(idx.created))
          ? idx.created : null;
        out.push(makeEntry({
          source, id: sessionId, ref,
          title: (idx && idx.summary) || null,
          cwd: (idx && idx.projectPath) || decodeProjectDir(slug),
          gitBranch: (idx && idx.gitBranch) || null,
          messageCount: idx && Number.isFinite(idx.messageCount) ? idx.messageCount : undefined,
          firstActivity: created,
          lastActivity, mtimeMs,
          firstUserText: (idx && idx.firstPrompt) || '',
          resume: '',
          contextUsage: null,
          cacheSignature: b.compositeSignature,
          exportable: false,
        }));
      }
    }
  }
  return out;
}

// Dual-scheme ref acceptance (ADR-0017). Opaque `v1:<slug>:<id>` refs are
// discriminated by their scheme prefix (decodeClaudeRef → null for anything
// else — no sniffing) and resolved through the bundle resolver; every other
// ref is the legacy absolute-path form, handled byte-for-byte as before.
// EXPORT (collectEvents) requires a surviving MAIN transcript until the 1B
// converter lands (F3): a recovered identity maps to 'not_found' (→ 404),
// distinct from containment's 'forbidden' (→ 403). detail() resolves bundles
// itself since F2 so recovered cards can expand.
async function resolveRefToMainPath(ref) {
  const identity = decodeClaudeRef(ref);
  if (identity) {
    const bundle = await resolveBundle(identity);
    if (!bundle || !bundle.mainPath) {
      const e = new Error('not found');
      e.code = 'not_found';
      throw e;
    }
    return bundle.mainPath;
  }
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  return resolved;
}

// ADR-0017's explicit preview behavior for recovered sessions (F2): a
// metadata-only response — index-derived header fields, empty messages, no
// transcript parsing (ADR-0012). The `recovered` field tells the client (and
// future F3 UI) why the transcript is empty.
function recoveredDetail(bundle) {
  const idx = bundle.indexMeta;
  const cwd = (idx && idx.projectPath) || decodeProjectDir(bundle.identity.projectSlug);
  // Title mirrors the list card: summary, else a firstPrompt slice (same 80
  // cap makeEntry applies), else null.
  const title = (idx && (idx.summary
    || (typeof idx.firstPrompt === 'string' && idx.firstPrompt ? idx.firstPrompt.slice(0, 80) : null))) || null;
  return {
    source,
    id: bundle.identity.sessionId,
    title,
    projectPath: cwd,
    gitBranch: (idx && idx.gitBranch) || null,
    resume: '',
    recovered: bundle.subagentPaths.length ? 'folder-only' : 'index-only',
    messages: [],
  };
}

async function mainDetail(resolved, lastN) {
  const { summary, messages } = await readSession(resolved, { wantMessages: true, lastN });
  const id = path.basename(resolved).replace(/\.jsonl$/, '');
  const cwd = summary.cwd || '';
  return {
    source, id, title: summary.title, projectPath: cwd, gitBranch: summary.gitBranch,
    resume: `${cdPrefix(cwd)}claude --resume ${id}`,
    messages: messages || [],
  };
}

export async function detail(ref, lastN = 30) {
  const identity = decodeClaudeRef(ref);
  if (identity) {
    const bundle = await resolveBundle(identity);
    if (!bundle) {
      const e = new Error('not found');
      e.code = 'not_found';
      throw e;
    }
    if (!bundle.mainPath) return recoveredDetail(bundle);
    return mainDetail(bundle.mainPath, lastN);
  }
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  return mainDetail(resolved, lastN);
}

// ---------------------------------------------------------------------------
// Full-fidelity export: convert a Claude main transcript into the shared
// normalized-event contract the renderer (server/export.js) consumes. Direct
// port of extract-session.py's main-transcript path (load_jsonl_events +
// extract_user_tool_results + extract_assistant_blocks feeding render_event).
// Conversion is flag-independent — EVERYTHING is emitted; the renderer filters.
// This reproduces `/replay <id> --full` byte-for-byte.
//
// Scope: 1A — the top-level `<id>.jsonl` main transcript, with header metadata
// enriched from the project-slug dir's sessions-index.json when an entry
// matches (ADR-0015; /replay's direct-path branch calls
// load_session_index(p.parent, p.stem)). No subagents / history.jsonl /
// folder-only / index-only recovery (that is Phase 1B, ADR-0012, which also
// needs list() + a stable ref format).
// ---------------------------------------------------------------------------

// loadSessionIndex (the load_session_index port, incl. the structural-
// tolerance divergence note) lives in claudeBundle.js since F1 — the bundle
// resolver and this collector share it.

// Extract tool_result text from a user message's content list, mirroring
// extract_user_tool_results: string content → one entry; list content → each
// {type:'text'} item's text.
function userToolResults(message) {
  const content = message && message.content;
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const part of content) {
    if (!part || typeof part !== 'object' || part.type !== 'tool_result') continue;
    const c = part.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      for (const item of c) {
        if (item && typeof item === 'object' && item.type === 'text') out.push(item.text || '');
      }
    }
  }
  return out;
}

// `opts` accepted for registry-signature parity but intentionally unused — like
// the Codex adapter, conversion keeps every event; filtering is render-time.
// history.jsonl backfill (the one collect-time flag) is Phase 1B, not here.
export async function collectEvents(ref, _opts = {}) {
  const resolved = await resolveRefToMainPath(ref);
  const sessionId = path.basename(resolved).replace(/\.jsonl$/, '');

  // Live-main index enrichment (ADR-0015): only the four fields the renderer's
  // header emits — firstPrompt/modified exist in index entries but /replay
  // never renders them, so they stay out of the meta contract. Falsey values
  // pass through; renderMarkdown suppresses them exactly like the Python
  // truthiness checks. Loaded BEFORE the readline interface exists: awaiting
  // between createInterface and the for-await loop would let 'line' events
  // fire with no consumer attached and starve the iterator.
  const idx = await loadSessionIndex(path.dirname(resolved), sessionId);

  const rl = readline.createInterface({
    input: fs.createReadStream(resolved, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const events = [];
  const cwdCandidates = []; // { ts, cwd } across ALL records — mirrors main()'s post-sort cwd scan
  const meta = {
    source, isCodex: false, mainPath: resolved,
    sessionId, cwd: null, historyOn: false,
  };
  if (idx) {
    meta.summary = idx.summary;
    meta.created = idx.created;
    meta.gitBranch = idx.gitBranch;
    meta.messageCount = idx.messageCount;
  }
  const emit = (role, ts, blocks, extra = {}) =>
    events.push({ role, ts: ts || '', source: 'main', ...extra, blocks });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const ts = o.timestamp || '';
    if (o.cwd) cwdCandidates.push({ ts, cwd: o.cwd });

    const msg = o.message;
    if (o.type === 'user' && msg) {
      const content = msg.content;
      const sidechain = !!o.isSidechain;
      const meta_ = !!o.isMeta;
      const blocks = [];
      if (typeof content === 'string') {
        blocks.push({ kind: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text') blocks.push({ kind: 'text', text: b.text || '' });
          else if (b.type === 'image') {
            const src = b.source || {};
            blocks.push({ kind: 'image', mediaType: src.media_type || 'image', source: src });
          }
        }
        for (const tr of userToolResults(msg)) blocks.push({ kind: 'tool_result', text: tr });
      }
      emit('user', ts, blocks, {
        sidechain, meta: meta_, imagePasteIds: o.imagePasteIds || [],
      });
    } else if (o.type === 'assistant' && msg) {
      const sidechain = !!o.isSidechain;
      const blocks = [];
      for (const part of msg.content || []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') blocks.push({ kind: 'text', text: part.text || '' });
        else if (part.type === 'thinking') blocks.push({ kind: 'thinking', text: part.thinking || '' });
        else if (part.type === 'reasoning') blocks.push({ kind: 'reasoning', text: part.text || '' });
        else if (part.type === 'tool_use') blocks.push({ kind: 'tool_use', name: part.name || '?', input: part.input });
      }
      emit('assistant', ts, blocks, { sidechain, meta: false });
    }
    // file-history-snapshot / system / summary / etc.: not conversational — dropped.
  }

  // cwd = first record (by sorted timestamp, across all records) carrying a cwd,
  // matching main()'s scan AFTER the global timestamp sort.
  cwdCandidates.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const c of cwdCandidates) { if (c.cwd) { meta.cwd = c.cwd; break; } }

  // extract-session.py sorts all events by ISO timestamp; Array.sort is stable
  // (Node 12+) so equal-ts events keep emission order, matching Python.
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { meta, events };
}
