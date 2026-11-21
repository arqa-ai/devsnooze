import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSnooze } from '../src/run.mjs';
import { freePort, sleep } from '../src/child.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsnooze-test-'));
process.env.DEVSNOOZE_HOME = tmp;
let open = [];
afterEach(async () => { await Promise.all(open.map((s) => s.close())); open = []; });

async function setup({ env: extraEnv = {}, ...opts } = {}) {
  const port = await freePort();
  const startsFile = path.join(tmp, `starts-${port}`);
  const s = createSnooze({
    argv: ['node', FIXTURE],
    port,
    idleMs: 60_000,
    maxMem: 0,
    env: { ...process.env, STARTS_FILE: startsFile, ...extraEnv },
    stdio: 'ignore',
    log: () => {},
    ...opts,
  });
  open.push(s);
  await s.listen();
  const starts = () => (fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim().split('\n').length : 0);
  const get = (p = '/') => fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => ({ status: r.status, text: await r.text() }));
  return { s, port, starts, get };
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('condition not met in time');
}

test('does not start the server until the first request', async () => {
  const { s, starts, get } = await setup();
  await sleep(300);
  assert.equal(starts(), 0);
  assert.equal(s.stats().state, 'sleeping');
  const r = await get('/hello');
  assert.equal(r.status, 200);
  assert.match(r.text, /^ok \/hello/);
  assert.equal(starts(), 1);
  assert.equal(s.stats().state, 'awake');
});

test('sleeps after idle and wakes on the next request', async () => {
  const { s, starts, get } = await setup({ idleMs: 300 });
  await get('/');
  await until(() => s.stats().state === 'sleeping');
  assert.equal((await get('/again')).status, 200);
  assert.equal(starts(), 2);
});

test('HMR heartbeats do not keep it awake', async () => {
  const { s, get } = await setup({ idleMs: 400 });
  await get('/');
  const end = Date.now() + 1500;
  let sawSleep = false;
  while (Date.now() < end) {
    if (s.stats().state === 'sleeping') { sawSleep = true; break; }
    if (s.stats().state === 'awake') await get('/_next/webpack-hmr').catch(() => {});
    await sleep(100);
  }
  assert.ok(sawSleep, 'server should fall asleep despite heartbeats');
});

test('real requests keep it awake', async () => {
  const { s, starts, get } = await setup({ idleMs: 400 });
  for (let i = 0; i < 10; i++) { await get('/page'); await sleep(100); }
  assert.equal(s.stats().state, 'awake');
  assert.equal(starts(), 1);
});

test('proxies WebSocket upgrades', async () => {
  const { port } = await setup();
  const sock = net.connect(port, '127.0.0.1');
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
  await until(() => buf.includes('\r\n\r\n'), 10000);
  assert.match(buf.toString(), /101 Switching Protocols/);
  buf = Buffer.alloc(0);
  const payload = Buffer.from('hi');
  const mask = Buffer.from([1, 2, 3, 4]);
  sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))]));
  await until(() => buf.length >= 4);
  assert.equal(buf.subarray(2).toString(), 'hi');
  sock.destroy();
});

test('stops a server that grows over --max-mem', async () => {
  const { s, starts, get } = await setup({ maxMem: 20 * 1024 * 1024, memCheckMs: 200, env: { ALLOC_MB: '60' } });
  await get('/');
  await until(() => s.stats().state === 'sleeping', 5000);
  assert.equal(starts(), 1);
  assert.equal((await get('/')).status, 200);
  assert.equal(starts(), 2);
});

test('writes and removes a state file', async () => {
  const { s, port } = await setup();
  const file = path.join(tmp, 'run', `${process.pid}-${port}.json`);
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, port);
  await s.close();
  assert.ok(!fs.existsSync(file));
});

test('returns 502 with an explanation when the command dies', async () => {
  const port = await freePort();
  const s = createSnooze({ argv: ['node', '-e', 'process.exit(3)'], port, idleMs: 60000, maxMem: 0, stdio: 'ignore', log: () => {} });
  open.push(s);
  await s.listen();
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 502);
  assert.match(await r.text(), /devsnooze/);
});
