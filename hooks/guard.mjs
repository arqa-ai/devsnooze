#!/usr/bin/env node
// PreToolUse(Bash): a command that starts a dev server is sent back with the devsnooze-wrapped version.
// DEVSNOOZE_HOOK=block (default) | warn | off
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyCommand } from '../src/classify.mjs';

const mode = (process.env.DEVSNOOZE_HOOK || 'block').toLowerCase();
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'devsnooze.mjs');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (mode === 'off') return;
  let cmd = '';
  try { cmd = JSON.parse(input)?.tool_input?.command || ''; } catch { return; }
  const quoted = `'${bin.replaceAll("'", "'\\''")}'`;
  const r = classifyCommand(cmd, { wrap: `node ${quoted} run ` });
  if (!r.dev) return;
  const reason = 'This starts a dev server. Dev servers left running eat GBs of RAM after the task is done. ' +
    'Run it through devsnooze instead: port ' + r.port + ' stays open, the real server starts on the first ' +
    'request and stops after 20 min without requests ({port} is the internal port devsnooze hands the tool):\n\n' +
    r.rewritten + '\n\n' +
    'If you only need to verify the code, prefer tests / typecheck / a production build over a dev server. ' +
    'Mention the port in your final answer.';
  const out = mode === 'warn'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  process.stdout.write(JSON.stringify(out));
});
