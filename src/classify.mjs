/**
 * Decide whether a shell command starts a dev server, and how to wrap it in devsnooze.
 * Used by the Claude Code PreToolUse hook.
 */
const PATTERNS = [
  /\bnext\s+dev(?![\w:-])/,
  /(?:^|[\s/])vite(?:\s+(?:dev|serve))?(?=\s+-|\s*$)/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev(?![\w:-])/,
  /\b(?:nuxt|nuxi|astro|remix|svelte-kit|vinxi)\s+dev(?![\w:-])/,
  /\bdeno\s+task\s+dev(?![\w:-])/,
  /\buvicorn\b.*\s--reload\b/,
  /\bflask\s+run\b/,
  /\brails\s+(?:s|server)\b/,
  /\bmanage\.py\s+runserver\b/,
];

export const WRAP = 'npx -y devsnooze run -- ';

/** Blank out quoted text (keeping length) so `git commit -m "npm run dev"` is not a match. */
function maskQuotes(s) {
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (m) => ' '.repeat(m.length));
}

/** [start, end) ranges of simple commands separated by && || ; | */
function segments(masked) {
  const out = [];
  const re = /&&|\|\||[;|]/g;
  let last = 0;
  let m;
  while ((m = re.exec(masked))) {
    out.push([last, m.index]);
    last = m.index + m[0].length;
  }
  out.push([last, masked.length]);
  return out;
}

export function classifyCommand(cmd) {
  if (/\bdevsnooze\b/.test(cmd)) return { dev: false };
  const masked = maskQuotes(cmd);
  for (const [a, b] of segments(masked)) {
    const seg = masked.slice(a, b);
    if (!PATTERNS.some((re) => re.test(seg))) continue;
    // insert after leading whitespace and VAR=value assignments
    const lead = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(seg)[0].length;
    const at = a + lead;
    return { dev: true, rewritten: cmd.slice(0, at) + WRAP + cmd.slice(at) };
  }
  return { dev: false };
}
