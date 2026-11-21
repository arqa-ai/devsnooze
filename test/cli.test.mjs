import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, sleep } from '../src/child.mjs';

const BIN = fileURLToPath(new URL('../bin/devsnooze.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const env = { ...process.env, DEVSNOOZE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cli-')) };
const cli = (...a) => execFileSync('node', [BIN, ...a], { env }).toString();
const cliAsync = async (...a) => (await promisify(execFile)('node', [BIN, ...a], { env })).stdout;

test('--help', () => assert.match(cli('--help'), /devsnooze run/));

test('run → ps shows it → stop ends it', async () => {
  const port = await freePort();
  const p = spawn('node', [BIN, 'run', '-p', String(port), '--idle', '5s', '--', 'node', FIXTURE], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('exit', r));
  for (let i = 0; i < 50 && !err.includes('sleeping until'); i++) await sleep(100);
  const r = await fetch(`http://127.0.0.1:${port}/x`);
  assert.equal(r.status, 200);
  const rows = JSON.parse(await cliAsync('ps', '--json'));
  const row = rows.find((x) => x.port === port);
  assert.ok(row, `port ${port} in ps`);
  assert.equal(row.managed, true);
  assert.equal(row.state, 'awake');
  assert.ok(!rows.some((x) => x.managed === false && x.command.includes(FIXTURE)), 'internal child not listed separately');
  assert.match(await cliAsync('stop', '--port', String(port)), /stopped 1\/1/);
  await exited;
  assert.match(err, /awake in/);
});
