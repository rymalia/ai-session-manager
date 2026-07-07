// Versioned, source-agnostic starred-key storage (ADR-0017).
//
// Stars persist as `${source}:${ref}` keys. Refs are moving to versioned
// opaque encodings (Claude first, in F2), so the storage itself is versioned
// NOW — one migration, source-agnostic, never repeated: a future opaque-ref
// source bumps STORAGE_VERSION and adds a keys rewrite inside decodeStarred;
// rewrites run only when the stored version is LESS than the target, so a
// migration can never apply twice.
//
// Pure module (no localStorage access) so the smoke test exercises it
// hermetically, like exportOptions.js / sortConvos.js. App.jsx owns the
// getItem/setItem calls and ALL writes go through encodeStarred — the single
// save helper.
//
// Precedence: a valid `ccv.starred.v1` envelope always wins; the legacy bare
// array under `ccv.starred` is read only when the envelope is absent/invalid.
// The legacy key is left in place for one release (rollback safety; F2 may
// remove it). Malformed anything → empty list, never a throw.
export const STARRED_KEY = 'ccv.starred.v1';
export const LEGACY_STARRED_KEY = 'ccv.starred';
const STORAGE_VERSION = 1;

function parseKeys(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((k) => typeof k === 'string');
}

// (v1Raw, legacyRaw) → { keys, needsWrite }. `needsWrite` is true when no
// valid envelope exists yet — the caller persists the migrated envelope once,
// after which subsequent loads see a valid envelope and never rewrite.
export function decodeStarred(v1Raw, legacyRaw) {
  try {
    const env = JSON.parse(v1Raw);
    if (env && typeof env === 'object' && !Array.isArray(env) && env.version === STORAGE_VERSION) {
      const keys = parseKeys(env.keys);
      if (keys) return { keys, needsWrite: false };
    }
  } catch { /* fall through to legacy */ }
  let legacy = null;
  try { legacy = parseKeys(JSON.parse(legacyRaw)); } catch { /* malformed legacy */ }
  return { keys: legacy || [], needsWrite: true };
}

// The single serializer for every starred write.
export function encodeStarred(keys) {
  return JSON.stringify({ version: STORAGE_VERSION, keys: [...keys] });
}
