import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { listConversations, getConversation, SOURCE_META, collectEvents, exportCapableSources, exportCapabilities } from './server/sources/index.js';
import { renderMarkdown, deriveFlagTokens, deriveContentDisposition, resolveExportOptions } from './server/export.js';
import { getUsage } from './server/usage.js';
import { openPath } from './server/open.js';
import { getAgents, openAgentTerminal, updateAgent } from './server/agents.js';
import { searchContent, warmIndex } from './server/search.js';

// API that reads local transcripts from every supported AI coding tool and
// serves a unified list. Registered on BOTH the dev server and the preview
// server, so a built `dist/` is fully functional via `npm run preview`.
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  const json = (code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/api/sources') {
    const caps = new Set(exportCapableSources());
    const out = {};
    for (const [k, v] of Object.entries(SOURCE_META)) {
      const exportable = caps.has(k);
      out[k] = { ...v, exportable };
      // Phase-accurate per-flag capabilities so the UI can grey out flags a source
      // can't honor in this phase, and never switch on source names (ADR-0013).
      if (exportable) out[k].exportCapabilities = exportCapabilities(k);
    }
    return json(200, out);
  }

  if (url.pathname === '/api/export') {
    // no-store on EVERY export exit (incl. 4xx/5xx): error bodies can echo private
    // absolute paths, and they must never be cached. Set before any return; json()
    // and res.end() send pending headers, and no later middleware runs (no next()).
    res.setHeader('Cache-Control', 'no-store');
    const source = url.searchParams.get('source');
    const ref = url.searchParams.get('ref');
    if (!source || !ref) return json(400, { error: 'missing source or ref' });

    const q = url.searchParams;
    const bool = (k) => q.get(k) === '1';
    const h = q.get('history'); // 'on' | 'off' | null → auto
    const rawMax = parseInt(q.get('maxChars') || '400', 10);
    const requested = {
      full: bool('full'),
      tools: bool('tools'),
      toolResults: bool('toolResults'),
      thinking: bool('thinking'),
      sidechains: bool('sidechains'),
      history: h === 'on' ? 'on' : h === 'off' ? 'off' : 'auto',
      verbatim: bool('verbatim'),
      raw: bool('raw'),
      embedImages: bool('embedImages'),
      maxChars: Number.isFinite(rawMax) ? Math.min(20000, Math.max(1, rawMax)) : 400,
    };

    // ADR-0014 pipeline: requested → capability-validated → source-effective. For an
    // export-capable source, validate the explicitly-selected options against its
    // ADR-0013 capabilities and expand `full`; an explicit unavailable/notApplicable
    // option → 400 naming it. A non-export source falls through so collectEvents
    // throws the source-level 'unsupported' 400 instead of a confusing option 400.
    let tokens, effective;
    if (exportCapableSources().includes(source)) {
      const r = resolveExportOptions(requested, exportCapabilities(source) || {});
      if (r.error) {
        const how = r.state === 'notApplicable' ? 'not applicable to' : 'not available for';
        return json(400, { error: `${r.option} ${how} source '${source}'` });
      }
      ({ tokens, effective } = r);
    } else {
      // collectEvents will throw 'unsupported' before these are used; keep them coherent.
      tokens = deriveFlagTokens(requested);
      effective = { ...requested };
    }

    try {
      const { meta, events, resolvedOpts } = await collectEvents(source, ref, effective);
      const finalOpts = resolvedOpts || effective; // session-resolved (ADR-0014); 1A: none
      const md = renderMarkdown(events, meta, finalOpts);
      res.statusCode = 200;
      res.setHeader('Content-Type', finalOpts.raw ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8');
      if (q.get('download') === '1') {
        res.setHeader('Content-Disposition', deriveContentDisposition(meta.sessionId, tokens));
      }
      res.end(md);
    } catch (e) {
      const code = e.message === 'forbidden' ? 403 : e.code === 'unsupported' ? 400 : 500;
      json(code, { error: String(e && e.message ? e.message : e) });
    }
    return;
  }

  if (url.pathname === '/api/usage') {
    try { json(200, await getUsage()); }
    catch (e) { json(500, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/open') {
    const p = url.searchParams.get('path');
    try { json(200, openPath(p)); }
    catch (e) { json(400, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/search') {
    const q = url.searchParams.get('q') || '';
    try { json(200, await searchContent(q)); }
    catch (e) { json(500, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/agents') {
    try { json(200, await getAgents()); }
    catch (e) { json(500, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/agents/open') {
    try { json(200, openAgentTerminal(url.searchParams.get('id'))); }
    catch (e) { json(400, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/agents/update') {
    try { json(200, await updateAgent(url.searchParams.get('id'))); }
    catch (e) { json(400, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/conversations') {
    try { json(200, await listConversations()); }
    catch (e) { json(500, { error: String(e) }); }
    return;
  }

  if (url.pathname === '/api/conversation') {
    const source = url.searchParams.get('source');
    const ref = url.searchParams.get('ref');
    if (!source || !ref) return json(400, { error: 'missing source or ref' });
    try { json(200, await getConversation(source, ref, 30)); }
    catch (e) { json(e.message === 'forbidden' ? 403 : 500, { error: String(e) }); }
    return;
  }

  next();
}

function conversationsApi() {
  return {
    name: 'conversations-api',
    configureServer(server) { server.middlewares.use(apiMiddleware); warmIndex(); },
    configurePreviewServer(server) { server.middlewares.use(apiMiddleware); warmIndex(); },
  };
}

export default defineConfig({
  plugins: [react(), conversationsApi()],
  // localhost only — the API serves your private transcripts; never expose it
  // on the network (avoid `--host`).
  server: { port: 5191, open: true, host: 'localhost' },
  preview: { port: 5191, host: 'localhost' },
});
