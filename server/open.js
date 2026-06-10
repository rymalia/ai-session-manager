// Opens a filesystem path in the OS default app / file manager.
// Security notes:
//  - The path must exist and be a directory or a regular file (no symlinks to
//    devices, no executing arbitrary binaries — we hand the path to the OS
//    opener, which decides the default handler).
//  - The path is passed to execFile as an args array, never through a shell,
//    so there is no shell-injection surface.

import { execFile } from 'node:child_process';
import fs from 'node:fs';

// Returns [command, prefixArgs] for the current platform's opener.
function opener() {
  switch (process.platform) {
    case 'darwin':
      return ['open', []];
    case 'win32':
      // `explorer` opens files/folders with their default handler. It does not
      // need a shell. (Note: explorer exits non-zero even on success, which we
      // tolerate below.)
      return ['explorer', []];
    default:
      // Linux / *BSD.
      return ['xdg-open', []];
  }
}

export function openPath(target) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('not found');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error('not found');
  }

  if (!fs.existsSync(target)) {
    throw new Error('not found');
  }

  // Only allow a directory or a regular file. Reject sockets, FIFOs, devices.
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error('not found');
  }

  const [cmd, prefix] = opener();

  // Fire and forget: the opener launches the GUI app and we don't wait on it.
  // execFile (no shell) — the path is a literal argument, immune to injection.
  const child = execFile(cmd, [...prefix, target], (err) => {
    // explorer.exe returns a non-zero exit code even when it succeeds, so we
    // intentionally swallow its error. Other openers' errors are ignored too
    // because the process is detached from the request lifecycle by the time
    // this fires; the synchronous validation above is the real guard.
    void err;
  });
  child.on('error', () => {});

  return { ok: true, opened: target };
}
