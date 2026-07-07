// Full-fidelity markdown export — a faithful JS port of the /replay extractor's
// renderer (session-tools extract-session.py: render_event + main() header
// assembly + summarize_tool_use + clean_user_text + truncate + format_ts).
//
// Goal: byte-for-byte parity with `/replay <id> --full` etc. Adapters emit the
// normalized { role, ts, source, sidechain, meta, blocks[] } contract (see
// server/sources/*.js collectEvents); this module renders it. All content
// filtering (tools/toolResults/thinking/sidechains/maxChars) happens HERE, never
// in the adapter — so a toggle always has data to reveal.

// ---- harness-noise stripping (Claude user turns; no-op for Codex) ------------
const NOISE_TAGS = [
  'system-reminder', 'local-command-stdout', 'local-command-stderr',
  'local-command-caveat', 'command-message', 'command-args',
];
const NOISE_RE = new RegExp(`<(${NOISE_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g');
const COMMAND_NAME_RE = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/g;

export function cleanUserText(text, verbatim) {
  if (verbatim) return text;
  return text
    .replace(NOISE_RE, '')
    .replace(COMMAND_NAME_RE, '_(invoked $1)_')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- primitives mirrored from the Python ------------------------------------

// truncate(): Python measures & slices by CODE POINTS (len()/[:n]). JS strings
// index by UTF-16 units, so emoji/non-BMP chars would diverge — iterate code
// points to match exactly, including the "+N chars" remainder count.
export function truncate(s, n) {
  s = (s == null ? '' : String(s)).trim();
  const cps = Array.from(s);
  if (cps.length <= n) return s;
  const head = cps.slice(0, n).join('').replace(/\s+$/, ''); // Python .rstrip()
  return head + `… [+${cps.length - n} chars]`;
}

// Deliberate divergence from the Python reference (which slices the raw UTC
// string): render in the process's local timezone, same "YYYY-MM-DD HH:MM:SS"
// shape. Golden diffs vs extract-session.py stay byte-identical because the
// parity harness pins TZ=UTC (see scripts/export-parity.mjs / ADR-0018).
export function formatTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.replaceAll('T', ' ').slice(0, 19);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// pyStr(): Python str() — booleans/None differ from JS String().
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

// pyRepr(): reproduce CPython str.__repr__ for the printable-content case
// (used by summarize_tool_use's `!r`). Quote choice + \\, \n, \r, \t and ASCII
// control escaping match CPython. KNOWN GAP: exotic non-printable Unicode
// (categories Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs) is kept literal here rather than
// \x/\u/\U-escaped as CPython would — see ADR-0009.
export function pyRepr(s) {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const q = hasSingle && !hasDouble ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === q) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + q;
}

// jsonAscii(): JSON.stringify + Python json.dumps's default ensure_ascii=True —
// every UTF-16 code unit ≥ 0x80 becomes a lowercase \uXXXX escape, non-BMP as
// two escapes (the surrogate halves), exactly like CPython. Escaping happens
// BEFORE truncate's 100-char cap so escape sequences count toward it on both
// sides, and the result is pure ASCII so pyRepr adds no further divergence.
// Closes ADR-0009 item 2. (The range is built from code points, not literals,
// so this file stays free of invisible characters.)
const NON_ASCII = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0xffff)}]`, 'g');
const jsonAscii = (v) => JSON.stringify(v)
  .replace(NON_ASCII, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

// summarize_tool_use(): priority-key picker → `name(k=v, …)` one-liner.
// Structured dict/list values serialize via jsonAscii (byte-matches Python
// json.dumps(v, separators=(',',':')) — ADR-0009 item 2 fixed). REMAINING
// ACCEPTED GAPS: V8 integer-key canonicalization (ADR-0009 item 4, both
// surfaces below) and float formatting (ADR-0009 item 5: JSON.parse collapses
// 1.0 → 1 before we ever see it, so Python's '1.0'/'1e-07'/'-0.0' cannot be
// reproduced without a lossless JSON parser).
export function summarizeToolUse(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const priority = [
    'file_path', 'path', 'pattern', 'command', 'description',
    'prompt', 'query', 'url', 'skill', 'subagent_type',
    'input', 'arguments', 'cell_id',
  ];
  const hits = [];
  for (const k of priority) {
    if (Object.prototype.hasOwnProperty.call(inp, k)) {
      let v = inp[k];
      v = v !== null && typeof v === 'object' ? jsonAscii(v) : pyStr(v);
      hits.push(`${k}=${pyRepr(truncate(v, 100))}`);
    }
  }
  if (hits.length === 0) {
    for (const k of Object.keys(inp).slice(0, 3)) hits.push(`${k}=…`);
  }
  return `${name || '?'}(${hits.join(', ')})`;
}

function sourceTag(source) {
  if (source === 'main' || !source) return '';
  if (source === 'history') return ' [from history.jsonl]';
  if (source.startsWith('subagent:')) return ` [sub: ${source.slice('subagent:'.length)}]`;
  return ` [${source}]`;
}

// ---- one event → chunks (port of render_event); returns turns added (0|1) ----
function renderEvent(ev, o, chunks) {
  const role = ev.role;
  if (role !== 'user' && role !== 'assistant') return 0;
  const sidechain = !!ev.sidechain;
  if (sidechain && !o.sidechains) return 0;

  const ts = formatTs(ev.ts || '');
  const tagSuffix = (sidechain ? ' [sidechain]' : '') + sourceTag(ev.source || 'main');
  const header = (who) =>
    o.raw ? `\n[${who.toUpperCase()} ${ts}${tagSuffix}]\n`
          : `\n### ${who} · ${ts}${tagSuffix}\n`;
  const blocks = Array.isArray(ev.blocks) ? ev.blocks : [];

  if (role === 'user') {
    if (ev.meta && !o.verbatim) return 0; // isMeta harness noise
    let counted = 0, headerWritten = false;

    const textParts = blocks.filter((b) => b.kind === 'text').map((b) => b.text || '');
    const text = cleanUserText(textParts.filter(Boolean).join('\n'), o.verbatim);
    if (text) {
      chunks.push(header('user'));
      headerWritten = true; counted = 1;
      chunks.push(`\n${text}\n`);
    }

    const pasteIds = ev.imagePasteIds || [];
    let imgN = 0;
    for (const b of blocks) {
      if (b.kind !== 'image') continue;
      const label = imgN < pasteIds.length ? pasteIds[imgN] : imgN + 1;
      imgN++;
      if (!headerWritten) { chunks.push(header('user')); headerWritten = true; counted = 1; }
      const media = b.mediaType || 'image';
      let uri = null;
      if (o.embedImages && !o.raw) {
        const src = b.source || {};
        if (src.type === 'base64' && src.data) uri = `data:${media};base64,${src.data}`;
        else if (src.type === 'url' && src.url) uri = src.url;
      }
      chunks.push(uri !== null ? `\n![Image #${label}](${uri})\n` : `\n[Image #${label}: ${media}]\n`);
    }

    if (o.toolResults) {
      for (const b of blocks) {
        if (b.kind !== 'tool_result') continue;
        chunks.push(header('tool_result'));
        chunks.push(`\n\`\`\`\n${truncate(b.text || '', o.maxChars)}\n\`\`\`\n`);
      }
    }
    return counted;
  }

  // assistant
  let wroteHeader = false, counted = 0;
  for (const b of blocks) {
    if (b.kind === 'text' && (b.text || '').trim()) {
      if (!wroteHeader) { chunks.push(header('assistant')); wroteHeader = true; counted = 1; }
      chunks.push(`\n${b.text.trim()}\n`);
    } else if (b.kind === 'thinking' && o.thinking && (b.text || '').trim()) {
      if (!wroteHeader) { chunks.push(header('assistant')); wroteHeader = true; }
      chunks.push(`\n> _thinking:_ ${truncate(b.text, o.maxChars)}\n`);
    } else if (b.kind === 'reasoning' && o.thinking) {
      if (!wroteHeader) { chunks.push(header('assistant')); wroteHeader = true; }
      const shown = (b.text || '').trim() ? truncate(b.text, o.maxChars) : '[encrypted by Codex]';
      chunks.push(`\n> _reasoning:_ ${shown}\n`);
    } else if (b.kind === 'tool_use' && o.tools) {
      if (!wroteHeader) { chunks.push(header('assistant')); wroteHeader = true; }
      chunks.push(`\n- **→** \`${summarizeToolUse(b.name, b.input)}\`\n`);
    }
  }
  return counted;
}

// ---- whole session → markdown (port of main()'s output assembly) ------------
// opts: { tools, toolResults, thinking, sidechains, verbatim, raw, embedImages, maxChars=400 }
// meta: { sessionId, isCodex, cliVersion, model, summary, mainPath, subagentCount,
//         folder, historyOn, historyAdded, cwd, created, gitBranch, messageCount }
export function renderMarkdown(events, meta, opts) {
  const o = { maxChars: 400, ...opts };
  const chunks = [];
  let turns = 0;
  for (const ev of events) turns += renderEvent(ev, o, chunks);

  const body = chunks.join('').replace(/\s+$/, '') + '\n'; // "".join(chunks).rstrip() + "\n"
  if (o.raw) return body;

  const H = [];
  H.push(`# Session replay: \`${meta.sessionId || '?'}\`\n\n`);
  if (meta.isCodex) {
    H.push('- **format**: OpenAI Codex CLI rollout' + (meta.cliVersion ? ` (v${meta.cliVersion})` : '') + '\n');
    if (meta.model) H.push(`- **model**: ${meta.model}\n`);
  }
  if (meta.summary) H.push(`- **summary**: ${meta.summary}\n`);
  if (meta.mainPath) H.push(`- **main**: \`${meta.mainPath}\`\n`);
  else H.push('- **main**: _(none — folder-only session; main transcript was not retained)_\n');
  if (meta.subagentCount) {
    H.push(`- **subagents**: ${meta.subagentCount} file(s)` + (meta.folder ? ` in \`${meta.folder}/subagents/\`` : '') + '\n');
  }
  if (meta.historyOn) H.push(`- **history.jsonl**: ${meta.historyAdded || 0} user prompt(s) interleaved\n`);
  if (meta.cwd) H.push(`- **cwd**: \`${meta.cwd}\`\n`);
  if (meta.created) H.push(`- **created**: ${formatTs(meta.created)}\n`);
  if (meta.gitBranch) H.push(`- **branch**: ${meta.gitBranch}\n`);
  if (meta.messageCount) H.push(`- **original messages**: ${meta.messageCount}\n`);
  H.push(`- **turns**: ${turns}\n`);
  const flags = [
    ['tools', o.tools], ['tool_results', o.toolResults], ['thinking', o.thinking],
    ['sidechains', o.sidechains], ['history', !!meta.historyOn],
  ].map(([n, v]) => `${n}=${v ? 'on' : 'off'}`).join(', ');
  H.push(`- **filters**: ${flags}\n\n---\n`);

  return H.join('') + body;
}

// ---- filename derivation (port of derive_flag_tokens / derive_output_path) ---
// Called with flags AS REQUESTED (before --full expands) so the name shows
// "full" not its four parts. history: 'auto' | 'on' | 'off'.
export function deriveFlagTokens(o) {
  const t = [];
  if (o.verbatim) t.push('verbatim');
  if (o.raw) t.push('raw');
  if (o.full) t.push('full');
  else {
    if (o.tools) t.push('tools');
    if (o.toolResults) t.push('tool-results');
    if (o.thinking) t.push('thinking');
    if (o.sidechains) t.push('sidechains');
  }
  if (o.embedImages) t.push('embed-images');
  if (o.history === 'on') t.push('history');
  else if (o.history === 'off') t.push('no-history');
  if (o.maxChars !== 400) t.push(`max${o.maxChars}`);
  return t;
}

// Streamed download: no filesystem collision loop (the browser de-dupes with
// " (1)"). Port derive_output_path's -2/-3 loop only if a server-side save mode
// is added later. Stem is `replay-<short>` for /replay parity. The 8-char slice
// is CODE-POINT based (Array.from), matching Python's `session_id[:8]` — a UTF-16
// .slice() could bisect an emoji surrogate pair and produce a lone surrogate that
// crashes encodeURIComponent downstream (deriveContentDisposition).
export function deriveExportFilename(sessionId, tokens) {
  const stem = Array.from(sessionId || 'session').slice(0, 8).join('');
  return ['replay', stem, ...tokens].join('-') + '.md';
}

// Build a safe RFC 6266 Content-Disposition value from an UNTRUSTED sessionId (a
// local filename stem the client supplies indirectly via `ref`). Two params:
//   filename="…"       — ASCII-only fallback; every non-token char → '_' so no
//                        quote/CR/LF can escape the quoted-string (header injection).
//   filename*=UTF-8''… — RFC 5987 ext-value. `.toWellFormed()` first so a lone
//                        surrogate can't throw in encodeURIComponent; then also
//                        percent-encode ' ( ) * — encodeURIComponent leaves those
//                        literal but they are NOT RFC 5987 attr-char.
// ---- option-resolution pipeline (ADR-0014) ----------------------------------
// requested → capability-validated → source-effective. Pure (no fs / no HTTP) so
// it unit-tests off hand-built inputs; the endpoint wires it to collectEvents and
// then to session-resolved opts. Returns either { error, option, state } (reject
// with 400) or { tokens, effective }.
//
//   - Validate ONLY explicitly, individually enabled options: a content flag sent
//     as true, or history === 'on'. `full` is a render directive, never validated,
//     never 400s (ADR-0014). Turning an option OFF (false / history 'off') is the
//     safe direction and is always allowed. Missing/unknown capability fails closed.
//   - Filename tokens derive from REQUESTED opts, BEFORE `full` expands (so the token
//     is `full`, not its four components; auto history adds no token) — ADR-0002/0008.
//   - Source-effective: `full` expands to its four flags unconditionally; history
//     'auto' resolves to 'off' unless history is 'supported'.
const CONTENT_FLAGS = ['tools', 'toolResults', 'thinking', 'sidechains', 'verbatim', 'raw', 'embedImages'];

// Source-effective stage, WITHOUT the capability-rejection gate: `full` expands to
// its four flags unconditionally (a render directive), and history 'auto' resolves
// to 'off' unless history is 'supported'. Shared by the endpoint (after validation)
// and the golden-diff harness (which has no HTTP gate — /replay renders combos like
// verbatim+full on Codex that the endpoint 400s), so the two can't drift.
export function sourceEffectiveOptions(requested, capabilities) {
  const caps = capabilities || {};
  const effective = { ...requested };
  if (effective.full) effective.tools = effective.toolResults = effective.thinking = effective.sidechains = true;
  if (effective.history === 'auto' && caps.history !== 'supported') effective.history = 'off';
  return effective;
}

export function resolveExportOptions(requested, capabilities) {
  const caps = capabilities || {};
  const enabled = CONTENT_FLAGS.filter((k) => requested[k] === true);
  if (requested.history === 'on') enabled.push('history');
  for (const opt of enabled) {
    if (caps[opt] !== 'supported') return { error: true, option: opt, state: caps[opt] || 'unavailable' };
  }
  const tokens = deriveFlagTokens(requested);
  return { tokens, effective: sourceEffectiveOptions(requested, caps) };
}

export function deriveContentDisposition(sessionId, tokens) {
  const fname = deriveExportFilename(sessionId, tokens);
  const ascii = fname.replace(/[^A-Za-z0-9._-]/g, '_') || 'replay.md';
  const ext = encodeURIComponent(fname.toWellFormed())
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}
