// Versioned, source-agnostic starred-key storage (ADR-0017).
//
// Stars persist as `${source}:${ref}` keys. Refs move to versioned opaque
// encodings per source (Claude first, F2), so the storage is versioned: one
// migration per envelope-version bump, never repeated — a rewrite runs only
// when the stored version is LESS than STORAGE_VERSION, and a future
// opaque-ref source bumps the version and rewrites only its own keys.
//
// Version history:
//   (pre-envelope)  bare JSON array under `ccv.starred`
//   1               envelope { version: 1, keys } — path-based Claude keys
//   2 (current, F2) Claude keys rewritten `claude:<abs path>.jsonl` →
//                   `claude:v1:<slug>:<id>` to match list()'s opaque refs
//
// STORAGE KEY: `ccv.starred.v1` is the PERMANENT key — the `v1` names the
// envelope format family, not the migration state; the envelope's `version`
// field tracks migrations. Never mint a per-version key (it would orphan
// older envelopes).
//
// Pure module (no localStorage access) so the smoke test exercises it
// hermetically, like exportOptions.js / sortConvos.js. App.jsx owns the
// getItem/setItem calls and ALL writes go through encodeStarred — the single
// save helper.
//
// Precedence: a valid `ccv.starred.v1` envelope always wins; the legacy bare
// array under `ccv.starred` is read only when the envelope is absent/invalid
// (a bare array is pre-envelope v1-equivalent: same path-key rewrite applies).
// The legacy key is left in place for one release (rollback safety).
// Malformed anything → empty list, never a throw.
export const STARRED_KEY = 'ccv.starred.v1';
export const LEGACY_STARRED_KEY = 'ccv.starred';
const STORAGE_VERSION = 2;

// Mirror of the opaque-ref part rules in server/sources/claudeBundle.js
// (server module — imports node:fs/os, so it cannot be bundled for the
// browser; keep the two regexes in sync).
const PART_RE = /^[A-Za-z0-9._-]+$/;
const validPart = (s) => typeof s === 'string' && s !== '.' && s !== '..' && PART_RE.test(s);

// v1 → v2: rewrite a path-based Claude star key to the opaque-ref key that
// F2's list() now emits: `claude:/…/projects/<slug>/<id>.jsonl` →
// `claude:v1:<slug>:<id>` (the path's last two segments; ROOT is unknowable
// client-side but keys were only ever produced by this app from real refs).
// Anything non-conforming — non-claude source, already-opaque, no .jsonl,
// segments outside the codec charset — passes through unchanged: an
// unrewritten key harmlessly never matches a card, exactly like any stale
// star. There is no security surface here; keys are only compared.
function rewriteClaudeKey(key) {
  if (typeof key !== 'string' || !key.startsWith('claude:') || !key.endsWith('.jsonl')) return key;
  const segs = key.slice('claude:'.length, -'.jsonl'.length).split('/');
  if (segs.length < 2) return key;
  const slug = segs[segs.length - 2];
  const id = segs[segs.length - 1];
  if (!validPart(slug) || !validPart(id)) return key;
  return `claude:v1:${slug}:${id}`;
}

function parseKeys(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((k) => typeof k === 'string');
}

// (v1Raw, legacyRaw) → { keys, needsWrite }. `needsWrite` is true whenever the
// stored state is not a current-version envelope — the caller persists the
// migrated envelope once, after which subsequent loads see version 2 and
// never rewrite (mechanically one-shot: rewrites run only for version <
// STORAGE_VERSION).
export function decodeStarred(v1Raw, legacyRaw) {
  try {
    const env = JSON.parse(v1Raw);
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const keys = parseKeys(env.keys);
      if (keys) {
        if (env.version === STORAGE_VERSION) return { keys, needsWrite: false };
        if (env.version === 1) return { keys: keys.map(rewriteClaudeKey), needsWrite: true };
        // Unknown/future version → fall through to legacy (fail closed).
      }
    }
  } catch { /* fall through to legacy */ }
  let legacy = null;
  try { legacy = parseKeys(JSON.parse(legacyRaw)); } catch { /* malformed legacy */ }
  return { keys: (legacy || []).map(rewriteClaudeKey), needsWrite: true };
}

// The single serializer for every starred write.
export function encodeStarred(keys) {
  return JSON.stringify({ version: STORAGE_VERSION, keys: [...keys] });
}
