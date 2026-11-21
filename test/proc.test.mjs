import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, parseEtime, treeRss, ancestors, parseLsofListen, parseLsofEstablished } from '../src/proc.mjs';

const PS = `
    1     0  12000 05-18:30:11 /sbin/launchd
  639     1 150000 05-00:00:00 /Applications/Ghostty.app/Contents/MacOS/ghostty
22761   639 500000 03-03:19:44 claude
27188 22761  30000 02-21:07:18 npm run dev -p 3007
27220 27188  60000 02-21:07:18 node /x/node_modules/.bin/next dev --turbopack -p 3007
27225 27220 4000000    02:30 next-server (v15.5.18)
`;

test('parseEtime', () => {
  assert.equal(parseEtime('02:30'), 150);
  assert.equal(parseEtime('06:07:50'), 6 * 3600 + 7 * 60 + 50);
  assert.equal(parseEtime('02-19:11:13'), 2 * 86400 + 19 * 3600 + 11 * 60 + 13);
});

test('parsePs', () => {
  const p = parsePs(PS);
  assert.equal(p.length, 6);
  assert.deepEqual(p[3], { pid: 27188, ppid: 22761, rss: 30000 * 1024, etimeSec: 2 * 86400 + 21 * 3600 + 7 * 60 + 18, command: 'npm run dev -p 3007' });
  assert.equal(p[5].command, 'next-server (v15.5.18)');
});

test('treeRss sums descendants', () => {
  const p = parsePs(PS);
  assert.equal(treeRss(p, 27188), (30000 + 60000 + 4000000) * 1024);
  assert.equal(treeRss(p, 27225), 4000000 * 1024);
});

test('ancestors walks up to launchd', () => {
  const p = parsePs(PS);
  assert.deepEqual(ancestors(p, 27225).map((x) => x.pid), [27220, 27188, 22761, 639, 1]);
});

test('parseLsofListen dedupes and reads ports', () => {
  const txt = 'p617\ncrapportd\nf8\nn*:58801\nf9\nn*:58801\np27225\ncnode\nf20\nn*:3007\nf21\nn[::1]:3007\n';
  assert.deepEqual(parseLsofListen(txt), [
    { pid: 617, command: 'rapportd', port: 58801 },
    { pid: 27225, command: 'node', port: 3007 },
  ]);
});

test('parseLsofEstablished counts inbound connections per local port', () => {
  const txt = 'p27225\nf30\nn127.0.0.1:3007->127.0.0.1:50001\nf31\nn[::1]:3007->[::1]:50002\np999\nf5\nn127.0.0.1:50001->127.0.0.1:3007\n';
  const m = parseLsofEstablished(txt);
  assert.equal(m.get('27225:3007'), 2);
  assert.equal(m.get('999:50001'), 1);
});
