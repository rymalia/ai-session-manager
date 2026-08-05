// Registry: every conversation source plugs in here. Adding a new tool is a
// matter of writing one adapter ({ source, list, detail }) and listing it below.
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as grok from './grok.js';
import * as opencode from './opencode.js';
import * as cursor from './cursor.js';
import * as gemini from './gemini.js';
import * as copilot from './copilot.js';
import * as goose from './goose.js';
import * as droid from './droid.js';
import * as kimi from './kimi.js';
import * as antigravity from './antigravity.js';
import { SOURCE_META } from './_shared.js';
import { isBlockedPath, hasBlocklist, reportBlocklist } from '../config.js';

export { SOURCE_META };

const ADAPTERS = { claude, codex, grok, opencode, cursor, gemini, copilot, goose, droid, kimi, antigravity };

// Merge every source into one list, newest first. A failing source is skipped
// (with a warning) rather than taking the whole response down.
// Concurrent callers share one in-flight scan (the browser fires
// /api/conversations and /api/search together; both walk the same trees).
let inFlight = null;
export function listConversations() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const results = await Promise.all(
      Object.entries(ADAPTERS).map(async ([name, a]) => {
        try { return await a.list(); }
        catch (e) { console.warn(`[sources] ${name} list failed:`, e.message); return []; }
      })
    );
    // B6: blocked projects are dropped at the single choke point every consumer
    // shares, so the list endpoint, server/search.js, the client-side Stats
    // panels and the Agents conversation counts can never disagree about what
    // exists. Filtering here (not per adapter) is also what keeps the rule
    // source-agnostic — it matches on the normalized `projectPath`.
    const raw = results.flat();
    // A rule that matches nothing looks exactly like one that works, so say so
    // (once per config version) while the unfiltered set is still in hand.
    if (hasBlocklist()) reportBlocklist(raw.map((c) => c.projectPath));
    const all = raw.filter((c) => !isBlockedPath(c.projectPath));
    all.sort((a, b) => {
      const ta = a.lastActivity ? Date.parse(a.lastActivity) : a.mtimeMs;
      const tb = b.lastActivity ? Date.parse(b.lastActivity) : b.mtimeMs;
      return (tb || 0) - (ta || 0);
    });
    return all;
  })();
  return inFlight.finally(() => { inFlight = null; });
}

export async function getConversation(sourceName, ref, lastN = 30) {
  const a = ADAPTERS[sourceName];
  if (!a) throw new Error('unknown source');
  const d = await a.detail(ref, lastN);
  // A blocked project is invisible to the whole system, not just to the list: a
  // ref bookmarked (or starred) before the rule was added must not still open.
  // 'forbidden' → 403, the same mapping the containment failures already use.
  if (d && isBlockedPath(d.projectPath)) throw new Error('forbidden');
  return d;
}

// ---- markdown export (full-fidelity /replay parity) -------------------------
// Export-capable adapters additionally export collectEvents(ref, opts). Adapters
// without it are simply not export-capable (the UI hides the button for them).
const EXPORTERS = Object.fromEntries(
  Object.entries(ADAPTERS).filter(([, a]) => typeof a.collectEvents === 'function')
);

export function exportCapableSources() { return Object.keys(EXPORTERS); }

// Phase-accurate export capability map for a source (ADR-0013), or null if the
// source is not export-capable. Object.hasOwn mirrors collectEvents' dispatch guard
// so prototype names never resolve to an inherited property.
export function exportCapabilities(sourceName) {
  if (!Object.hasOwn(EXPORTERS, sourceName)) return null;
  return EXPORTERS[sourceName].exportCapabilities || null;
}

export async function collectEvents(sourceName, ref, opts) {
  // Object.hasOwn (not `EXPORTERS[name]`) so inherited prototype names
  // (toString / constructor / __proto__) resolve to a clean 'unsupported' (→ 400)
  // instead of reaching an inherited function and 500-ing on a.collectEvents().
  if (!Object.hasOwn(EXPORTERS, sourceName)) {
    const e = new Error('export not supported for ' + sourceName); e.code = 'unsupported'; throw e;
  }
  const out = await EXPORTERS[sourceName].collectEvents(ref, opts); // adapter validates ref (isInside) itself
  // Same rule as getConversation: a blocked session is not exportable either.
  // The check is on the collected `meta.cwd` and never touches the renderer, so
  // the byte-parity surface is untouched.
  if (out && out.meta && isBlockedPath(out.meta.cwd)) throw new Error('forbidden');
  return out;
}
