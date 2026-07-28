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
//
// `configFile` may be a list when a tool accepts more than one well-known
// filename; candidates are listed in preference order and the card reports
// whichever actually exists (see getAgents), so a legitimate config is never
// shown as missing just because it used the second-listed spelling.
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
    // Also ships as a macOS desktop app, which is a real install even though
    // it puts nothing on PATH.
    app: 'OpenCode',
    configDir: '~/.config/opencode',
    // opencode accepts both JSON and JSONC.
    configFile: ['~/.config/opencode/opencode.json', '~/.config/opencode/opencode.jsonc'],
    run: 'opencode',
    // Built-in self-updater (CLI only — the desktop build updates itself).
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
  {
    id: 'kimi',
    label: 'Kimi Code',
    bin: 'kimi',
    configDir: '~/.kimi-code',
    configFile: '~/.kimi-code/config.toml',
    run: 'kimi',
    // Built-in self-updater (`kimi update` is an alias of `upgrade`).
    update: 'kimi upgrade',
  },
];

const BY_ID = new Map(REGISTRY.map((r) => [r.id, r]));

// The shell used to resolve binaries and run update commands. It must be the
// user's ACTUAL login shell, not a hardcoded bash: macOS has defaulted to zsh
// since Catalina, and zsh reads ~/.zshrc only in an INTERACTIVE shell. A plain
// `bash -lc` therefore sees none of the PATH entries a user adds there — which
// is where most per-tool installs land (e.g. ~/.kimi-code/bin) — and reports
// an installed agent as missing. Hence -i for zsh.
function userShell(command) {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', command]];
  const env = process.env.SHELL;
  const sh = env && fs.existsSync(env) ? env : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return [sh, [/(^|\/)zsh$/.test(sh) ? '-lic' : '-lc', command]];
}

// Marker so the PATH survives anything an interactive rc file prints first.
const PATH_MARKER = '__asm_path__';

// The PATH the user actually gets in a terminal. The server's own PATH is not
// enough: it was inherited when the process started, so a tool installed (or a
// PATH entry added) since launch is invisible until a restart. One shell spawn
// per request, not one per agent. The command is a constant — nothing is
// interpolated into it — so there is no injection surface here at all.
async function userPathDirs() {
  const own = (process.env.PATH || '').split(path.delimiter);
  let shellDirs = [];
  try {
    const [cmd, args] = userShell(`printf '${PATH_MARKER}%s' "$PATH"`);
    const { stdout } = await execFileP(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    const i = stdout.lastIndexOf(PATH_MARKER);
    if (i !== -1) {
      shellDirs = stdout.slice(i + PATH_MARKER.length).split('\n')[0].trim().split(path.delimiter);
    }
  } catch {
    // Login shell unavailable or slow — fall back to our own PATH.
  }
  // Union, shell first: a tool the terminal can see should win, but one only
  // the server can see should still be found.
  return [...new Set([...shellDirs, ...own])].filter(Boolean);
}

// Resolve a binary against `dirs`. Returns absolute path or null. Pure fs, so
// it costs nothing per agent and cannot be confused by rc-file chatter.
function resolveBin(bin, dirs) {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(expand(dir), bin + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* next candidate */ }
    }
  }
  return null;
}

// Run `<path> --version` and return a trimmed first line, or null on any error.
// Runs with the terminal's PATH: most of these CLIs are node/bun/python shebang
// scripts, so probing with a narrower PATH than the user's would fail to find
// their own interpreter and report an installed tool as version-less.
async function probeVersion(binPath, dirs) {
  try {
    const { stdout, stderr } = await execFileP(binPath, ['--version'], {
      timeout: 4000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: dirs.join(path.delimiter) },
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

// A tool can be installed as a macOS desktop app instead of a CLI on PATH —
// opencode ships both. Standard bundle locations only; returns the .app path.
const APP_DIRS = ['/Applications', '~/Applications'];

function resolveApp(name) {
  if (process.platform !== 'darwin' || !name) return null;
  for (const dir of APP_DIRS) {
    const p = path.join(expand(dir), `${name}.app`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Version of an app bundle, read from its Info.plist. Deliberately NOT by
// running the executable: these are Electron binaries, and `--version` on one
// opens a window on the user's screen instead of printing anything.
async function appVersion(appPath) {
  try {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plist], {
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    return info.CFBundleShortVersionString || info.CFBundleVersion || null;
  } catch {
    return null;
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
  const [counts, pathDirs] = await Promise.all([conversationCounts(), userPathDirs()]);

  return Promise.all(
    REGISTRY.map(async (r) => {
      // A CLI on PATH wins: it can be driven from a terminal, so it makes the
      // better run target. Fall back to a desktop app bundle.
      const binPath = resolveBin(r.bin, pathDirs);
      const appPath = binPath ? null : resolveApp(r.app);
      const kind = binPath ? 'cli' : appPath ? 'app' : null;
      const installed = Boolean(binPath || appPath);
      const version = binPath
        ? await probeVersion(binPath, pathDirs)
        : appPath
          ? await appVersion(appPath)
          : null;

      const configDirAbs = expand(r.configDir);
      // Report the config file the user actually has, not just the first
      // spelling we happen to list.
      const candidates = r.configFile ? [r.configFile].flat() : [];
      const configFile = candidates.find((f) => fs.existsSync(expand(f))) || candidates[0] || null;
      const configFileAbs = configFile ? expand(configFile) : null;

      return {
        id: r.id,
        label: r.label,
        bin: r.bin,
        installed,
        // 'cli' | 'app' | null — the UI offers a terminal for one and a launch
        // for the other.
        kind,
        path: binPath || appPath,
        version,
        configDir: r.configDir,
        configDirExists: configDirAbs ? fs.existsSync(configDirAbs) : false,
        configFile,
        configFileExists: configFileAbs ? fs.existsSync(configFileAbs) : false,
        runCommand: kind === 'app' ? `open -a ${JSON.stringify(r.app)}` : r.run,
        // The registry's updater is a CLI subcommand; a desktop build ships its
        // own updater, so offering the command would only produce an error.
        updateCommand: kind === 'app' ? null : r.update,
        conversationCount: counts[r.id] ?? 0,
      };
    })
  );
}

// Opens a NEW terminal window running the agent's run command. The command is
// looked up by id from the registry — never taken from the caller. Best-effort
// per platform: macOS Terminal via osascript, Windows via `start cmd /k`,
// Linux via the first common terminal emulator found on PATH.
export async function openAgentTerminal(id) {
  const r = BY_ID.get(id);
  if (!r) throw new Error('unknown agent');
  const runCommand = r.run;

  const fire = (cmd, args) => {
    const child = execFile(cmd, args, (err) => { void err; });
    child.on('error', () => {});
  };

  // Installed as a desktop app and not as a CLI: launch the app. Dropping it
  // into a Terminal window would tie a GUI process to that shell for nothing.
  // The app name is a registry literal and `open` takes an args array.
  if (r.app && !resolveBin(r.bin, await userPathDirs()) && resolveApp(r.app)) {
    fire('open', ['-a', r.app]);
    return { ok: true };
  }

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
