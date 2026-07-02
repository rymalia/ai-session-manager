// Pure, React-free export-option logic shared by src/ExportMenu.jsx and
// scripts/smoke-test.mjs. Living here (not inside the component) lets the smoke
// test enforce the two promises the UI makes: (1) persisted options are always
// schema-validated before use, and (2) the built query can NEVER contain an
// option the source does not support — so the UI can never trigger /api/export's
// explicit-unavailable 400 (ADR-0013 capabilities, ADR-0014 option pipeline,
// ADR-0016 delivery). No DOM/React imports — keep it importable from Node.

export const CONTENT_FLAGS = ['tools', 'toolResults', 'thinking', 'sidechains', 'verbatim', 'raw', 'embedImages'];

// `full` expands (server-side) to these four; when full is on the UI omits them
// from the query so the endpoint derives the canonical `full` filename token.
export const FULL_IMPLIES = ['tools', 'toolResults', 'thinking', 'sidechains'];

export const MAXCHARS_MIN = 1;
export const MAXCHARS_MAX = 20000;
export const MAXCHARS_DEFAULT = 400;
const HISTORY_VALUES = ['auto', 'on', 'off'];

// Defaults mirror /replay: every content filter off, history auto, maxChars 400.
export const DEFAULT_EXPORT_OPTS = {
  full: false,
  tools: false,
  toolResults: false,
  thinking: false,
  sidechains: false,
  verbatim: false,
  raw: false,
  embedImages: false,
  history: 'auto', // 'auto' | 'on' | 'off'
  maxChars: MAXCHARS_DEFAULT,
};

export function clampMaxChars(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return MAXCHARS_DEFAULT;
  return Math.min(MAXCHARS_MAX, Math.max(MAXCHARS_MIN, n));
}

// Coerce arbitrary stored/user input into a valid options object. The root must
// be a plain non-null, non-array object; anything else (null, string, array,
// number) falls back to defaults rather than reaching property access. Unknown
// keys are dropped; every known key is type-checked.
export function normalizeExportOpts(raw) {
  const out = { ...DEFAULT_EXPORT_OPTS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.full = raw.full === true;
  for (const k of CONTENT_FLAGS) out[k] = raw[k] === true;
  out.history = HISTORY_VALUES.includes(raw.history) ? raw.history : 'auto';
  out.maxChars = clampMaxChars(raw.maxChars);
  return out;
}

// Capability lookup, fail-closed: a missing map or unknown value is treated as
// NOT supported (ADR-0013 "missing/unknown fail closed").
export function isSupported(capabilities, key) {
  return !!capabilities && capabilities[key] === 'supported';
}

// Build the /api/export query from normalized opts, capability-filtered so the
// UI can never send an option the source doesn't support (which would 400):
//   - `full` is capability-exempt (a render directive): when on, send full=1 and
//     OMIT its four constituents — the endpoint expands them and derives the
//     `full` filename token (ADR-0014).
//   - each individual content flag is sent only if enabled AND supported.
//   - history is sent only if supported AND not 'auto' (auto = default → omit,
//     and the server resolves auto→off when unsupported anyway).
//   - maxChars is sent only when != 400 (the server default) to keep URLs clean.
// Every value goes through URLSearchParams, so a ref containing & + # spaces or
// Unicode is encoded correctly.
export function buildExportQuery({ source, ref, opts, capabilities, download = false }) {
  const o = normalizeExportOpts(opts);
  const p = new URLSearchParams();
  p.set('source', source);
  p.set('ref', ref);

  if (o.full) {
    p.set('full', '1');
  } else {
    for (const k of FULL_IMPLIES) {
      if (o[k] && isSupported(capabilities, k)) p.set(k, '1');
    }
  }
  for (const k of ['verbatim', 'raw', 'embedImages']) {
    if (o[k] && isSupported(capabilities, k)) p.set(k, '1');
  }
  if (o.history !== 'auto' && isSupported(capabilities, 'history')) {
    p.set('history', o.history);
  }
  if (o.maxChars !== MAXCHARS_DEFAULT) p.set('maxChars', String(o.maxChars));
  if (download) p.set('download', '1');
  return p.toString();
}
