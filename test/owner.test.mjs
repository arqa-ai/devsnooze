import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePs } from '../src/proc.mjs';
import { ownerOf } from '../src/owner.mjs';
import { isDevServer, isProtected, reapCandidates, serverRoot } from '../src/ps.mjs';

const PS = parsePs(`
    1     0  1000 05-00:00:00 /sbin/launchd
  639     1  1000 05-00:00:00 /Applications/Ghostty.app/Contents/MacOS/ghostty
22303   639  1000 03-00:00:00 -zsh
22761 22303  1000 03-00:00:00 claude --resume abc
27187 22761  1000 02-00:00:00 /bin/zsh -c source /x/snapshot.sh && cd /w && npm run dev -- -p 3007
27188 27187  1000 02-00:00:00 npm run dev -p 3007
27220 27188  1000 02-00:00:00 node /w/node_modules/.bin/next dev --turbopack -p 3007
27225 27220  1000 02-00:00:00 next-server (v15.5.18)
  700   639  1000 01-00:00:00 -zsh
  701   700  1000    10:00 python3 -m http.server 8000
  800     1  1000 01-00:00:00 /Applications/Codex.app/Contents/MacOS/Codex
  801   800  1000    10:00 node /p/node_modules/.bin/vite --port 5173
`);

test('ownerOf: claude session with status from sessions dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', '22761.json'), JSON.stringify({ pid: 22761, sessionId: 'abc-123', name: 'app-ce', status: 'busy' }));
  assert.deepEqual(ownerOf(PS, 27225, { claudeHome: dir }), { kind: 'claude', pid: 22761, sessionId: 'abc-123', name: 'app-ce', status: 'busy' });
});

test('ownerOf: claude without session file still detected', () => {
  assert.equal(ownerOf(PS, 27225, { claudeHome: '/nonexistent' }).kind, 'claude');
});

test('ownerOf: codex and terminal', () => {
  assert.equal(ownerOf(PS, 801, { claudeHome: '/nonexistent' }).kind, 'codex');
  assert.equal(ownerOf(PS, 701, { claudeHome: '/nonexistent' }).kind, 'terminal');
});

test('serverRoot climbs dev-tool parents but stops at shells and agents', () => {
  assert.equal(serverRoot(PS, 27225).pid, 27188); // npm run dev, not the zsh -c wrapper
  assert.equal(serverRoot(PS, 701).pid, 701);
  assert.equal(serverRoot(PS, 801).pid, 801);
});

test('isDevServer / isProtected', () => {
  const yes = ['next-server (v15.5.18)', 'node /x/node_modules/.bin/vite', '/opt/homebrew/Cellar/python@3.13/3.13.5/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python -m uvicorn app:app', 'bun run dev', 'deno task dev', 'ruby bin/rails s'];
  const no = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'com.docker.backend', '/usr/lib/postgresql/16/bin/postgres', 'rapportd', 'claude', '/Applications/Telegram.app/Contents/MacOS/Telegram'];
  for (const c of yes) assert.ok(isDevServer(c), c);
  for (const c of no) assert.ok(!isDevServer(c), c);
  assert.ok(isProtected('node /x/dist/mcp-server.js'));
  assert.ok(!isProtected('next-server (v15.5.18)'));
});

test('reapCandidates: only idle, old, unmanaged, not busy, not protected', () => {
  const base = { managed: false, conn: 0, ageSec: 7200, owner: { kind: 'claude', status: 'idle' }, command: 'next-server', protected: false };
  const rows = [
    { ...base, port: 1 },
    { ...base, port: 2, conn: 1 },
    { ...base, port: 3, ageSec: 60 },
    { ...base, port: 4, managed: true },
    { ...base, port: 5, owner: { kind: 'claude', status: 'busy' } },
    { ...base, port: 6, protected: true },
    { ...base, port: 7, owner: { kind: 'terminal' } },
  ];
  assert.deepEqual(reapCandidates(rows, { minAgeSec: 3600 }).map((r) => r.port), [1, 7]);
});

import { killPlan } from '../src/ps.mjs';
import { writeState, readStates } from '../src/state.mjs';

const PS2 = parsePs(`
    1     0  1000 05-00:00:00 /sbin/launchd
  900     1  1000 01-00:00:00 node /usr/local/bin/claude
  901   900  1000    10:00 node server.js
  902   901  1000    10:00 node worker.js
  950     1  1000 01-00:00:00 node /usr/local/lib/pm2/God.js
  951   950  1000    10:00 node app-a.js
  952   950  1000    10:00 node app-b.js
`);

test('serverRoot never climbs into a node-based agent', () => {
  assert.equal(serverRoot(PS2, 901).pid, 901);
});

test('killPlan: root + descendants', () => {
  assert.deepEqual(killPlan(PS2, { pid: 901, rootPid: 901 }, 12345).map((p) => p.pid).sort(), [901, 902]);
});

test('killPlan refuses pid <= 1, itself and its own ancestors', () => {
  assert.throws(() => killPlan(PS2, { pid: 1, rootPid: 1 }, 902), /refusing/);
  assert.throws(() => killPlan(PS2, { pid: 902, rootPid: 902 }, 902), /refusing/);
  assert.throws(() => killPlan(PS2, { pid: 901, rootPid: 901 }, 902), /refusing/);
});

test('killPlan falls back to the listener subtree when the root also runs unrelated apps', () => {
  // root climbed to a supervisor (pm2) that hosts other apps: only kill the listener
  assert.deepEqual(killPlan(PS2, { pid: 951, rootPid: 950 }, 12345).map((p) => p.pid), [951]);
});

test('readStates drops files whose pid now belongs to a non-devsnooze process (pid reuse)', () => {
  const prev = process.env.DEVSNOOZE_HOME;
  process.env.DEVSNOOZE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-state-'));
  writeState({ pid: 1, port: 1234, lastActivity: Date.now() }); // pid 1 is launchd/init
  assert.deepEqual(readStates(), []);
  process.env.DEVSNOOZE_HOME = prev;
});
