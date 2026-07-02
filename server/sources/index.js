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
import { SOURCE_META } from './_shared.js';

export { SOURCE_META };

const ADAPTERS = { claude, codex, grok, opencode, cursor, gemini, copilot, goose, droid };

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
    const all = results.flat();
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
  return a.detail(ref, lastN);
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
  return EXPORTERS[sourceName].collectEvents(ref, opts); // adapter validates ref (isInside) itself
}
