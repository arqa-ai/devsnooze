import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectPort, detectPort, startChild, stopTree, waitForPort } from '../src/child.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

test('injectPort: placeholder', () => {
  assert.deepEqual(injectPort(['next', 'dev', '-p', '{port}'], 5001).argv, ['next', 'dev', '-p', '5001']);
});
test('injectPort: -p and --port rewrite', () => {
  assert.deepEqual(injectPort(['next', 'dev', '-p', '3007'], 5001).argv, ['next', 'dev', '-p', '5001']);
  assert.deepEqual(injectPort(['vite', '--port', '3007'], 5001).argv, ['vite', '--port', '5001']);
  assert.deepEqual(injectPort(['vite', '--port=3007'], 5001).argv, ['vite', '--port=5001']);
});
test('injectPort: env fallback', () => {
  const r = injectPort(['npm', 'run', 'dev'], 5001);
  assert.deepEqual(r.argv, ['npm', 'run', 'dev']);
  assert.equal(r.env.PORT, '5001');
});
test('injectPort: always sets PORT env too', () => {
  assert.equal(injectPort(['next', 'dev', '-p', '3007'], 5001).env.PORT, '5001');
});
test('detectPort', () => {
  assert.equal(detectPort(['next', 'dev', '-p', '3007'], {}), 3007);
  assert.equal(detectPort(['vite', '--port=4000'], {}), 4000);
  assert.equal(detectPort(['npm', 'run', 'dev'], { PORT: '3100' }), 3100);
  assert.equal(detectPort(['npm', 'run', 'dev'], {}), 3000);
});

test('startChild + waitForPort + stopTree kills the whole tree', async () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  // sh -> node: stopTree must kill the grandchild too
  const h = startChild(['sh', '-c', `node ${FIXTURE}`], { port, stdio: 'ignore' });
  await waitForPort(port, 10000);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  await stopTree(h.pid, { graceMs: 2000 });
  await h.exited;
  const out = execFileSync('sh', ['-c', `ps -axo pgid=,pid= | awk '$1==${h.pid}' | wc -l`]).toString().trim();
  assert.equal(out, '0');
});
