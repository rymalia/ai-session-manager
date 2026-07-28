// Friendly display names for model identifiers (B2). PRESENTATION ONLY — the
// API deliberately reports raw ids (`model` / `effort` in makeEntry), the same
// honesty rule server/usage.js follows. This module is pure and React-free so
// it can be fixture-tested from scripts/smoke-test.mjs, matching the existing
// src/ shared-module pattern (exportOptions.js, sortConvos.js, starred.js).

// Anthropic ids are structured — `claude-<family>-<major>[-<minor>][-<date>]`
// — so B2's friendly names come from a RULE rather than a lookup table. A table
// goes stale on every release (`claude-opus-6` would render as a raw id the day
// it ships); the rule degrades gracefully instead. Anything the rule doesn't
// recognise passes through RAW, so a new vendor's id shows as `gpt-5.7-x`,
// never as a blank badge.
// The trailing release datestamp is stripped FIRST rather than as an optional
// group, because a greedy `(\d+(?:-\d+)*)` version group happily swallows it —
// which rendered `claude-haiku-4-5-20251001` as "Haiku 4.5.20251001".
const DATESTAMP = /-\d{8}(?=$|\[)/;
const CLAUDE_ID = /^claude-([a-z]+)-(\d+(?:-\d+)*)(\[[^\]]*\])?$/;

// Families we're willing to title-case. An unrecognised family passes through
// raw rather than guessing at capitalisation for a name we've never seen.
const FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

export function modelLabel(model) {
  if (typeof model !== 'string') return null;
  const raw = model.trim();
  if (!raw) return null;
  // '<synthetic>' is a placeholder Claude Code writes for non-model turns; the
  // adapters already suppress it, but never label it if one slips through.
  if (raw === '<synthetic>') return null;

  const m = CLAUDE_ID.exec(raw.replace(DATESTAMP, ''));
  if (!m) return raw; // unknown vendor/shape → raw passthrough
  const [, family, version, variant = ''] = m;
  if (!FAMILIES.has(family)) return raw;
  const name = family[0].toUpperCase() + family.slice(1);
  // '4-8' → '4.8'; the optional trailing datestamp is dropped by the regex.
  return `${name} ${version.split('-').join('.')}${variant ? ` ${variant}` : ''}`;
}

// → { text, title } for the card badge, or null when there is nothing to show.
// `effort` only ever decorates a model — effort with no model would be a broken
// pair (see the makeEntry contract), so it yields no badge rather than a
// context-free 'high'.
export function modelBadge(model, effort) {
  const label = modelLabel(model);
  if (!label) return null;
  const eff = typeof effort === 'string' && effort.trim() ? effort.trim() : null;
  return {
    text: eff ? `${label} ${eff}` : label,
    // The tooltip is where the un-prettified truth lives, so a friendly name can
    // never hide which model actually ran.
    title: eff ? `${model} · effort: ${eff}` : String(model),
  };
}
