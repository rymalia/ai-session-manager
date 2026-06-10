// Per-tool usage / quota surfacing. Reads ONLY local files that each CLI
// already writes; everything here is strictly read-only. Most CLIs do not
// persist remaining quota locally, so we are honest: we surface consumed
// tokens / cost where it genuinely exists, a remaining-quota snapshot where a
// tool actually stores one (only codex does), and mark the rest unavailable.
//
// Results are cached and only recomputed when the underlying files change
// (newest mtime across the relevant tree), so repeat calls stay well under a
// second even though Claude has ~1000 transcripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------
function fmtTokens(n) {
  if (!n || n < 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtCost(n) {
  if (n == null) return null;
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}
function fmtCount(n) {
  return new Intl.NumberFormat('en-US').format(n || 0);
}
function fmtReset(epochSec) {
  if (!epochSec) return null;
  const ms = epochSec * 1000;
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

// Walk a directory tree collecting files that match `test(name)`.
// Returns { files: [paths], newest: maxMtimeMs } in a single pass.
function walk(dir, test) {
  const files = [];
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!test(e.name)) continue;
      let m = 0;
      try { m = fs.statSync(p).mtimeMs; } catch {}
      if (m > newest) newest = m;
      files.push(p);
    }
  }
  return { files, newest };
}

function readLines(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return data.split('\n');
}

// Per-source memo keyed on a "signature" (usually the newest mtime in the
// tree). When the signature is unchanged we return the cached payload.
const cache = new Map();
function memo(key, sig, compute) {
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.value;
  const value = compute();
  cache.set(key, { sig, value });
  return value;
}

// ---------------------------------------------------------------------------
// opencode — SQLite, real cost + token totals per assistant message
// ---------------------------------------------------------------------------
function opencodeUsage() {
  const dbPath = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
  let stat;
  try { stat = fs.statSync(dbPath); } catch {
    return { source: 'opencode', available: false, note: 'opencode.db not found' };
  }
  return memo('opencode', `${stat.mtimeMs}:${stat.size}`, () => {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch {
      return { source: 'opencode', available: false, note: 'Could not open opencode.db' };
    }
    let cost = 0, input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, msgs = 0;
    try {
      for (const row of db.prepare(`SELECT data FROM message WHERE data LIKE '%"tokens"%'`).all()) {
        let p; try { p = JSON.parse(row.data); } catch { continue; }
        if (typeof p.cost === 'number') cost += p.cost;
        const t = p.tokens;
        if (t) {
          input += t.input || 0;
          output += t.output || 0;
          reasoning += t.reasoning || 0;
          if (t.cache) { cacheRead += t.cache.read || 0; cacheWrite += t.cache.write || 0; }
          msgs++;
        }
      }
    } catch {
      try { db.close(); } catch {}
      return { source: 'opencode', available: false, note: 'Unexpected opencode schema' };
    }
    try { db.close(); } catch {}
    const total = input + output + reasoning + cacheRead + cacheWrite;
    return {
      source: 'opencode',
      available: true,
      kind: 'consumed',
      metrics: [
        { key: 'tokens', label: 'Tokens used', value: total, display: fmtTokens(total),
          detail: `in ${fmtTokens(input)} · out ${fmtTokens(output)} · cache ${fmtTokens(cacheRead + cacheWrite)}` },
        { key: 'cost', label: 'Recorded cost', value: cost, display: cost > 0 ? fmtCost(cost) : '$0.00',
          detail: cost > 0 ? null : 'opencode logs $0 on subscription/local models' },
        { key: 'messages', label: 'Assistant msgs', value: msgs, display: fmtCount(msgs) },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// claude — JSONL transcripts, sum message.usage across every assistant line
// ---------------------------------------------------------------------------
function claudeUsage() {
  const root = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(root)) return { source: 'claude', available: false, note: 'No ~/.claude/projects' };
  const { files, newest } = walk(root, (n) => n.endsWith('.jsonl'));
  if (!files.length) return { source: 'claude', available: false, note: 'No transcripts found' };
  return memo('claude', `${newest}:${files.length}`, () => {
    let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, assistantMsgs = 0;
    for (const f of files) {
      for (const line of readLines(f)) {
        if (!line || line.indexOf('"usage"') < 0) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const u = o && o.message && o.message.usage;
        if (!u) continue;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreate += u.cache_creation_input_tokens || 0;
        assistantMsgs++;
      }
    }
    const total = input + output + cacheRead + cacheCreate;
    return {
      source: 'claude',
      available: true,
      kind: 'consumed',
      note: 'No remaining-quota stored locally; totals are all-time across transcripts',
      metrics: [
        { key: 'tokens', label: 'Tokens used (all time)', value: total, display: fmtTokens(total),
          detail: `in ${fmtTokens(input)} · out ${fmtTokens(output)} · cache ${fmtTokens(cacheRead + cacheCreate)}` },
        { key: 'sessions', label: 'Transcripts', value: files.length, display: fmtCount(files.length) },
        { key: 'messages', label: 'Assistant msgs', value: assistantMsgs, display: fmtCount(assistantMsgs) },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// codex — rollout JSONL. Has BOTH consumed token totals AND a real
// remaining-quota snapshot (rate_limits.used_percent + resets_at). We take the
// latest token_count event per file (cumulative within a session) and the most
// recent rate-limit snapshot across all files.
// ---------------------------------------------------------------------------
function codexUsage() {
  const root = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(root)) return { source: 'codex', available: false, note: 'No ~/.codex/sessions' };
  const { files, newest } = walk(root, (n) => /^rollout-.*\.jsonl$/.test(n));
  if (!files.length) return { source: 'codex', available: false, note: 'No rollout files found' };
  return memo('codex', `${newest}:${files.length}`, () => {
    let totalTokens = 0, totalInput = 0, totalOutput = 0, totalReasoning = 0;
    let latestTs = 0, latestRL = null, planType = null;
    for (const f of files) {
      let fileTotal = null, fileInput = 0, fileOutput = 0, fileReasoning = 0;
      for (const line of readLines(f)) {
        if (!line || line.indexOf('token_count') < 0) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const p = o && o.payload;
        if (!p || p.type !== 'token_count') continue;
        // token totals: cumulative within the session, take the last with info.
        const info = p.info && p.info.total_token_usage;
        if (info) {
          fileTotal = info.total_tokens || 0;
          fileInput = info.input_tokens || 0;
          fileOutput = info.output_tokens || 0;
          fileReasoning = info.reasoning_output_tokens || 0;
        }
        // rate limits: keep the most recent snapshot we see (by line timestamp).
        const rl = p.rate_limits;
        if (rl) {
          const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
          if (ts >= latestTs) {
            latestTs = ts;
            latestRL = rl;
            if (rl.plan_type) planType = rl.plan_type;
          }
        }
      }
      if (fileTotal != null) {
        totalTokens += fileTotal;
        totalInput += fileInput;
        totalOutput += fileOutput;
        totalReasoning += fileReasoning;
      }
    }

    const metrics = [
      { key: 'tokens', label: 'Tokens used', value: totalTokens, display: fmtTokens(totalTokens),
        detail: `in ${fmtTokens(totalInput)} · out ${fmtTokens(totalOutput)} · reasoning ${fmtTokens(totalReasoning)}` },
      { key: 'sessions', label: 'Sessions', value: files.length, display: fmtCount(files.length) },
    ];

    // Genuine remaining-quota: codex stores used_percent + reset windows.
    if (latestRL) {
      const p = latestRL.primary, s = latestRL.secondary;
      if (p && typeof p.used_percent === 'number') {
        const left = Math.max(0, 100 - p.used_percent);
        const win = p.window_minutes ? Math.round(p.window_minutes / 60) + 'h window' : null;
        metrics.push({
          key: 'limit_primary', label: 'Quota left (primary)',
          value: left, display: `${left.toFixed(0)}%`,
          detail: [win, p.resets_at ? `resets ${fmtReset(p.resets_at)}` : null].filter(Boolean).join(' · ') || null,
        });
      }
      if (s && typeof s.used_percent === 'number') {
        const left = Math.max(0, 100 - s.used_percent);
        const win = s.window_minutes ? Math.round(s.window_minutes / 1440) + 'd window' : null;
        metrics.push({
          key: 'limit_secondary', label: 'Quota left (weekly)',
          value: left, display: `${left.toFixed(0)}%`,
          detail: [win, s.resets_at ? `resets ${fmtReset(s.resets_at)}` : null].filter(Boolean).join(' · ') || null,
        });
      }
    }

    return {
      source: 'codex',
      available: true,
      kind: latestRL ? 'quota' : 'consumed',
      note: latestRL
        ? `Live rate-limit snapshot${planType ? ` · plan: ${planType}` : ''}`
        : 'Token totals only; no rate-limit snapshot found',
      metrics,
    };
  });
}

// ---------------------------------------------------------------------------
// grok — per-session prompt/summary files. No cost and no API token-usage
// records, but each session's updates.jsonl carries a cumulative `totalTokens`
// (the running context-window size). We take the peak per session and sum.
// This is real local data, but it is context size, not billed usage — labelled
// honestly. We also surface session/message counts from summary.json files.
// ---------------------------------------------------------------------------
function grokUsage() {
  const root = path.join(HOME, '.grok', 'sessions');
  if (!fs.existsSync(root)) return { source: 'grok', available: false, note: 'No ~/.grok/sessions' };
  const updates = walk(root, (n) => n === 'updates.jsonl');
  const summaries = walk(root, (n) => n === 'summary.json');
  if (!updates.files.length && !summaries.files.length) {
    return { source: 'grok', available: false, note: 'No session data found' };
  }
  const newest = Math.max(updates.newest, summaries.newest);
  return memo('grok', `${newest}:${updates.files.length}:${summaries.files.length}`, () => {
    let peakTokenSum = 0;
    const re = /"totalTokens":(\d+)/g;
    for (const f of updates.files) {
      let max = 0;
      let data;
      try { data = fs.readFileSync(f, 'utf8'); } catch { continue; }
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(data))) { const v = +m[1]; if (v > max) max = v; }
      peakTokenSum += max;
    }
    let sessions = 0, chatMsgs = 0;
    for (const f of summaries.files) {
      let o; try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      sessions++;
      chatMsgs += o.num_chat_messages || o.num_messages || 0;
    }
    const metrics = [];
    if (peakTokenSum > 0) {
      metrics.push({
        key: 'tokens', label: 'Context tokens (peak/session)', value: peakTokenSum,
        display: fmtTokens(peakTokenSum),
        detail: 'Sum of each session’s peak context size, not billed tokens',
      });
    }
    if (sessions) metrics.push({ key: 'sessions', label: 'Sessions', value: sessions, display: fmtCount(sessions) });
    if (chatMsgs) metrics.push({ key: 'messages', label: 'Chat messages', value: chatMsgs, display: fmtCount(chatMsgs) });
    if (!metrics.length) return { source: 'grok', available: false, note: 'No usable counters in session files' };
    return {
      source: 'grok',
      available: true,
      kind: 'consumed',
      note: 'No cost or remaining-quota stored locally',
      metrics,
    };
  });
}

// ---------------------------------------------------------------------------
// cursor — no LLM token usage, but the local ai-tracking DB records how many
// AI-authored file edits / commits it has scored. We surface that as activity,
// clearly NOT token/quota usage.
// ---------------------------------------------------------------------------
function cursorUsage() {
  const dbPath = path.join(HOME, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
  let stat;
  try { stat = fs.statSync(dbPath); } catch {
    return { source: 'cursor', available: false, note: 'No local token/quota data' };
  }
  return memo('cursor', `${stat.mtimeMs}:${stat.size}`, () => {
    let db;
    try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch {
      return { source: 'cursor', available: false, note: 'No local token/quota data' };
    }
    let edits = 0, commits = 0, aiAdded = 0;
    try {
      edits = (db.prepare('SELECT count(*) c FROM ai_code_hashes').get() || {}).c || 0;
      const sc = db.prepare('SELECT count(*) c, sum(composerLinesAdded) a FROM scored_commits').get() || {};
      commits = sc.c || 0;
      aiAdded = sc.a || 0;
    } catch {
      try { db.close(); } catch {}
      return { source: 'cursor', available: false, note: 'No local token/quota data' };
    }
    try { db.close(); } catch {}
    if (!edits && !commits) return { source: 'cursor', available: false, note: 'No local token/quota data' };
    return {
      source: 'cursor',
      available: true,
      kind: 'activity',
      note: 'Cursor stores no token/cost/quota locally — only AI-edit tracking',
      metrics: [
        { key: 'edits', label: 'AI-tracked edits', value: edits, display: fmtCount(edits) },
        { key: 'commits', label: 'Scored commits', value: commits, display: fmtCount(commits),
          detail: aiAdded ? `${fmtCount(aiAdded)} AI lines added` : null },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// gemini — confirmed: no local token, cost, or quota data.
// ---------------------------------------------------------------------------
function geminiUsage() {
  return { source: 'gemini', available: false, note: 'Gemini CLI stores no local usage/quota data' };
}

// ---------------------------------------------------------------------------
const SOURCES = [
  opencodeUsage, claudeUsage, codexUsage, grokUsage, cursorUsage, geminiUsage,
];

export async function getUsage() {
  const out = [];
  for (const fn of SOURCES) {
    try { out.push(fn()); }
    catch (e) {
      // Never let one tool take the whole endpoint down.
      out.push({ source: fn.name.replace(/Usage$/, ''), available: false, note: `Error: ${e.message}` });
    }
  }
  return out;
}
