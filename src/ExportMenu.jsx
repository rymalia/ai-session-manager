import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { buildExportQuery, clampMaxChars, FULL_IMPLIES } from './exportOptions.js';
import './export.css';

// Per-card Export control: a GUI for /replay-parity markdown export (ADR-0016).
// The options popover uses the native Popover API (popover="auto") so it renders
// in the top layer — escaping the card's `overflow:hidden` clipping — and gets
// Escape / outside-click / single-open-across-cards / focus-return for free.
// React 18.3 has no `popover` prop, so the attribute + open/close are driven
// imperatively via a ref. Options themselves are owned by App (lifted state) so
// every mounted menu stays in sync; this component is presentational + delivery.

const FLAG_ROWS = [
  { key: 'tools', label: 'Tools' },
  { key: 'toolResults', label: 'Tool results' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'sidechains', label: 'Sidechains' },
  { key: 'verbatim', label: 'Verbatim' },
  { key: 'raw', label: 'Raw (body only)' },
  { key: 'embedImages', label: 'Embed images' },
];

const TWO_MIB = 2 * 1024 * 1024;
const prettyBytes = (n) => `${(n / 1048576).toFixed(1)} MiB`;

// notApplicable = permanent (the source has no such concept); unavailable = a
// real /replay feature not built for this source yet (Claude 1A → 1B).
function capNote(state) {
  if (state === 'notApplicable') return 'n/a';
  if (state === 'unavailable') return 'in 1B';
  return '';
}
function capTitle(state) {
  if (state === 'notApplicable') return 'Not applicable to this source';
  if (state === 'unavailable') return 'A /replay feature coming in Phase 1B';
  return '';
}

// Verified clipboard write — honors execCommand's boolean result and a real
// writeText resolution, so callers never report success on a silent failure.
async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok === true;
  } catch {
    return false;
  }
}

export default function ExportMenu({ source, srcRef, sourceLabel, capabilities, opts, onChangeOpts }) {
  // useId() contains ':' which is awkward as a popovertarget id — strip it.
  const panelId = 'exp-' + useId().replace(/:/g, '');
  const panelRef = useRef(null);
  const triggerRef = useRef(null);
  const abortRef = useRef(null);
  const timerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState(''); // '' | 'copying' | 'copied'
  const [error, setError] = useState('');
  const [overCap, setOverCap] = useState(''); // pretty byte size when too large to copy

  const caps = capabilities || {};
  const capState = (k) => caps[k]; // undefined ⇒ fail-closed (not supported)
  const isSup = (k) => capState(k) === 'supported';

  // Position the top-layer panel under the trigger (fixed coords), right-aligned
  // and clamped to the viewport. Recomputed on open and on scroll/resize.
  const position = useCallback(() => {
    const el = panelRef.current;
    const trg = triggerRef.current;
    if (!el || !trg) return;
    const r = trg.getBoundingClientRect();
    const w = el.offsetWidth || 300;
    el.style.top = `${Math.round(r.bottom + 6)}px`;
    let left = Math.round(r.right - w);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    el.style.left = `${left}px`;
  }, []);

  // Make the panel a native auto-popover once mounted (imperative — no React prop
  // on 18.3). Track open/close via the toggle event: position + focus on open,
  // drop reposition listeners on close.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;
    try { if (el.popover !== 'auto') el.popover = 'auto'; } catch { /* older engine */ }

    const reposition = () => position();
    // beforetoggle fires before the panel paints — position here so it never
    // flashes at the UA default spot before the JS coords land.
    const onBeforeToggle = (e) => { if (e.newState === 'open') position(); };
    const onToggle = (e) => {
      const isOpen = e.newState === 'open';
      setOpen(isOpen);
      if (isOpen) {
        setError('');
        setOverCap('');
        position(); // re-run with the panel's real laid-out width
        // move focus into the panel; native popover returns it to the trigger on close
        el.querySelector('input, select, button, a')?.focus();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
      } else {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
      }
    };
    el.addEventListener('beforetoggle', onBeforeToggle);
    el.addEventListener('toggle', onToggle);
    return () => {
      el.removeEventListener('beforetoggle', onBeforeToggle);
      el.removeEventListener('toggle', onToggle);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [position]);

  // Cleanup superseded requests + pending timers on unmount.
  useEffect(() => () => {
    clearTimeout(timerRef.current);
    abortRef.current?.abort();
  }, []);

  const closePanel = useCallback(() => {
    try { panelRef.current?.hidePopover(); } catch { /* not open */ }
  }, []);

  const setOpt = (patch) => onChangeOpts({ ...opts, ...patch });

  const doCopy = useCallback(async () => {
    if (copyState === 'copying') return;
    setError('');
    setOverCap('');
    abortRef.current?.abort(); // supersede any in-flight export
    const ac = new AbortController();
    abortRef.current = ac;
    setCopyState('copying');
    try {
      const qs = buildExportQuery({ source, ref: srcRef, opts, capabilities: caps, download: false });
      const r = await fetch('/api/export?' + qs, { signal: ac.signal });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const text = await r.text();
      const bytes = new TextEncoder().encode(text).length; // UTF-8 bytes, not .length
      if (bytes > TWO_MIB) {
        setOverCap(prettyBytes(bytes)); // explicit Download only — never auto-download
        setCopyState('');
        return;
      }
      const ok = await writeClipboard(text);
      if (!ok) throw new Error('Clipboard write was blocked');
      setCopyState('copied');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState(''), 1400);
    } catch (e) {
      if (e.name === 'AbortError') return; // a newer click owns the state now
      setError(String(e.message || e));
      setCopyState('');
    }
  }, [source, srcRef, opts, caps, copyState]);

  // Real anchor for Download: no `download` attr, so the server's
  // Content-Disposition names the file and a JSON error response opens visibly in
  // the new tab instead of being silently saved as markdown (ADR-0016). A blank
  // tab may briefly appear on success in some browsers — acceptable in Phase 1;
  // true zero-buffer streaming render is deferred (ADR-0016 Consequence).
  const downloadHref = '/api/export?' + buildExportQuery({ source, ref: srcRef, opts, capabilities: caps, download: true });

  // maxChars: keep a local string while typing; commit a clamped number on blur/Enter.
  const [maxStr, setMaxStr] = useState(String(opts.maxChars));
  useEffect(() => { setMaxStr(String(opts.maxChars)); }, [opts.maxChars]);
  const commitMax = () => {
    const n = clampMaxChars(maxStr);
    setMaxStr(String(n));
    if (n !== opts.maxChars) setOpt({ maxChars: n });
  };

  const historySupported = isSup('history');

  return (
    // stopPropagation on the whole subtree: clicks/keys inside the trigger or the
    // top-layer panel (still a DOM descendant) must not bubble to card-head and
    // toggle the card.
    <span
      className="exp-wrap"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {/* popovertarget registers this button as the panel's native invoker, so
          clicking it while open CLOSES instead of getting light-dismissed on
          pointerdown and reopened by a manual toggle. React 18.3 emits these
          lowercase attributes verbatim. The wrapper's stopPropagation still
          keeps the click from toggling card expansion. */}
      <button
        ref={triggerRef}
        type="button"
        className={`exp-trigger ${open ? 'exp-open' : ''}`}
        popovertarget={panelId}
        popovertargetaction="toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Export transcript to markdown"
      >
        ⤓ Export
      </button>

      <div ref={panelRef} id={panelId} popover="auto" className="exp-panel" role="dialog" aria-label={`Export ${sourceLabel} session`}>
        <div className="exp-head">
          <span className="exp-title">Export · {sourceLabel}</span>
          <button type="button" className="exp-close" onClick={closePanel} aria-label="Close export options">×</button>
        </div>

        <label className="exp-full">
          <input type="checkbox" checked={opts.full} onChange={(e) => setOpt({ full: e.target.checked })} />
          <span className="exp-full-label">Full</span>
          <span className="exp-hint">tools · results · thinking · sidechains</span>
        </label>

        <div className="exp-flags">
          {FLAG_ROWS.map(({ key, label }) => {
            const implied = opts.full && FULL_IMPLIES.includes(key);
            const supported = isSup(key);
            const disabled = implied || !supported;
            const checked = implied ? true : (supported && opts[key]);
            const note = implied ? 'via Full' : (!supported ? capNote(capState(key)) : '');
            const title = implied ? 'Included by Full' : capTitle(capState(key));
            return (
              <div key={key} className={`exp-row ${disabled ? 'exp-disabled' : ''}`}>
                <label title={title}>
                  <input
                    type="checkbox"
                    checked={!!checked}
                    disabled={disabled}
                    onChange={(e) => setOpt({ [key]: e.target.checked })}
                  />
                  {label}
                </label>
                {note && <span className="exp-note">{note}</span>}
              </div>
            );
          })}
        </div>

        <div className="exp-field">
          <label htmlFor={`${panelId}-hist`}>History</label>
          <select
            id={`${panelId}-hist`}
            value={historySupported ? opts.history : 'auto'}
            disabled={!historySupported}
            onChange={(e) => setOpt({ history: e.target.value })}
          >
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          {!historySupported && <span className="exp-note" title={capTitle(capState('history'))}>{capNote(capState('history'))}</span>}
        </div>

        <div className="exp-field">
          <label htmlFor={`${panelId}-max`}>Max chars</label>
          <input
            id={`${panelId}-max`}
            type="number"
            min={1}
            max={20000}
            value={maxStr}
            onChange={(e) => setMaxStr(e.target.value)}
            onBlur={commitMax}
            onKeyDown={(e) => { if (e.key === 'Enter') commitMax(); }}
          />
        </div>

        <div className="exp-actions">
          <button type="button" className={`exp-btn exp-copy ${copyState === 'copied' ? 'exp-copied' : ''}`} onClick={doCopy} disabled={copyState === 'copying'}>
            {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? '✓ Copied' : 'Copy'}
          </button>
          <a className="exp-btn exp-download" href={downloadHref} target="_blank" rel="noopener">Download</a>
        </div>

        {overCap && (
          <div className="exp-msg exp-overcap">Too large to copy ({overCap}). Use Download instead.</div>
        )}
        {error && <div className="exp-msg exp-error">{error}</div>}
      </div>
    </span>
  );
}
