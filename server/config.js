// ASM's only user configuration (B6). ASM **reads** this file and never writes
// it, so the no-write invariant is unchanged: the blocklist is authored by hand.
//
//   ~/.config/ai-session-manager/config.json      (override with $ASM_CONFIG)
//   { "blocklist": ["/Users/me/.claude-mem/observer-sessions", "~/scratch"] }
//
// A blocklist entry hides every session whose `projectPath` is that directory or
// a directory beneath it — from the list, the project dropdown, search, the
// Stats panels, the Agents conversation counts, and the Usage totals.
//
// Matching is PREFIX-only, through the same `isInside()` containment helper the
// adapters use for security. That precision is the whole point of the feature:
// `/Users/me/.claude-mem/observer-sessions` (machine-generated) and
// `/Users/me/projects/claude-mem` (real work) must not share a fate, and a
// sibling that merely shares a textual prefix (`…/observer-sessions-2`) must
// never be swept up. Name substrings are never matched — only whole path
// segments, and never `projectLabel`.
//
// Everything here FAILS OPEN: an absent, unreadable, malformed, or partially
// invalid config yields an empty (or shorter) blocklist. A configuration
// mistake can therefore only ever show too much, never silently hide real work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from './sources/_shared.js';

const HOME = os.homedir();

export const DEFAULT_CONFIG_PATH = path.join(HOME, '.config', 'ai-session-manager', 'config.json');

// Read from the env on every call (not once at import) so tests can point at a
// fixture without re-importing the module.
export function configPath() {
  return process.env.ASM_CONFIG || DEFAULT_CONFIG_PATH;
}

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// Warn once per distinct message, so a bad config doesn't spam the console on
// every list refresh (the file is re-read whenever it changes). `key` lets a
// caller re-warn after the config changes even when the text is identical.
const warned = new Set();
function warnOnce(msg, key = msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[config] ${msg}`);
}

function normalizeBlocklist(raw, file) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnOnce(`${file}: "blocklist" must be an array — ignoring it`);
    return [];
  }
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      warnOnce(`${file}: blocklist entries must be strings — ignoring ${JSON.stringify(entry)}`);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed);
    // Reject relative entries rather than resolving them: `path.resolve` would
    // silently anchor them to the server's cwd, which is not a path the user
    // could have meant.
    if (!path.isAbsolute(expanded)) {
      warnOnce(`${file}: blocklist entries must be absolute paths (or start with ~) — ignoring "${entry}"`);
      continue;
    }
    const abs = path.resolve(expanded); // normalizes . / .. and strips a trailing slash
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

// mtime+size-keyed cache: editing the config and hitting Refresh in the UI takes
// effect without restarting the server (server/*.js changes still need one).
let cached = { sig: null, value: null };

export function loadConfig() {
  const file = configPath();
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* absent → zero-config, the default */ }
  const sig = stat ? `${file}:${stat.mtimeMs}:${stat.size}` : `${file}:absent`;
  if (cached.sig === sig) return cached.value;

  let value = { path: file, present: false, blocklist: [] };
  if (stat) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      warnOnce(`${file}: could not be read as JSON (${e.message}) — continuing with no blocklist`);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = { path: file, present: true, blocklist: normalizeBlocklist(parsed.blocklist, file) };
    } else if (parsed != null) {
      warnOnce(`${file}: top level must be a JSON object — continuing with no blocklist`);
      value = { path: file, present: true, blocklist: [] };
    } else {
      value = { path: file, present: true, blocklist: [] };
    }
  }
  cached = { sig, value };
  return value;
}

export function blocklist() {
  return loadConfig().blocklist;
}

// Fast path for callers that would otherwise pay to derive a project path
// (server/usage.js probes transcripts for their cwd only when this is true).
export function hasBlocklist() {
  return loadConfig().blocklist.length > 0;
}

// Cache key for anything memoized over blocked-ness, so editing the config
// invalidates derived results (server/usage.js memoizes token totals).
export function blocklistSignature() {
  const list = loadConfig().blocklist;
  return list.length ? list.join('\n') : 'none';
}

// ---------------------------------------------------------------------------
// audit: rules that match nothing
// ---------------------------------------------------------------------------
// A blocklist entry that matches nothing is indistinguishable from one that
// works — the list just looks the same. The overwhelmingly likely cause is
// naming a CLI's *storage* directory (where the transcript file lives) instead
// of the project directory you worked IN, which is what `projectPath` records.
// Those two look equally plausible from the outside, so they are named here.
const STORAGE_ROOTS = [
  { rel: '.claude/projects', tool: 'Claude Code', slugged: true },
  { rel: '.codex/sessions', tool: 'Codex', dated: true },
  { rel: '.grok/sessions', tool: 'Grok' },
  { rel: '.kimi-code', tool: 'Kimi Code' },
  { rel: '.cursor', tool: 'Cursor' },
  { rel: '.gemini/tmp', tool: 'Gemini CLI' },
  { rel: '.copilot', tool: 'GitHub Copilot CLI' },
  { rel: '.local/share/goose/sessions', tool: 'Goose' },
  { rel: '.local/share/opencode', tool: 'opencode' },
  { rel: '.factory', tool: 'Droid' },
];

// Claude names each project directory after the cwd, with every non-alphanumeric
// character collapsed to '-'. Encoding the KNOWN project paths and comparing is
// exact; decoding the slug is not (every '-' would become '/'), which is the
// same ambiguity that stops server/usage.js from trusting slugs.
const claudeSlug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function storageHint(entry, knownPaths) {
  for (const s of STORAGE_ROOTS) {
    const root = path.join(HOME, ...s.rel.split('/'));
    if (!isInside(entry, root) || entry === root) continue;
    let hint = `${s.tool}'s transcript storage, not a project directory.`
      + ' Entries match the directory you worked IN (the session\'s cwd)';
    if (s.slugged) {
      const slug = path.basename(entry);
      const match = knownPaths.find((p) => claudeSlug(p) === slug);
      if (match) hint += `. Did you mean "${match}"?`;
    }
    if (s.dated) {
      hint += '. Codex files rollouts by DATE, so this folder spans several'
        + ' projects and has no single project path';
    }
    return hint;
  }
  return null;
}

// Per-entry match counts against the live (unfiltered) project paths. Pure, so
// the reporting rules can be fixture-tested without a console.
export function auditBlocklist(projectPaths) {
  const list = loadConfig().blocklist;
  if (!list.length) return [];
  const counts = new Map(); // projectPath -> sessions
  for (const p of projectPaths) {
    if (p && typeof p === 'string') counts.set(p, (counts.get(p) || 0) + 1);
  }
  const known = [...counts.keys()];
  return list.map((entry) => {
    let sessions = 0, projects = 0;
    for (const [p, n] of counts) {
      if (!path.isAbsolute(p) || !isInside(path.resolve(p), entry)) continue;
      sessions += n;
      projects += 1;
    }
    return {
      entry,
      sessions,
      projects,
      hint: sessions === 0 ? storageHint(entry, known) : null,
    };
  });
}

// Warn about entries that hid nothing. Re-warns after the config changes (the
// signature is part of the dedupe key) but stays quiet across plain refreshes.
export function reportBlocklist(projectPaths) {
  const sig = blocklistSignature();
  for (const r of auditBlocklist(projectPaths)) {
    if (r.sessions > 0) continue;
    const why = r.hint ? ` — ${r.hint}` : '';
    warnOnce(`blocklist entry matched no sessions: "${r.entry}"${why}`, `${sig}::${r.entry}`);
  }
}

// True when `p` is inside (or is) a blocked directory. Non-absolute and empty
// paths are never blocked — an adapter that could not determine a cwd must not
// be hidden by guesswork.
export function isBlockedPath(p) {
  const list = loadConfig().blocklist;
  if (!list.length) return false;
  if (!p || typeof p !== 'string') return false;
  if (!path.isAbsolute(p)) return false;
  const abs = path.resolve(p);
  return list.some((b) => isInside(abs, b));
}
