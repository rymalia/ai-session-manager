import { useEffect, useState } from 'react';
import './usage.css';

// Fallback source metadata; replaced by /api/sources on load. Mirrors the
// shape served by the conversations API so colours/labels stay consistent.
const DEFAULT_META = {
  claude: { label: 'Claude Code', short: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', short: 'Codex', color: '#10a37f' },
  grok: { label: 'Grok', short: 'Grok', color: '#9b87f5' },
  opencode: { label: 'opencode', short: 'opencode', color: '#f0883e' },
  cursor: { label: 'Cursor', short: 'Cursor', color: '#4d9fff' },
  gemini: { label: 'Gemini CLI', short: 'Gemini', color: '#e6477f' },
};

const KIND_TAG = {
  quota: 'quota left',
  consumed: 'used',
  activity: 'activity',
};

// A metric that represents a percentage of remaining quota gets a small bar.
function isPercent(m) {
  return /^(limit_|quota)/.test(m.key) || (typeof m.value === 'number' && /%$/.test(m.display || ''));
}

function Metric({ m, accent }) {
  return (
    <div className="usg-metric">
      <div className="usg-metric-row">
        <span className="usg-metric-label">{m.label}</span>
        <span className="usg-metric-value">{m.display ?? '—'}</span>
      </div>
      {isPercent(m) && typeof m.value === 'number' && (
        <div className="usg-bar">
          <div
            className="usg-bar-fill"
            style={{ width: `${Math.max(0, Math.min(100, m.value))}%`, background: accent }}
          />
        </div>
      )}
      {m.detail && <span className="usg-metric-detail">{m.detail}</span>}
    </div>
  );
}

function Card({ entry, meta }) {
  const m = meta[entry.source] || {};
  const accent = m.color || 'var(--accent)';
  const name = m.label || entry.label || entry.source;
  const style = { '--usg-accent': accent };

  if (!entry.available) {
    return (
      <div className="usg-card usg-off" style={style}>
        <div className="usg-card-head">
          <span className="usg-dot" />
          <span className="usg-name">{name}</span>
          <span className="usg-tag">n/a</span>
        </div>
        <div className="usg-na">
          <span className="usg-na-dash">—</span>
        </div>
        <div className="usg-note">{entry.note || 'No local usage data'}</div>
      </div>
    );
  }

  const tag = KIND_TAG[entry.kind] || 'used';
  return (
    <div className="usg-card" style={style}>
      <div className="usg-card-head">
        <span className="usg-dot" />
        <span className="usg-name">{name}</span>
        <span className={`usg-tag ${entry.kind === 'quota' ? 'usg-tag-quota' : ''}`}>{tag}</span>
      </div>
      <div className="usg-metrics">
        {(entry.metrics || []).map((metric) => (
          <Metric key={metric.key} m={metric} accent={accent} />
        ))}
      </div>
      {entry.note && <div className="usg-note">{entry.note}</div>}
    </div>
  );
}

export default function Usage() {
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(DEFAULT_META);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetch('/api/usage').then((r) => {
        if (!r.ok) throw new Error(`usage ${r.status}`);
        return r.json();
      }),
      fetch('/api/sources').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([usage, sources]) => {
        if (!alive) return;
        setData(Array.isArray(usage) ? usage : []);
        if (sources && typeof sources === 'object') setMeta(sources);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(e.message || 'failed to load');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const available = (data || []).filter((d) => d.available).length;

  return (
    <section className="usg-wrap">
      <div className="usg-head">
        <span className="usg-title">Usage &amp; quota</span>
        {data && (
          <span className="usg-sub">
            {available} of {data.length} tools expose local data
          </span>
        )}
      </div>

      {loading && <div className="usg-state">Loading usage…</div>}
      {!loading && error && <div className="usg-state">Usage unavailable ({error})</div>}
      {!loading && !error && data && data.length === 0 && (
        <div className="usg-state">No usage data</div>
      )}

      {!loading && !error && data && data.length > 0 && (
        <div className="usg-grid">
          {data.map((entry) => (
            <Card key={entry.source} entry={entry} meta={meta} />
          ))}
        </div>
      )}
    </section>
  );
}
