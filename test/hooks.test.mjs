import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const hook = (command, env = {}) => execFileSync('node', [GUARD], {
  input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command } }),
  env: { ...process.env, ...env },
}).toString();

test('guard denies a dev server and gives the wrapped command', () => {
  const out = JSON.parse(hook('cd app && npm run dev -- -p 3007'));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /cd app && node ".*bin\/devsnooze\.mjs" run -- npm run dev -- -p 3007/);
});
test('guard is silent for other commands', () => assert.equal(hook('npm test'), ''));
test('guard warn mode does not block', () => {
  const out = JSON.parse(hook('vite', { DEVSNOOZE_HOOK: 'warn' }));
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /devsnooze/);
});
test('guard off mode', () => assert.equal(hook('vite', { DEVSNOOZE_HOOK: 'off' }), ''));
