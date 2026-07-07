// Full-content search across every conversation's message bodies.
//
// Building the index means reading each conversation's transcript, so the first
// search is the slow one; results are cached per conversation and invalidated by
// mtime, and the build runs with bounded concurrency. Subsequent searches are an
// in-memory scan (fast). Multi-word queries are AND-matched (all terms present).
import { listConversations, getConversation } from './sources/index.js';

const index = new Map(); // key -> { sig, lower }
let building = null;

// Invalidation signature for one conversation entry (the F2 contract pinned in
// server/sources/claudeBundle.js): multi-artifact Claude bundles carry a
// composite `cacheSignature` that moves when ANY artifact changes; every other
// source falls back to the scalar file mtime.
export function entrySignature(c) {
  return c.cacheSignature ?? c.mtimeMs;
}

async function buildBatch(convos) {
  const CONCURRENCY = 40;
  const todo = [];
  const seen = new Set();
  for (const c of convos) {
    seen.add(c.key);
    const hit = index.get(c.key);
    if (!hit || hit.sig !== entrySignature(c)) todo.push(c);
  }
  for (const k of [...index.keys()]) if (!seen.has(k)) index.delete(k); // drop deleted

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (c) => {
      let lower = '';
      try {
        const d = await getConversation(c.source, c.ref, 30);
        lower = (d.messages || []).map((m) => m.text || '').join('\n').slice(0, 4000).toLowerCase();
      } catch { /* unreadable → empty, still cached so we don't retry every search */ }
      index.set(c.key, { sig: entrySignature(c), lower });
    }));
  }
}

// Refresh the index against the current conversation list (serialized so
// overlapping debounced searches don't build concurrently).
async function ensureIndex() {
  if (building) return building;
  building = (async () => {
    const convos = await listConversations();
    await buildBatch(convos);
  })();
  try { await building; } finally { building = null; }
}

// Build the index ahead of the first search (called on server start, after a
// short delay so it never competes with the initial page load).
export function warmIndex(delayMs = 1500) {
  setTimeout(() => { ensureIndex().catch(() => {}); }, delayMs);
}

export async function searchContent(query, { limit = 2000 } = {}) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { keys: [], snippets: {}, indexed: index.size };
  const t0 = Date.now();
  await ensureIndex();

  const keys = [];
  const snippets = {};
  for (const [key, { lower }] of index) {
    if (!lower) continue;
    if (!terms.every((t) => lower.includes(t))) continue;
    keys.push(key);
    const pos = lower.indexOf(terms[0]);
    if (pos >= 0) {
      const start = Math.max(0, pos - 40);
      snippets[key] = (start > 0 ? '…' : '') + lower.slice(start, pos + terms[0].length + 90).replace(/\s+/g, ' ').trim() + '…';
    }
    if (keys.length >= limit) break;
  }
  return { keys, snippets, indexed: index.size, tookMs: Date.now() - t0 };
}
