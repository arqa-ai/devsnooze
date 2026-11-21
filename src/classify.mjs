/**
 * Decide whether a shell command starts a dev server, and how to wrap it in devsnooze.
 * Used by the Claude Code PreToolUse hook.
 *
 * Each tool takes its port its own way (vite/uvicorn/flask/django ignore $PORT), so when the
 * command has no explicit port we add the tool's own flag with a {port} placeholder and use the
 * tool's default port as the public one. The placeholder is always quoted: zsh/bash read an unquoted
 * `{port}` right before a redirect (`{port} > log`) as a named-fd redirection and drop it.
 */
const TOOLS = [
  { re: /\bnext\s+dev(?![\w:-])/, port: 3000, add: " -p '{port}'" },
  { re: /(?:^|[\s/])vite(?:\s+(?:dev|serve))?(?=\s+-|\s*$|\s*[<>])/, port: 5173, add: " --port '{port}'" },
  { re: /\bnpm\s+(?:run\s+)?dev(?![\w:-])/, port: 3000, add: " -- --port '{port}'", addIfDashDash: " --port '{port}'" },
  { re: /\b(?:pnpm|yarn|bun)\s+(?:run\s+)?dev(?![\w:-])/, port: 3000, add: " --port '{port}'" },
  { re: /\b(?:nuxt|nuxi)\s+dev(?![\w:-])/, port: 3000, add: " --port '{port}'" },
  { re: /\bastro\s+dev(?![\w:-])/, port: 4321, add: " --port '{port}'" },
  { re: /\b(?:remix|svelte-kit|vinxi)\s+dev(?![\w:-])/, port: 5173, add: " --port '{port}'" },
  { re: /\bdeno\s+task\s+dev(?![\w:-])/, port: 8000, add: '' },
  { re: /\buvicorn\b.*\s--reload\b/, port: 8000, add: " --port '{port}'" },
  { re: /\bflask\s+run\b/, port: 5000, add: " --port '{port}'" },
  { re: /\brails\s+(?:s|server)\b/, port: 3000, add: " -p '{port}'" },
  { re: /\bmanage\.py\s+runserver\b/, port: 8000, add: " '{port}'", django: true },
];

const NOT_A_RUN = /^(echo|printf|man|grep|egrep|rg|ag|cat|less|more|head|tail|sed|awk|git|which|type|whereis|tldr)$/;
const EXPLICIT_PORT = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d+)\b/;
const ALREADY_WRAPPED = /\bdevsnooze(?:\.mjs)?['"]?\s+(?:run|ps|reap|stop)\b/;

export const WRAP = 'npx -y devsnooze run ';

/** Blank out quoted text and heredoc bodies (keeping length) so they are never matched. */
function mask(s) {
  let out = s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
  out = out.replace(/(<<-?\s*\\?(\w+)[^\n]*\n)([\s\S]*?\n\s*\2\s*(?:\n|$))/g, (_, h, _t, body) => h + body.replace(/[^\n]/g, ' '));
  return out;
}

/** [start, end) ranges of simple commands separated by && || ; | & and newlines (not 2>&1 / &>). */
function segments(masked) {
  const out = [];
  const re = /&&|\|\||[;|\n]|(?<![>&])&(?![>&])/g;
  let last = 0;
  let m;
  while ((m = re.exec(masked))) {
    out.push([last, m.index]);
    last = m.index + m[0].length;
  }
  out.push([last, masked.length]);
  return out;
}

export function classifyCommand(cmd, { wrap = WRAP } = {}) {
  if (ALREADY_WRAPPED.test(cmd)) return { dev: false };
  const masked = mask(cmd);
  for (const [a, b] of segments(masked)) {
    const seg = masked.slice(a, b);
    const tool = TOOLS.find((t) => t.re.test(seg));
    if (!tool) continue;
    const lead = /^\s*(?:[({]\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(seg)[0].length;
    const word = seg.slice(lead).split(/\s+/)[0].split('/').pop();
    if (NOT_A_RUN.test(word) || /(?:^|\s)(?:--help|-h|--version|-v)(?:\s|$)/.test(seg)) continue;
    const at = a + lead;
    const original = cmd.slice(at, b);

    let pub;
    let body = original;
    const explicit = EXPLICIT_PORT.exec(seg);
    const addr = tool.django && /runserver\s+(?:(\S+):)?(\d+)\b/.exec(seg);
    if (explicit) {
      pub = Number(explicit[1]); // devsnooze detects and rewrites -p/--port itself
    } else if (addr) {
      pub = Number(addr[2]);
      body = original.replace(/(runserver\s+(?:\S+:)?)\d+/, "$1'{port}'");
    } else {
      pub = tool.port;
      const m = tool.re.exec(seg.slice(lead));
      const end = m.index + m[0].length;
      const dd = tool.addIfDashDash ? /\s--(?=\s|$)/.exec(seg.slice(lead + end)) : null;
      body = dd // npm: args after an existing `--` go to the script
        ? original.slice(0, end + dd.index + dd[0].length) + tool.addIfDashDash + original.slice(end + dd.index + dd[0].length)
        : original.slice(0, end) + tool.add + original.slice(end);
    }
    const flags = explicit ? '-- ' : `-p ${pub} -- `;
    return { dev: true, port: pub, rewritten: cmd.slice(0, at) + wrap + flags + body + cmd.slice(b) };
  }
  return { dev: false };
}
