// Per-session context-health: how full is a session's context window, so the UI
// can hint whether resuming is worthwhile. See docs/plan-asm-context-health-2026-07-01.md.
//
// This module is deliberately DEPENDENCY-LIGHT and PURE: no filesystem, no
// node:sqlite, no imports from other server modules. It is the canonical home
// for all context math so both server/usage.js (all-time totals) and
// server/sources/claude.js (per-session badge) import from HERE — the adapter
// must never import server/usage.js, which eagerly loads DatabaseSync.

const FLOOR_200K = 200_000; // pre-2026-03-14 default, and still Haiku's window.
const ONE_M = 1_000_000;
// Claude Code's default context window became 1M on 2026-03-14 for every model
// except Haiku (Opus, Sonnet, Fable). Sessions whose last activity predates the
// cutover keep the old 200k assumption. See docs/adr-context-health-2026-07-06.md.
const ONE_M_DEFAULT_SINCE = '2026-03-14';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const int = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

// (1) Breakdown primitive — the ONE place the Claude usage field list lives.
// Returns the four components separately so callers can combine as they need
// (all-time totals sum all four; context occupancy sums all four for one
// message; the denominator uses only the three input terms).
export function parseClaudeUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  return {
    input: int(u.input_tokens),
    cacheCreate: int(u.cache_creation_input_tokens),
    cacheRead: int(u.cache_read_input_tokens),
    output: int(u.output_tokens),
  };
}

// (2) Final math + validation. Shared by the Codex path (called directly with
// reported numbers) and the Claude tracker. Returns null when there is no
// trustworthy numerator — the caller then renders NO badge (never a false 0%).
export function finalizeContextUsage(input) {
  // Guard against null/non-object args too — a `= {}` default only covers
  // `undefined`, so finalizeContextUsage(null) would otherwise throw on
  // destructuring, violating the "never throws; malformed ⇒ null" contract.
  if (!input || typeof input !== 'object') return null;
  const { usedTokens, windowTokens, model, measuredAt, basis, windowBasis, compactions } = input;
  // Contract: usedTokens must be a positive integer. A fractional value is
  // malformed input → null (not silently floored).
  if (!Number.isInteger(usedTokens) || usedTokens <= 0) return null;
  const used = usedTokens;

  let win = null;
  let percentLeft = null;
  if (Number.isFinite(windowTokens) && windowTokens > 0) {
    win = Math.floor(windowTokens);
    percentLeft = clamp(Math.round(100 * (1 - used / win)), 0, 100);
  }

  return {
    usedTokens: used,
    windowTokens: win,
    percentLeft,
    measuredAt: measuredAt || null,
    model: model || null,
    basis: basis === 'reported' ? 'reported' : 'estimated',
    windowBasis: windowBasis || null,
    compactions: Number.isFinite(compactions) && compactions > 0 ? Math.floor(compactions) : 0,
  };
}

// (3) Pure stateful reducer for Claude's streaming selection logic. Both the
// streaming adapter (live lines) and the smoke fixtures (hand-built record
// arrays) push parsed JSONL records through the SAME code path, so the
// interesting logic — skip <synthetic>/api_error, walk back to the latest valid
// message, exclude sidechains, track peak input side, count compactions once —
// is deterministic and unit-testable.
//
// `push(record)` takes one already-JSON.parsed transcript record, in file order.
// `finalize()` returns contextUsage | null.
export function createClaudeContextTracker() {
  let latest = null;       // { usedTokens, model, measuredAt } of the last eligible msg
  let peakInputSide = 0;   // max input-side over eligible msgs (denominator evidence)
  let compactBoundary = 0; // unique compact_boundary events
  let compactSummary = 0;  // isCompactSummary markers (fallback only)

  return {
    push(record) {
      if (!record || typeof record !== 'object') return;

      // Compaction markers. A single compaction emits BOTH a compact_boundary
      // event and an isCompactSummary record, so we prefer boundary events and
      // fall back to summaries only when no boundary is seen (count-once).
      if (record.subtype === 'compact_boundary') compactBoundary++;
      if (record.isCompactSummary === true) compactSummary++;

      if (record.type !== 'assistant' || record.isSidechain) return;
      const msg = record.message;
      if (!msg || typeof msg !== 'object') return;
      const model = msg.model;
      if (!model || model === '<synthetic>') return; // synthetic/error carry no real usage

      const u = parseClaudeUsage(msg.usage);
      const inputSide = u.input + u.cacheCreate + u.cacheRead;
      const used = inputSide + u.output; // Correction B: output IS part of resume footprint
      if (used <= 0) return; // zero-usage line — skip, keep the prior valid selection

      if (inputSide > peakInputSide) peakInputSide = inputSide;
      latest = { usedTokens: used, model, measuredAt: record.timestamp || null };
    },

    finalize() {
      if (!latest) return null;
      // Denominator precedence: (1) a peak input side above 200k PROVES a 1M
      // window ran at some point (any model, any date); (2) otherwise the model
      // default applies — 1M for non-Haiku sessions on/after the 2026-03-14
      // cutover, 200k for Haiku or pre-cutover sessions. measuredAt is a
      // Z-suffixed ISO string, so lexicographic comparison is date order; a
      // missing timestamp is treated as current (post-cutover).
      const observed1m = peakInputSide > FLOOR_200K;
      const isHaiku = /haiku/i.test(latest.model || '');
      const defaults1m = !isHaiku
        && (latest.measuredAt == null || latest.measuredAt >= ONE_M_DEFAULT_SINCE);
      return finalizeContextUsage({
        usedTokens: latest.usedTokens,
        windowTokens: observed1m || defaults1m ? ONE_M : FLOOR_200K,
        windowBasis: observed1m ? 'observed-1m' : defaults1m ? 'assumed-1m' : 'assumed-200k',
        model: latest.model,
        measuredAt: latest.measuredAt,
        basis: 'estimated',
        compactions: compactBoundary > 0 ? compactBoundary : compactSummary,
      });
    },
  };
}
