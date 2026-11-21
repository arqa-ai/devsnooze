import { spawn } from 'node:child_process';
import net from 'node:net';

const PORT_FLAGS = new Set(['-p', '--port']);

/** Find the port the user asked for in the command line, else $PORT, else 3000. */
export function detectPort(argv, env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    if (PORT_FLAGS.has(argv[i]) && /^\d+$/.test(argv[i + 1] ?? '')) return Number(argv[i + 1]);
    const m = /^--port=(\d+)$/.exec(argv[i]);
    if (m) return Number(m[1]);
  }
  if (env.PORT && /^\d+$/.test(env.PORT)) return Number(env.PORT);
  return 3000;
}

/**
 * Point the child at an internal port: replace {port}, else rewrite -p/--port, else rely on $PORT.
 * PORT env is always set as well (harmless for tools that ignore it).
 */
export function injectPort(argv, port) {
  const p = String(port);
  let out;
  if (argv.some((a) => a.includes('{port}'))) {
    out = argv.map((a) => a.replaceAll('{port}', p));
  } else {
    out = argv.map((a, i) => {
      if (PORT_FLAGS.has(argv[i - 1]) && /^\d+$/.test(a)) return p;
      if (/^--port=\d+$/.test(a)) return `--port=${p}`;
      return a;
    });
  }
  return { argv: out, env: { PORT: p } };
}

/** Spawn in its own process group so the whole tree can be signalled at once. */
export function startChild(argv, { port, cwd = process.cwd(), env = process.env, stdio = 'inherit' } = {}) {
  const inj = injectPort(argv, port);
  const child = spawn(inj.argv[0], inj.argv.slice(1), {
    cwd,
    env: { ...env, ...inj.env },
    stdio,
    detached: true,
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (err) => resolve({ code: -1, signal: null, error: err }));
  });
  return { pid: child.pid, child, exited };
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process group, SIGKILL after graceMs. Resolves when the group is gone. */
export async function stopTree(pgid, { graceMs = 10_000 } = {}) {
  if (!pgid || !groupAlive(pgid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
    while (groupAlive(pgid)) await sleep(50);
  }
}

const HOSTS = ['127.0.0.1', '::1'];

/** Which loopback host accepts TCP on port, or null. */
export function probePort(port) {
  return new Promise((resolve) => {
    let pending = HOSTS.length;
    let done = false;
    for (const host of HOSTS) {
      const s = net.connect({ port, host });
      s.once('connect', () => { s.destroy(); if (!done) { done = true; resolve(host); } });
      s.once('error', () => { if (--pending === 0 && !done) resolve(null); });
    }
  });
}

export async function waitForPort(port, timeoutMs, isDead = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = await probePort(port);
    if (host) return host;
    if (isDead()) throw new Error('server process exited before listening');
    await sleep(150);
  }
  throw new Error(`server did not listen on port ${port} within ${timeoutMs}ms`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
