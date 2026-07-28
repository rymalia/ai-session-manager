import { useEffect, useState } from 'react';
import { orderBySource } from './sourceOrder.js';
import './agents.css';

// Small copy-to-clipboard button, mirrors the app's existing copy affordance.
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button className={`ag-btn ag-copy ${copied ? 'ag-ok' : ''}`} onClick={onClick} title={`Copy: ${text}`}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

// Launches the agent: a new macOS Terminal window for a CLI, or the desktop
// app itself for one installed as an app bundle.
function OpenTerminalBtn({ id, kind }) {
  const [state, setState] = useState(''); // '' | 'ok' | 'err'
  const app = kind === 'app';
  const onClick = async () => {
    try {
      const r = await fetch('/api/agents/open?id=' + encodeURIComponent(id));
      setState(r.ok ? 'ok' : 'err');
    } catch {
      setState('err');
    }
    setTimeout(() => setState(''), 1400);
  };
  return (
    <button
      className={`ag-btn ag-term ${state === 'ok' ? 'ag-ok' : state === 'err' ? 'ag-err' : ''}`}
      onClick={onClick}
      title={app ? 'Launch this desktop app' : 'Open a new Terminal window running this agent'}
    >
      {state === 'ok'
        ? '✓ Opened'
        : state === 'err'
          ? '✗ Failed'
          : app
            ? '⇱ Open app'
            : '⎋ Open in Terminal'}
    </button>
  );
}

// Runs the registry update command for this agent and surfaces the output.
function UpdateBtn({ id, command }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { ok, output }
  const [open, setOpen] = useState(false);

  const onClick = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch('/api/agents/update?id=' + encodeURIComponent(id));
      const body = await r.json().catch(() => ({ ok: false, output: 'Bad response' }));
      setResult(body);
      setOpen(true);
    } catch (e) {
      setResult({ ok: false, output: String(e) });
      setOpen(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="ag-update-wrap">
      <button
        className={`ag-btn ag-update ${running ? 'ag-running' : ''}`}
        onClick={onClick}
        disabled={running}
        title={`Run: ${command}`}
      >
        {running ? (
          <>
            <span className="ag-spinner" /> Updating…
          </>
        ) : (
          '↑ Update'
        )}
      </button>
      {result && (
        <div className={`ag-result ${result.ok ? 'ag-result-ok' : 'ag-result-err'}`}>
          <button className="ag-result-head" onClick={() => setOpen((v) => !v)}>
            <span className="ag-result-status">
              {result.ok ? '✓ Update finished' : '✗ Update failed'}
            </span>
            <span className="ag-result-toggle">{open ? '▲ hide output' : '▼ show output'}</span>
          </button>
          {open && <pre className="ag-result-out">{result.output || '(no output)'}</pre>}
        </div>
      )}
    </div>
  );
}

function Exists({ ok }) {
  return <span className={`ag-exists ${ok ? 'ag-yes' : 'ag-no'}`}>{ok ? '✓' : '✗'}</span>;
}

function AgentCard({ a }) {
  return (
    <div className={`ag-card ${a.installed ? '' : 'ag-card-off'}`}>
      <div className="ag-card-head">
        <span className="ag-name">{a.label}</span>
        <span className={`ag-badge ${a.installed ? 'ag-badge-on' : 'ag-badge-off'}`}>
          {a.installed ? 'installed' : 'not installed'}
        </span>
        {a.conversationCount > 0 && (
          <span className="ag-count" title="Conversations from this tool">
            {a.conversationCount} convos
          </span>
        )}
      </div>

      <div className="ag-rows">
        {a.installed && a.version && (
          <div className="ag-row">
            <span className="ag-key">Version</span>
            <span className="ag-val">{a.version}</span>
          </div>
        )}
        {a.installed && a.path && (
          <div className="ag-row">
            <span className="ag-key">{a.kind === 'app' ? 'App' : 'Binary'}</span>
            <code className="ag-val ag-mono">{a.path}</code>
          </div>
        )}
        <div className="ag-row">
          <span className="ag-key">Config dir</span>
          <span className="ag-val">
            <Exists ok={a.configDirExists} /> <code className="ag-mono">{a.configDir}</code>
          </span>
        </div>
        <div className="ag-row">
          <span className="ag-key">Config file</span>
          <span className="ag-val">
            {a.configFile ? (
              <>
                <Exists ok={a.configFileExists} /> <code className="ag-mono">{a.configFile}</code>
              </>
            ) : (
              <span className="ag-muted">none well-known</span>
            )}
          </span>
        </div>
      </div>

      <div className="ag-cmd-line">
        <code className="ag-cmd">{a.runCommand}</code>
        <div className="ag-cmd-actions">
          <CopyBtn text={a.runCommand} />
          {a.installed && <OpenTerminalBtn id={a.id} kind={a.kind} />}
        </div>
      </div>

      {a.updateCommand && a.installed && <UpdateBtn id={a.id} command={a.updateCommand} />}
    </div>
  );
}

// Registry agent ids are the same ids as the conversation sources, so the
// cards can follow the header chips exactly like the usage cards do.
export default function Agents({ order }) {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/agents')
      .then((r) => {
        if (!r.ok) throw new Error(`agents ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        if (d && d.error) setError(String(d.error));
        else setAgents(Array.isArray(d) ? d : []);
      })
      .catch((e) => {
        if (alive) setError(e.message || 'failed to load');
      });
    return () => {
      alive = false;
    };
  }, []);

  const installedCount = agents ? agents.filter((a) => a.installed).length : 0;

  return (
    <section className="ag-wrap">
      <div className="ag-panel-head">
        <span className="ag-panel-title">AI coding agents</span>
        {agents && (
          <span className="ag-panel-sub">
            {installedCount} of {agents.length} installed
          </span>
        )}
      </div>

      {error && <div className="ag-state ag-state-err">Agents unavailable ({error})</div>}
      {!agents && !error && <div className="ag-state">Probing installed agents…</div>}

      {agents && (
        <div className="ag-grid">
          {orderBySource(agents, order, (a) => a.id).map((a) => (
            <AgentCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </section>
  );
}
