// Canonical Claude session identity + bundle resolution (ADR-0017, loops F1/F2).
//
// A Claude session is logically { source: 'claude', projectSlug, sessionId },
// independent of which physical artifacts survive under
// ~/.claude/projects/<projectSlug>/:
//   <sessionId>.jsonl            main transcript (may be deleted by cleanup)
//   <sessionId>/subagents/*.jsonl subagent sidechains (middle-era companion)
//   sessions-index.json           per-project index with session metadata
//
// This module owns identity encoding and artifact resolution ONLY. It performs
// no event parsing — the 1B converter (subagents/history/folder-only) is gated
// on this contract landing first (ADR-0012). ~/.claude/history.jsonl is never
// read here: it must not participate in listing caches (ADR-0017).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside } from './_shared.js';

// Captured at import time, like claude.js — tests that stage a fake HOME must
// run adapter code in a child process (see scripts/smoke-test.mjs).
export const ROOT = path.join(os.homedir(), '.claude', 'projects');

// ---- opaque versioned refs (Claude only — ADR-0017's deliberate asymmetry) --
//
// `v1:<projectSlug>:<sessionId>`. "Opaque" per the ADR means treat-as-token and
// never a caller-controlled filesystem path — the scheme prefix is the
// discriminator that lets consumers dispatch opaque-vs-path without sniffing.
// The part charset has no `/`, `\`, `:` or NUL, so no traversal is expressible
// and `:` is an unambiguous separator; `.`/`..` pass the charset and are
// rejected explicitly. Every existing local slug/session id fits this charset
// (verified 2026-07-07); a hypothetical future name outside it fails CLOSED
// (unreachable via opaque ref), never open.
const REF_SCHEME = 'v1';
const PART_RE = /^[A-Za-z0-9._-]+$/;

function validPart(s) {
  return typeof s === 'string' && s !== '.' && s !== '..' && PART_RE.test(s);
}

export function encodeClaudeRef({ projectSlug, sessionId }) {
  if (!validPart(projectSlug) || !validPart(sessionId)) {
    throw new Error(`unencodable claude identity: ${projectSlug}:${sessionId}`);
  }
  return `${REF_SCHEME}:${projectSlug}:${sessionId}`;
}

// → { projectSlug, sessionId } or null (not an opaque ref / malformed).
// Strict fail-closed validation; callers fall back to path-ref handling on null.
export function decodeClaudeRef(ref) {
  if (typeof ref !== 'string') return null;
  const parts = ref.split(':');
  if (parts.length !== 3 || parts[0] !== REF_SCHEME) return null;
  if (!validPart(parts[1]) || !validPart(parts[2])) return null;
  return { projectSlug: parts[1], sessionId: parts[2] };
}

// ---- sessions-index.json map (one parse per project, shared by all callers) --

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Cache signature for the index FILE itself: missing/unreadable state, mtime,
// and size (mtime alone misses rapid rewrite/delete edges — a vanished index
// must evict the cached map, not leave stale index-only cards).
function indexFileSig(stat) {
  return stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
}

const indexMapCache = new Map(); // projectDir -> { sig, map }

// Map(sessionId → first matching entry) for a project's sessions-index.json.
// First occurrence wins, mirroring Python load_session_index's first-match
// scan. NO isSidechain filtering here — Python has none, and filtering at
// lookup time would move export-header parity; discovery (list candidates)
// applies its own isSidechain exclusion. Missing/unparseable/structurally
// invalid index → empty map (same tolerance-divergence note as before: Python
// crashes on a non-dict root/entries; error-path only, never rendered bytes).
export async function loadProjectIndexMap(projectDir) {
  const sig = indexFileSig(statOrNull(path.join(projectDir, 'sessions-index.json')));
  const hit = indexMapCache.get(projectDir);
  if (hit && hit.sig === sig) return hit.map;
  const map = new Map();
  let data;
  let finalSig = sig;
  try {
    data = JSON.parse(await fs.promises.readFile(path.join(projectDir, 'sessions-index.json'), 'utf-8'));
  } catch (e) {
    data = null;
    // Existing-but-unreadable files must not cache under the same signature as a
    // successful parse; chmod-only recovery may leave mtime/size unchanged.
    if (sig !== 'missing' && e?.code !== 'ENOENT') finalSig = `${sig}:unreadable:${e?.code || 'error'}`;
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.entries)) {
    for (const e of data.entries) {
      if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.sessionId === 'string' && !map.has(e.sessionId)) {
        map.set(e.sessionId, e);
      }
    }
  }
  indexMapCache.set(projectDir, { sig: finalSig, map });
  return map;
}

// Port of load_session_index (extract-session.py): first entry whose sessionId
// matches, else null. Semantics unchanged since F1 (claude.js collectEvents
// still calls this for ADR-0015 header enrichment); now a lookup through the
// cached per-project map.
export async function loadSessionIndex(projectDir, sessionId) {
  return (await loadProjectIndexMap(projectDir)).get(sessionId) ?? null;
}

// ---- bundle resolution -------------------------------------------------------

// Composite invalidation signature over every artifact that shapes the bundle:
// `<path-relative-to-ROOT>@<mtimeMs>:<size>` per artifact, sorted, `|`-joined.
// A bundle changes when ANY artifact changes, so scalar main-transcript mtime
// is not enough once subagents/index participate.
//
// F2 consumer contract (F1-pinned, now live): makeEntry carries
// `cacheSignature: string|null` (null for every non-bundle adapter); `mtimeMs`
// stays numeric and remains the sort key; server/search.js invalidates on
// `entrySignature(c)` = `c.cacheSignature ?? c.mtimeMs`. The
// sessions-index.json stat is per-FILE, not per-entry — any session's index
// update invalidates every bundle in the slug; accepted, re-parses are cheap
// and mtime-bounded.
function buildSignature(rootRelParts) {
  return rootRelParts
    .map(({ rel, stat }) => `${rel}@${stat.mtimeMs}:${stat.size}`)
    .sort()
    .join('|');
}

// Shared assembly for both the single-identity and batched paths (one source
// of truth, per ADR-0017 "shared resolver"). `indexMeta` is the preloaded
// map lookup for this sessionId (or null).
//
// Replayable-existence rule: null unless mainPath, at least one subagent, or a
// matching index entry exists. A bare companion folder with none of those is
// "nothing to replay" (extract-session.py:199's exit), NOT a bundle — and the
// same rule filters non-session directories (e.g. <slug>/memory/) out of
// batched discovery for free.
function assembleBundle(projectDir, projectSlug, sessionId, indexMeta) {
  const sigParts = [];
  const track = (p) => {
    const stat = statOrNull(p);
    if (stat) sigParts.push({ rel: path.relative(ROOT, p), stat });
    return stat;
  };

  const mainCandidate = path.join(projectDir, `${sessionId}.jsonl`);
  const mainStat = track(mainCandidate);
  const mainPath = mainStat && mainStat.isFile() ? mainCandidate : null;

  const folderCandidate = path.join(projectDir, sessionId);
  const folderStat = statOrNull(folderCandidate); // dir itself is not a content artifact
  const folderPath = folderStat && folderStat.isDirectory() ? folderCandidate : null;

  const subagentPaths = [];
  let newestSubagentMs = null;
  if (folderPath) {
    const subDir = path.join(folderPath, 'subagents');
    let names = [];
    try { names = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch { /* no subagents */ }
    names.sort(); // lexical order (ADR-0017; matches sorted(glob) in the reference)
    for (const name of names) {
      const p = path.join(subDir, name);
      if (!isInside(p, ROOT)) continue;
      const stat = track(p);
      if (stat?.isFile()) {
        subagentPaths.push(p);
        if (newestSubagentMs === null || stat.mtimeMs > newestSubagentMs) newestSubagentMs = stat.mtimeMs;
      }
    }
  }

  if (indexMeta) track(path.join(projectDir, 'sessions-index.json'));

  if (!mainPath && subagentPaths.length === 0 && !indexMeta) return null;
  return {
    identity: { source: 'claude', projectSlug, sessionId },
    mainPath,
    folderPath,
    subagentPaths,
    indexMeta,
    compositeSignature: buildSignature(sigParts),
    // Additive convenience for list(): artifact stats the assembly already
    // took, so callers don't re-stat. Not part of the ADR-0017 shape.
    stats: {
      main: mainStat && mainStat.isFile() ? { mtimeMs: mainStat.mtimeMs, size: mainStat.size, mtime: mainStat.mtime } : null,
      newestSubagentMs,
    },
  };
}

// Validate identity parts + containment before ANY fs access (ADR-0011 —
// the codec charset already forbids traversal; this is defense in depth,
// applied identically on the single and batched paths).
function containedProjectDir(projectSlug) {
  const projectDir = path.resolve(ROOT, projectSlug);
  return isInside(projectDir, ROOT) ? projectDir : null;
}

// Resolve a known identity to its surviving artifacts, mirroring
// extract-session.py's resolve_session directory-era logic (main+companion /
// folder-only / index-only). No prefix search — that is a CLI affordance.
export async function resolveBundle({ projectSlug, sessionId }) {
  if (!validPart(projectSlug) || !validPart(sessionId)) return null;
  const projectDir = containedProjectDir(projectSlug);
  if (!projectDir) return null;
  const indexMeta = (await loadProjectIndexMap(projectDir)).get(sessionId) ?? null;
  return assembleBundle(projectDir, projectSlug, sessionId, indexMeta);
}

// Batched resolution for list(): every identity in one project, from ONE
// readdir pass + ONE cached index parse. Candidates are `*.jsonl` stems,
// directory names, and non-sidechain index sessionIds; the replayable-
// existence rule inside assembleBundle discards decoys. A candidate whose
// name fails the codec charset is skipped with a warning (fail closed — it
// would be unreachable via opaque ref anyway; 0 such names locally).
export async function resolveProjectBundles(projectSlug) {
  const bundles = new Map();
  if (!validPart(projectSlug)) return bundles;
  const projectDir = containedProjectDir(projectSlug);
  if (!projectDir) return bundles;

  let dirents = [];
  try { dirents = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return bundles; }
  const indexMap = await loadProjectIndexMap(projectDir);

  const candidates = new Set();
  for (const d of dirents) {
    if (d.isFile() && d.name.endsWith('.jsonl')) candidates.add(d.name.slice(0, -'.jsonl'.length));
    else if (d.isDirectory()) candidates.add(d.name);
  }
  for (const [sessionId, entry] of indexMap) {
    if (!entry.isSidechain) candidates.add(sessionId); // sidechain legs are not top-level sessions
  }

  for (const sessionId of candidates) {
    if (!validPart(sessionId)) {
      console.warn(`[claude] skipping session with un-encodable id: ${projectSlug}/${sessionId}`);
      continue;
    }
    const bundle = assembleBundle(projectDir, projectSlug, sessionId, indexMap.get(sessionId) ?? null);
    if (bundle) bundles.set(sessionId, bundle);
  }
  return bundles;
}
