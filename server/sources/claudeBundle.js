// Canonical Claude session identity + bundle resolution (ADR-0017, loop F1).
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
// on this contract landing first (ADR-0012).
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

// ---- sessions-index.json lookup (moved verbatim from claude.js) -------------
//
// Port of load_session_index (extract-session.py): read sessions-index.json
// in the project dir and return the first entry whose sessionId matches, else
// null. Missing/unreadable/unparseable file → null (Python catches
// JSONDecodeError/OSError). One deliberate error-path divergence: Python
// raises an uncaught AttributeError on a structurally invalid index (non-dict
// root, non-dict entries); we treat those as "no index". Tolerance only — it
// never changes rendered bytes, so it is a code-level note, not an ADR-0009
// enumerated exception (that list covers rendered-output divergences).
export async function loadSessionIndex(projectDir, sessionId) {
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(path.join(projectDir, 'sessions-index.json'), 'utf-8'));
  } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) return null;
  for (const e of data.entries) {
    if (e && typeof e === 'object' && !Array.isArray(e) && e.sessionId === sessionId) return e;
  }
  return null;
}

// ---- bundle resolution -------------------------------------------------------

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Composite invalidation signature over every artifact that shapes the bundle:
// `<path-relative-to-ROOT>@<mtimeMs>:<size>` per artifact, sorted, `|`-joined.
// A bundle changes when ANY artifact changes, so scalar main-transcript mtime
// is not enough once subagents/index participate.
//
// F2 consumer contract (pinned here so F2 cannot redefine the shape): makeEntry
// gains an optional `cacheSignature: string|null` (null for every non-bundle
// adapter); `mtimeMs` stays numeric and remains the sort key; server/search.js
// and the Claude list cache invalidate on `c.cacheSignature ?? c.mtimeMs`.
// Unconsumed in F1 by design. The sessions-index.json stat is per-FILE, not
// per-entry — any session's index update invalidates every bundle in the slug;
// accepted, re-parses are cheap and mtime-bounded.
function buildSignature(rootRelParts) {
  return rootRelParts
    .map(({ rel, stat }) => `${rel}@${stat.mtimeMs}:${stat.size}`)
    .sort()
    .join('|');
}

// Resolve a known identity to its surviving artifacts, mirroring
// extract-session.py's resolve_session directory-era logic (main+companion /
// folder-only / index-only). No prefix search — that is a CLI affordance.
//
// Replayable-existence rule: null unless mainPath, at least one subagent, or a
// matching index entry exists. A bare companion folder with none of those is
// "nothing to replay" (extract-session.py's exit), NOT a bundle — folderPath
// alone never counts.
export async function resolveBundle({ projectSlug, sessionId }) {
  if (!validPart(projectSlug) || !validPart(sessionId)) return null;
  const projectDir = path.resolve(ROOT, projectSlug);
  // Defense in depth (ADR-0011): the charset already forbids traversal, but
  // every derived path is still containment-checked before any fs access.
  if (!isInside(projectDir, ROOT)) return null;

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

  let subagentPaths = [];
  if (folderPath) {
    const subDir = path.join(folderPath, 'subagents');
    let names = [];
    try { names = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch { /* no subagents */ }
    names.sort(); // lexical order (ADR-0017; matches sorted(glob) in the reference)
    for (const name of names) {
      const p = path.join(subDir, name);
      if (!isInside(p, ROOT)) continue;
      if (track(p)?.isFile()) subagentPaths.push(p);
    }
  }

  const indexMeta = await loadSessionIndex(projectDir, sessionId);
  if (indexMeta) track(path.join(projectDir, 'sessions-index.json'));

  if (!mainPath && subagentPaths.length === 0 && !indexMeta) return null;
  return {
    identity: { source: 'claude', projectSlug, sessionId },
    mainPath,
    folderPath,
    subagentPaths,
    indexMeta,
    compositeSignature: buildSignature(sigParts),
  };
}
