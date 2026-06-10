import { useMemo } from 'react';
import './ministats.css';

// Compact metric strip shown at the top when the full Stats panel is collapsed.
// Everything is derived from the already-loaded conversations list — no fetch.

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function relTime(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return s < 5 ? 'now' : `${s}s`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const DAYS = 14;

export default function MiniStats({ convos, meta }) {
  const s = useMemo(() => {
    if (!convos || !convos.length) return null;
    const now = Date.now();
    const dayMs = 86400000;
    const byTool = new Map();
    const buckets = new Array(DAYS).fill(0);
    let totalMsgs = 0, recent = 0, last7 = 0, last24 = 0;
    for (const c of convos) {
      totalMsgs += c.messageCount || 0;
      byTool.set(c.source, (byTool.get(c.source) || 0) + 1);
      const t = c.lastActivity ? Date.parse(c.lastActivity) : 0;
      if (!t) continue;
      if (t > recent) recent = t;
      const age = now - t;
      if (age <= 7 * dayMs) last7++;
      if (age <= dayMs) last24++;
      const idx = DAYS - 1 - Math.floor(age / dayMs);
      if (idx >= 0 && idx < DAYS) buckets[idx]++;
    }
    const top = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
    return { total: convos.length, totalMsgs, toolCount: byTool.size, top, last7, last24, recent, buckets };
  }, [convos]);

  if (!s) return null;
  const color = (src) => (meta[src] && meta[src].color) || '#8b949e';
  const short = (src) => (meta[src] && meta[src].short) || src;
  const peak = Math.max(1, ...s.buckets);
  const topTool = s.top[0];

  return (
    <div className="ms-row">
      <div className="ms-card">
        <div className="ms-label">Conversations</div>
        <div className="ms-value">{fmt(s.total)}</div>
        <div className="ms-sub">+{s.last7} this week</div>
      </div>

      <div className="ms-card">
        <div className="ms-label">Messages</div>
        <div className="ms-value">{fmt(s.totalMsgs)}</div>
        <div className="ms-sub">{Math.round(s.totalMsgs / s.total)} avg / convo</div>
      </div>

      <div className="ms-card">
        <div className="ms-label">Tools</div>
        <div className="ms-value">{s.toolCount}</div>
        <div className="ms-dots">
          {s.top.slice(0, 8).map(([src]) => (
            <span key={src} className="ms-dot" style={{ background: color(src) }} title={short(src)} />
          ))}
        </div>
      </div>

      <div className="ms-card">
        <div className="ms-label">Most active</div>
        <div className="ms-value ms-tool" style={{ color: color(topTool[0]) }}>
          <span className="ms-dot" style={{ background: color(topTool[0]) }} />
          {short(topTool[0])}
        </div>
        <div className="ms-sub">{fmt(topTool[1])} conversations</div>
      </div>

      <div className="ms-card ms-spark-card">
        <div className="ms-label">Activity · 14d</div>
        <svg className="ms-spark" viewBox={`0 0 ${DAYS * 6} 24`} preserveAspectRatio="none">
          {s.buckets.map((v, i) => {
            const h = Math.max(1, Math.round((v / peak) * 22));
            return <rect key={i} x={i * 6} y={24 - h} width={4.2} height={h} rx={1} fill="var(--accent)" opacity={0.45 + 0.55 * (v / peak)} />;
          })}
        </svg>
        <div className="ms-sub">{s.last24} today</div>
      </div>

      <div className="ms-card">
        <div className="ms-label">Last active</div>
        <div className="ms-value">{relTime(s.recent)}</div>
        <div className="ms-sub">ago</div>
      </div>
    </div>
  );
}
