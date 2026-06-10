// Helpers shared by every conversation source adapter.
import path from 'node:path';

// True only when `child` is `parent` itself or genuinely nested beneath it.
// Guards against the startsWith() prefix trap where ".../projects-evil" would
// otherwise count as inside ".../projects".
export function isInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(base);
}

// Metadata for each supported tool: display name and accent colour (used by
// the UI for the source badge and the assistant role label).
export const SOURCE_META = {
  claude: { label: 'Claude Code', short: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', short: 'Codex', color: '#10a37f' },
  grok: { label: 'Grok', short: 'Grok', color: '#9b87f5' },
  opencode: { label: 'opencode', short: 'opencode', color: '#f0883e' },
  cursor: { label: 'Cursor', short: 'Cursor', color: '#4d9fff' },
  gemini: { label: 'Gemini CLI', short: 'Gemini', color: '#e6477f' },
  copilot: { label: 'GitHub Copilot CLI', short: 'Copilot', color: '#3fb950' },
  goose: { label: 'Goose', short: 'Goose', color: '#e3b341' },
  droid: { label: 'Droid', short: 'Droid', color: '#ff7b72' },
};

export function clip(str, n = 300) {
  if (typeof str !== 'string') {
    try { str = JSON.stringify(str); } catch { str = String(str); }
  }
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export function toolUseLine(name, input) {
  let s = '';
  if (input != null) {
    try { s = typeof input === 'string' ? input : JSON.stringify(input); } catch { s = ''; }
  }
  return `🔧 ${name || 'tool'}(${clip(s, 300)})`;
}

export function toolResultLine(text) {
  return '↳ ' + clip(typeof text === 'string' ? text : JSON.stringify(text ?? ''), 600);
}

export function thinkingLine(text) {
  return '💭 ' + text;
}

// Tolerant flattener for the assorted "content" shapes used by various CLIs:
// a plain string, an array of strings / {text} / {type:'text',text} / tool
// parts, or an object with a .text field.
export function flattenText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (typeof b.text === 'string') return b.text;
      if (b.type === 'tool_use' || b.type === 'toolRequest' || b.type === 'tool_call')
        return toolUseLine(b.name || b.tool || (b.function && b.function.name), b.input || b.args || b.arguments);
      if (b.type === 'tool_result' || b.type === 'toolResponse' || b.type === 'tool_output')
        return toolResultLine(b.content ?? b.output ?? b.result);
      if (b.type === 'image' || b.type === 'image_url') return '🖼️ [image]';
      return '';
    }).filter(Boolean).join('\n').trim();
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

// Flatten an Anthropic-style content array (text / thinking / tool_use /
// tool_result / image) into one readable string. Shared by Claude and Cursor.
export function flattenAnthropic(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text': parts.push(block.text || ''); break;
      case 'thinking':
        if (block.thinking && block.thinking.trim()) parts.push(thinkingLine(block.thinking));
        break;
      case 'tool_use': parts.push(toolUseLine(block.name, block.input)); break;
      case 'tool_result': {
        let c = block.content;
        if (Array.isArray(c)) c = c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
        parts.push(toolResultLine(c));
        break;
      }
      case 'image': parts.push('🖼️ [image]'); break;
      default: break;
    }
  }
  return parts.join('\n').trim();
}

// The card title shown for a project: the last meaningful path segment of cwd.
// Falls back to the second-to-last when the leaf is a generic wrapper like
// the "cwd" directory grok creates for its remote agents.
export function projectLabel(cwd) {
  if (!cwd) return '(unknown)';
  const parts = cwd.split('/').filter(Boolean);
  let leaf = parts[parts.length - 1] || cwd;
  if ((leaf === 'cwd' || leaf === 'workspace') && parts.length > 1) {
    leaf = parts[parts.length - 2];
  }
  return leaf;
}

// Build a normalised list entry. Every adapter funnels through this so the
// API contract stays identical across sources.
export function makeEntry({
  source, id, ref, title, cwd, gitBranch,
  userCount = 0, assistantCount = 0, messageCount, lastActivity, mtimeMs, firstUserText = '', resume,
}) {
  return {
    source,
    id,
    ref,
    // key must be globally unique for React lists; `ref` is unique per
    // conversation (file path / session id) whereas `id` can collide
    // (e.g. a Cursor session id reused across project folders).
    key: `${source}:${ref}`,
    title: title || (firstUserText ? firstUserText.slice(0, 80) : '(untitled)'),
    projectLabel: projectLabel(cwd),
    projectPath: cwd || '',
    gitBranch: gitBranch || null,
    messageCount: messageCount != null ? messageCount : userCount + assistantCount,
    lastActivity: lastActivity || null,
    mtimeMs: mtimeMs || 0,
    firstUserText: (firstUserText || '').slice(0, 200),
    resume: resume || '',
  };
}

// Quote a cwd for a shell `cd`, only when we actually have one.
export function cdPrefix(cwd) {
  return cwd ? `cd ${JSON.stringify(cwd)} && ` : '';
}
