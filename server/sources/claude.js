// Claude Code: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Every line is one record (user / assistant / meta).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeEntry, cdPrefix, clip, toolUseLine, toolResultLine, thinkingLine, isInside } from './_shared.js';
import { cleanUserText } from '../export.js';
import { createClaudeContextTracker } from '../contextUsage.js';
import { ROOT, encodeClaudeRef, decodeClaudeRef, resolveBundle, resolveProjectBundles, loadSessionIndex } from './claudeBundle.js';

export const source = 'claude';

// Phase-accurate export capabilities (ADR-0013). Tri-value:
//   supported     — honored now
//   unavailable   — a real /replay feature this source WILL gain, not built yet
//   notApplicable — the source has no such concept (see codex.js)
// sidechains + history flipped to 'supported' in F3: the collector reads
// subagent sidechain files and backfills ~/.claude/history.jsonl (tri-state
// `history: auto|on|off`, resolved per-session in collectBundleEvents).
export const exportCapabilities = {
  tools: 'supported',
  toolResults: 'supported',
  thinking: 'supported',
  sidechains: 'supported',
  history: 'supported',
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
        // Recovered session (folder-only / index-only): metadata-only card —
        // the card itself never parses transcripts. Context health needs the
        // main transcript (ADR-0017) → null. resume '' — the CLI cleaned this
        // session up, a resume command would be a lie. Export works since F3
        // (bundle-wide collectEvents), so no exportable gate.
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
        }));
      }
    }
  }
  return out;
}

// Dual-scheme ref acceptance (ADR-0017). Opaque `v1:<slug>:<id>` refs are
// discriminated by their scheme prefix (decodeClaudeRef → null for anything
// else — no sniffing) and resolved through the bundle resolver; every other
// ref is the legacy absolute-path form. A recovered identity that matches no
// artifact at all maps to 'not_found' (→ 404), distinct from containment's
// 'forbidden' (→ 403). detail() resolves bundles itself since F2 so recovered
// cards can expand.
function notFound() {
  const e = new Error('not found');
  e.code = 'not_found';
  return e;
}

// Containment + existence for a legacy path ref, shared by detail() and the
// export resolver: outside ROOT → 'forbidden' (403); missing or not a regular
// file → 'not_found' (404), never a raw ENOENT (which the endpoint would 500).
function containedFilePath(ref) {
  const resolved = path.resolve(ref);
  if (!isInside(resolved, ROOT)) throw new Error('forbidden');
  let st;
  try { st = fs.statSync(resolved); } catch { throw notFound(); }
  if (!st.isFile()) throw notFound();
  return resolved;
}

// Export resolution: any ref → a SessionBundle shape for collectBundleEvents.
// Opaque refs are the reference's UUID branch (full bundle: main + companion
// subagents + index). Path refs mirror its direct-file branch
// (extract-session.py resolve_session:120-131): a top-level `.jsonl` is
// main-only even if a companion folder exists, and a subagent file (parent dir
// `subagents/` or `agent-*` name) is a subagent-only bundle whose session id
// is sniffed from records at collect time. A path invocation never picks up
// companion artifacts the caller didn't name.
async function resolveRefToBundle(ref) {
  const identity = decodeClaudeRef(ref);
  if (identity) {
    const bundle = await resolveBundle(identity);
    if (!bundle) throw notFound(); // no artifact survives for this identity
    return bundle;
  }
  // Missing/non-file path refs are a client error (stale ref), not a 500 —
  // endpoint-hygiene divergence from the reference's CLI crash.
  const resolved = containedFilePath(ref);
  const base = path.basename(resolved);
  if (path.basename(path.dirname(resolved)) === 'subagents' || base.startsWith('agent-')) {
    return {
      identity: { source, projectSlug: null, sessionId: null },
      mainPath: null,
      folderPath: null,
      subagentPaths: [resolved],
      indexMeta: null,
    };
  }
  const sessionId = base.replace(/\.jsonl$/, '');
  return {
    identity: { source, projectSlug: null, sessionId },
    mainPath: resolved,
    folderPath: null,
    subagentPaths: [],
    indexMeta: await loadSessionIndex(path.dirname(resolved), sessionId),
  };
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
  return mainDetail(containedFilePath(ref), lastN);
}

// ---------------------------------------------------------------------------
// Full-fidelity export: convert a Claude session BUNDLE into the shared
// normalized-event contract the renderer (server/export.js) consumes. Direct
// port of extract-session.py's collection paths (load_jsonl_events +
// extract_user_tool_results + extract_assistant_blocks + load_history_events
// feeding render_event). This reproduces `/replay <id> --full` byte-for-byte.
//
// Scope since F3 (Phase 1B complete): main transcript + subagent sidechains +
// history.jsonl backfill + folder-only / index-only recovery, with header
// metadata enriched from the project-slug dir's sessions-index.json when an
// entry matches (ADR-0015). Conversion keeps every event and filtering is
// render-time (ADR-0004), except history backfill — the one collect-time
// flag, tri-state `auto|on|off` resolved per-session.
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

// Read one transcript file (main or subagent) into the shared sinks. `srcTag`
// stamps each event's `source` ('main' | 'subagent:<stem>'); the sidechain flag
// always comes from the record itself (`isSidechain`), mirroring render_event —
// the reference never forces it per-file. Optional sinks: `sniff` captures the
// first record-level sessionId (raw subagent path refs arrive without one,
// py:848-855); `mainUserStrings` collects raw STRING-valued user content for
// the history dedup seen-set (py:861-868 — the key is built from the raw
// string, and only string content participates). No `await` may sit between
// createInterface and the for-await loop (a consumer-less 'line' event would
// starve the iterator — real hang).
async function readTranscriptEvents(file, srcTag, { events, cwdCandidates, sniff, mainUserStrings }) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const emit = (role, ts, blocks, extra = {}) =>
    events.push({ role, ts: ts || '', source: srcTag, ...extra, blocks });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (sniff && !sniff.sessionId && o.sessionId) sniff.sessionId = o.sessionId;
    const ts = o.timestamp || '';
    if (o.cwd) cwdCandidates.push({ ts, cwd: o.cwd });

    const msg = o.message;
    if (o.type === 'user' && msg) {
      if (mainUserStrings && typeof msg.content === 'string') mainUserStrings.push(msg.content);
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
}

// ---- history.jsonl backfill (port of load_history_events, py:339-373) -------

// Captured at import time like ROOT — tests that stage a fake HOME must run
// adapter code in a child process. Read fresh on every export and never
// stat'd into any cache signature: history.jsonl must not invalidate listing
// caches (ADR-0017).
const HISTORY_PATH = path.join(os.homedir(), '.claude', 'history.jsonl');

// Port of ms_to_iso (py:339-342): exact `YYYY-MM-DDTHH:mm:ss.mmmZ`.
// toISOString emits floored seconds + positive milliseconds, byte-equal to
// Python's fromtimestamp + `whole % 1000` for every finite in-range epoch,
// negatives included.
function msToIso(tsMs) {
  return new Date(Math.trunc(tsMs)).toISOString();
}

// Python slices code points ([:200]); a UTF-16 .slice could count astral
// chars double and disagree with the reference near the boundary.
function cpSlice(s, n) {
  let out = '', i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

// Port of normalize_user_text (py:261-267): the dedup key for history
// backfill. Order is load-bearing: clean_user_text FIRST (noise-tag strip +
// command-name rewrite), then whitespace-collapse, trim, lowercase, cap at
// 200 code points.
function normalizeUserText(s) {
  if (typeof s !== 'string') return '';
  return cpSlice(cleanUserText(s, false).replace(/\s+/g, ' ').trim().toLowerCase(), 200);
}

// → [{ ts, display, project }] for this session, in file order. Skips lines
// mirroring the reference: wrong session, missing timestamp, blank display.
// Non-numeric/out-of-range timestamps are skipped too (the reference CLI
// would crash there; unobservable divergence, fail-soft is right for HTTP).
async function loadHistoryEvents(sessionId) {
  const out = [];
  try { if (!fs.statSync(HISTORY_PATH).isFile()) return out; } catch { return out; }
  const rl = readline.createInterface({
    input: fs.createReadStream(HISTORY_PATH, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let h; try { h = JSON.parse(t); } catch { continue; }
    if (!h || typeof h !== 'object' || h.sessionId !== sessionId) continue;
    if (h.timestamp === null || h.timestamp === undefined) continue;
    const ms = Math.trunc(Number(h.timestamp));
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) continue;
    const display = h.display || '';
    if (typeof display !== 'string' || !display.trim()) continue;
    out.push({ ts: msToIso(ms), display, project: h.project });
  }
  return out;
}

// Collect a resolved bundle's events (port of extract-session.py main()'s
// collection block, py:833-882): main → lexically-sorted subagents → history
// backfill, then ONE stable ts sort — the concatenation order is the
// equal-timestamp tiebreaker, so it must match the reference exactly.
async function collectBundleEvents(bundle, opts = {}) {
  const idx = bundle.indexMeta;
  const events = [];
  const cwdCandidates = []; // { ts, cwd } across ALL records — mirrors main()'s post-sort cwd scan
  const sniff = { sessionId: null };
  const mainUserStrings = [];

  // Flag resolution (py:833-841): a subagent-only bundle (folder-only session
  // or raw subagent path ref) forces sidechains on so recovered events aren't
  // filtered out, and resolves history auto→on; every other shape resolves
  // auto→off (index-only included — is_folder_only requires subagents).
  // Requested opts are never mutated (ADR-0014): the renderer filters on the
  // returned resolvedOpts, while filename tokens derived from requested opts
  // upstream at the endpoint.
  const recoveredSub = !bundle.mainPath && bundle.subagentPaths.length > 0;
  const sidechains = !!opts.sidechains || recoveredSub;
  const historyOn = opts.history === 'on' ? true
                  : opts.history === 'off' ? false
                  : recoveredSub;

  if (bundle.mainPath) {
    await readTranscriptEvents(bundle.mainPath, 'main', { events, cwdCandidates, sniff, mainUserStrings });
  }
  for (const sp of bundle.subagentPaths) {
    const stem = path.basename(sp).replace(/\.[^.]*$/, ''); // Python p.stem
    await readTranscriptEvents(sp, `subagent:${stem}`, { events, cwdCandidates, sniff });
  }

  // Session id may be unknown for a raw subagent path ref — sniffed from the
  // records in load order (py:848-855).
  const sessionId = bundle.identity.sessionId || sniff.sessionId || null;

  let historyAdded = 0;
  if (historyOn && sessionId) {
    let hist = await loadHistoryEvents(sessionId);
    if (bundle.mainPath && hist.length) {
      // Dedup ONLY against main-transcript user turns with string content
      // (py:857-870); subagent turns never participate, and a folder-only
      // bundle backfills wholesale.
      const seen = new Set();
      for (const s of mainUserStrings) {
        const key = normalizeUserText(s);
        if (key) seen.add(key);
      }
      hist = hist.filter((h) => !seen.has(normalizeUserText(h.display)));
    }
    for (const h of hist) {
      events.push({
        role: 'user', ts: h.ts, source: 'history',
        sidechain: false, meta: false,
        blocks: [{ kind: 'text', text: h.display }],
      });
      // Only SURVIVING history events join the cwd scan — the reference
      // appends post-filter, then scans (py:871, 877-882).
      if (h.project) cwdCandidates.push({ ts: h.ts, cwd: h.project });
    }
    historyAdded = hist.length;
  }

  const meta = {
    source, isCodex: false, mainPath: bundle.mainPath,
    sessionId, cwd: null,
    subagentCount: bundle.subagentPaths.length,
    folder: bundle.folderPath,
    historyOn, historyAdded,
  };
  // Index enrichment (ADR-0015): only the four fields the renderer's header
  // emits — firstPrompt/modified exist in index entries but /replay never
  // renders them, so they stay out of the meta contract. Falsey values pass
  // through; renderMarkdown suppresses them exactly like the Python
  // truthiness checks.
  if (idx) {
    meta.summary = idx.summary;
    meta.created = idx.created;
    meta.gitBranch = idx.gitBranch;
    meta.messageCount = idx.messageCount;
  }

  // cwd = first record (by sorted timestamp, across all records) carrying a cwd,
  // matching main()'s scan AFTER the global timestamp sort.
  cwdCandidates.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const c of cwdCandidates) { if (c.cwd) { meta.cwd = c.cwd; break; } }

  // extract-session.py sorts all events by ISO timestamp; Array.sort is stable
  // (Node 12+) so equal-ts events keep emission order, matching Python.
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return {
    meta,
    events,
    resolvedOpts: { ...opts, sidechains, history: historyOn ? 'on' : 'off' },
  };
}

// Conversion keeps every event (filtering is render-time, ADR-0004) with ONE
// collect-time exception: history.jsonl backfill, resolved from the tri-state
// `opts.history` inside collectBundleEvents.
export async function collectEvents(ref, opts = {}) {
  const bundle = await resolveRefToBundle(ref);
  return collectBundleEvents(bundle, opts);
}
