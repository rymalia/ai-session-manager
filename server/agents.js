// Agents panel backend: inspects every supported AI coding CLI ("agent") —
// whether it's installed, its version, config locations, the command to run
// it, and (where we're confident) a self-update command.
//
// Security notes:
//  - openAgentTerminal / updateAgent take ONLY an `id` from the caller and look
//    up the actual command in the registry below. We never run a string the
//    caller supplied, so there's no injection surface from the HTTP layer.
//  - The run command launched into Terminal is JSON.stringified into the
//    osascript argument, and osascript is invoked via execFile with an args
//    array (no shell), so the AppleScript string is a literal.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

const HOME = os.homedir();

// Expand a leading ~ to the user's home directory.
function expand(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// The registry. `update` is set only for tools with a built-in self-updater or
// a single dominant install method; otherwise it's null and no Update button is
// shown. If you installed a tool differently (e.g. Homebrew instead of npm),
// adjust the command here.
const REGISTRY = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    configDir: '~/.claude',
    configFile: '~/.claude/settings.json',
    run: 'claude',
    // Built-in self-updater.
    update: 'claude update',
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    configDir: '~/.codex',
    configFile: '~/.codex/config.toml',
    run: 'codex',
    // Assumes the standard npm-global install (@openai/codex).
    update: 'npm install -g @openai/codex@latest',
  },
  {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    configDir: '~/.grok',
    configFile: '~/.grok/config.toml',
    run: 'grok',
    // Built-in self-updater.
    update: 'grok update',
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    configDir: '~/.config/opencode',
    configFile: '~/.config/opencode/opencode.json',
    run: 'opencode',
    // Built-in self-updater.
    update: 'opencode upgrade',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    bin: 'cursor-agent',
    configDir: '~/.cursor',
    configFile: null,
    run: 'cursor-agent',
    // Built-in self-updater (only meaningful if installed).
    update: 'cursor-agent update',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    configDir: '~/.gemini',
    configFile: '~/.gemini/settings.json',
    run: 'gemini',
    // Assumes the standard npm-global install (@google/gemini-cli).
    update: 'npm install -g @google/gemini-cli@latest',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    configDir: '~/.copilot',
    configFile: null,
    // Update mechanism unknown / varies → no button.
    run: 'copilot',
    update: null,
  },
  {
    id: 'goose',
    label: 'Goose',
    bin: 'goose',
    configDir: '~/.config/goose',
    configFile: '~/.config/goose/config.yaml',
    run: 'goose',
    // Assumes a Homebrew install (block-goose-cli); goose also has
    // `goose update` for the standalone installer.
    update: 'brew upgrade block-goose-cli',
  },
  {
    id: 'droid',
    label: 'Droid',
    bin: 'droid',
    configDir: '~/.factory',
    configFile: null,
    // Update mechanism unknown / varies → no button.
    run: 'droid',
    update: null,
  },
];

const BY_ID = new Map(REGISTRY.map((r) => [r.id, r]));

// The shell used to resolve binaries and run update commands. A POSIX login
// shell picks up the same PATH the user gets in a terminal (Homebrew,
// ~/.local/bin, uv, bun, etc.), which the dev server's environment might miss.
function userShell(command) {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', command]];
  const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return [sh, ['-lc', command]];
}

// Resolve a binary on PATH. Returns absolute path or null.
async function resolveBin(bin) {
  try {
    const [cmd, args] = userShell(
      process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`
    );
    const { stdout } = await execFileP(cmd, args, { timeout: 4000 });
    const p = stdout.split('\n').map((s) => s.trim()).find(Boolean);
    return p || null;
  } catch {
    return null;
  }
}

// Run `<path> --version` and return a trimmed first line, or null on any error.
async function probeVersion(binPath) {
  try {
    const { stdout, stderr } = await execFileP(binPath, ['--version'], {
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const out = (stdout || stderr || '').split('\n').map((s) => s.trim()).find(Boolean);
    return out || null;
  } catch (e) {
    // Some tools print version to stderr then exit non-zero; salvage it.
    const out = ((e && e.stdout) || (e && e.stderr) || '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean);
    return out || null;
  }
}

// Best-effort conversation counts per source, derived from the existing
// conversation registry. Imported lazily so a failure here never breaks the
// agents endpoint.
async function conversationCounts() {
  try {
    const mod = await import('./sources/index.js');
    const convos = await mod.listConversations();
    const counts = {};
    for (const c of convos) counts[c.source] = (counts[c.source] || 0) + 1;
    return counts;
  } catch {
    return {};
  }
}

export async function getAgents() {
  const counts = await conversationCounts();

  return Promise.all(
    REGISTRY.map(async (r) => {
      const binPath = await resolveBin(r.bin);
      const installed = Boolean(binPath);
      const version = installed ? await probeVersion(binPath) : null;

      const configDirAbs = expand(r.configDir);
      const configFileAbs = r.configFile ? expand(r.configFile) : null;

      return {
        id: r.id,
        label: r.label,
        bin: r.bin,
        installed,
        path: binPath,
        version,
        configDir: r.configDir,
        configDirExists: configDirAbs ? fs.existsSync(configDirAbs) : false,
        configFile: r.configFile,
        configFileExists: configFileAbs ? fs.existsSync(configFileAbs) : false,
        runCommand: r.run,
        updateCommand: r.update,
        conversationCount: counts[r.id] ?? 0,
      };
    })
  );
}

// Opens a NEW terminal window running the agent's run command. The command is
// looked up by id from the registry — never taken from the caller. Best-effort
// per platform: macOS Terminal via osascript, Windows via `start cmd /k`,
// Linux via the first common terminal emulator found on PATH.
export function openAgentTerminal(id) {
  const r = BY_ID.get(id);
  if (!r) throw new Error('unknown agent');
  const runCommand = r.run;

  const fire = (cmd, args) => {
    const child = execFile(cmd, args, (err) => { void err; });
    child.on('error', () => {});
  };

  if (process.platform === 'darwin') {
    fire('osascript', [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script ${JSON.stringify(runCommand)}`,
    ]);
    return { ok: true };
  }
  if (process.platform === 'win32') {
    // `start` needs cmd; the run command is a registry literal, not user input.
    fire('cmd.exe', ['/d', '/s', '/c', `start cmd /k ${runCommand}`]);
    return { ok: true };
  }
  // Linux/BSD: try common terminal emulators in order.
  const terms = [
    ['x-terminal-emulator', ['-e', runCommand]],
    ['gnome-terminal', ['--', '/bin/sh', '-c', runCommand]],
    ['konsole', ['-e', runCommand]],
    ['xterm', ['-e', runCommand]],
  ];
  for (const [cmd, args] of terms) {
    try {
      // execFileSync-style probe is overkill; just fire the first that exists.
      if (fs.existsSync(`/usr/bin/${cmd}`) || fs.existsSync(`/usr/local/bin/${cmd}`)) {
        fire(cmd, args);
        return { ok: true };
      }
    } catch { /* try next */ }
  }
  throw new Error('no supported terminal emulator found');
}

// Runs the registry's update command for `id` and returns its output. The
// command comes ONLY from the registry; the caller passes just an id.
export async function updateAgent(id) {
  const r = BY_ID.get(id);
  if (!r) throw new Error('unknown agent');
  if (!r.update) throw new Error('no update command for this agent');

  const tail = (s) => {
    const str = String(s || '');
    return str.length > 4000 ? str.slice(-4000) : str;
  };

  try {
    // Run via the user's shell so PATH (brew/npm/uv/bun) matches their
    // interactive terminal — the dev server's env may be narrower.
    const [cmd, args] = userShell(r.update);
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { ok: true, output: tail(combined) || '(no output)' };
  } catch (e) {
    const combined = [e && e.stdout, e && e.stderr, e && e.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    return { ok: false, output: tail(combined) || '(no output)' };
  }
}
