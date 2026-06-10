# AI Coding Conversations Viewer

A small Vite + React app that lists your local AI-coding-CLI conversations
across **multiple tools**, lets you search/filter them, preview the last 30
messages, and copy a ready-to-run command to resume any session.

## Supported tools

| Tool | Storage read | Resume command |
|------|--------------|----------------|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | `claude --resume <id>` |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` (+ `session_index.jsonl` for titles) | `codex resume <id>` |
| **Grok** | `~/.grok/sessions/<cwd>/<id>/{summary.json,chat_history.jsonl}` | `grok --resume <id>` |
| **opencode** | `~/.local/share/opencode/opencode.db` (SQLite) | `opencode --session <id>` |
| **Cursor** | `~/.cursor/projects/<cwd>/agent-transcripts/<id>/<id>.jsonl` | `cursor-agent --resume <id>` |
| **Gemini CLI**¹ | `~/.gemini/tmp/<hash>/checkpoint*.json` | `gemini` → `/chat resume <tag>` |
| **GitHub Copilot CLI**¹ | `~/.copilot/history-session-state/*.json` | `copilot --resume <id>` |
| **Goose**¹ | `~/.local/share/goose/sessions/*.jsonl` | `goose session resume --name <id>` |
| **Droid**¹ | `~/.factory/sessions/*.json` | `droid --resume <id>` |

¹ Format-based adapter, written to the tool's documented/expected on-disk
layout. Each returns nothing until that tool is used (or example data is
present); open an issue / tweak the adapter if a real install stores things
differently.

Only the tools that are actually present on the machine show up; a missing or
empty data dir is silently skipped.

## Privacy & security

- **Everything stays local.** The app reads transcripts other CLIs already
  wrote to your home directory and serves them to your own browser. No
  telemetry, no network calls, nothing bundled or uploaded.
- The server binds to **localhost only** (enforced in `vite.config.js`). Don't
  run it with `--host` — the API would serve your private conversation history
  to anyone who can reach the port.
- Every adapter validates its `ref` so the API can only read inside that
  tool's own data directory (path-traversal and sibling-prefix refs are
  rejected — covered by the smoke tests). `/api/open` validates paths and
  spawns the OS opener via `execFile` with an args array, never a shell.

## Platform support

- **macOS** — everything works, including "Open Terminal" in the Agents panel.
- **Linux** — works; folder-open uses `xdg-open`, agent terminals use the
  first of `x-terminal-emulator`/`gnome-terminal`/`konsole`/`xterm` found.
- **Windows** — the viewer and adapters work for tools that use the same
  `~/...` layouts; folder-open uses `explorer`, agent terminals use
  `start cmd /k`. Less battle-tested than macOS/Linux — reports welcome.

## Run

```bash
npm install
npm run dev      # opens http://localhost:5191
npm test         # smoke-test every adapter + endpoint against your local data
npm run build && npm run preview   # serve the production build (API included)
```

The API runs as a Vite middleware on **both** the dev server and the preview
server, so the built `dist/` works end-to-end via `npm run preview` (it still
reads your local transcripts — nothing is bundled or sent anywhere).

Requires Node 24+ (the opencode adapter uses the built-in `node:sqlite`).

`npm test` (`scripts/smoke-test.mjs`) lists every source, fetches a detail per
source, and validates the data contract (unique keys, no missing fields / future
timestamps, valid message roles, newest-first ordering), plus the usage and
open-path modules. Exits non-zero on any failure. On a machine with no AI-CLI
data yet, the data-dependent checks are skipped.

### Run at startup (optional)

With [pm2](https://pm2.keymetrics.io/):

```bash
pm2 start npm --name conversations-viewer --cwd /path/to/this/repo -- run dev
pm2 save
pm2 startup   # follow the printed instructions for your OS
```

## How it works

- A tiny dev-server API (in `vite.config.js`) delegates to one **source adapter**
  per tool under `server/sources/`. Each adapter exports `{ source, list, detail }`
  and returns a normalised record, so the API contract is identical across tools.
  `server/sources/index.js` aggregates them — a failing source is skipped rather
  than taking the whole response down.
- `GET /api/conversations` returns one entry per top-level session (source, title,
  project, branch, message count, last activity, ready-to-run resume command),
  merged across tools and sorted most-recent first. Summaries are cached by
  file/row mtime so reloads are instant.
- `GET /api/conversation?source=…&ref=…` returns the last 30 messages for one
  session. Each adapter validates its own `ref` (path must stay within that
  tool's data dir; opencode session ids are pattern-checked).
- `GET /api/sources` returns display metadata (label + accent colour) per tool.

## Adding another tool

Drop a `server/sources/<tool>.js` that exports `source`, `list()`, and
`detail(ref, lastN)` (return normalised entries via `makeEntry` from
`_shared.js`), then register it in `server/sources/index.js` and add an entry to
`SOURCE_META`. No other code needs to change.

## Features

- **Search** across title, project, path, session id, tool name, and first message.
- **Filter** by tool (chips with per-tool counts) and by project (dropdown,
  scoped to the active tool).
- **Sort** by most recent / oldest / most messages / title / tool.
- **Filters persist** across refresh (search, tool, project, sort, and the stats
  toggle are saved to `localStorage` under `ccv.filters`).
- **Expand** any card to read the last 30 messages, color-coded and labelled with
  the originating assistant (Claude / Codex / Grok / opencode / Cursor / …), with
  tool calls and results inlined.
- **Copy resume command** — the exact `cd "<cwd>" && <tool> resume …` for that tool.
- **Open** — opens the conversation's project folder in the OS file manager
  (`GET /api/open` → `open`/`xdg-open`/`explorer`, path-validated, no shell).
- **Stats panel** (📊 toggle):
  - *Metrics* (`src/Metrics.jsx`) — conversations per tool, top projects, and a
    30-day activity sparkline, all hand-rolled inline SVG (no chart lib).
  - *Usage & quota* (`server/usage.js` → `GET /api/usage`) — per-tool usage read
    from local data: Codex rate-limit **quota left**, opencode/Claude/Grok token
    totals, Cursor edit-tracking; Gemini marked N/A (no local data). Read-only.
- **PWA** — installable (`public/manifest.webmanifest`, `public/sw.js`,
  icons; registered via `src/pwa.js`). The service worker is network-first so it
  never serves stale content and doesn't interfere with dev/HMR; `/api/*` is
  always network.

## License

[MIT](LICENSE)
