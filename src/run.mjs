import http from 'node:http';
import net from 'node:net';
import { startChild, stopTree, waitForPort, freePort } from './child.mjs';
import { listProcs, treeRss } from './proc.mjs';
import { writeState, removeState } from './state.mjs';
import { formatBytes, formatDuration } from './duration.mjs';

/** Requests dev tooling makes on its own; they must not count as "someone is looking". */
const HEARTBEAT = [/^\/_next\/webpack-hmr/, /^\/__vite_ping/, /^\/__webpack_hmr/, /^\/_next\/static\/webpack\/.*\.hot-update\./];
export const isHeartbeat = (url = '') => HEARTBEAT.some((re) => re.test(url));

/**
 * A port that is always open; the real dev server behind it runs only while used.
 */
export function createSnooze({
  argv,
  port,
  host = undefined, // listen on all interfaces like dev servers do
  idleMs = 20 * 60_000,
  maxMem = 3 * 1024 ** 3,
  memCheckMs = 15_000,
  bootTimeoutMs = 120_000,
  graceMs = 10_000,
  cwd = process.cwd(),
  env = process.env,
  stdio = 'inherit',
  meta = {},
  log = (msg) => process.stderr.write(`[devsnooze] ${msg}\n`),
}) {
  let state = 'sleeping'; // sleeping | starting | awake | stopping
  let child = null;
  let target = null; // { host, port }
  let starting = null;
  let stopping = null;
  let starts = 0;
  let inflight = 0;
  let lastActivity = Date.now();
  let lastRss = 0;
  const sockets = new Set();
  const timers = [];

  const persist = () => {
    try {
      writeState({ pid: process.pid, port, cwd, command: argv.join(' '), state, childPid: child?.pid ?? null,
        internalPort: target?.port ?? null, lastActivity, starts, rss: lastRss, idleMs, maxMem, ...meta });
    } catch {}
  };
  const setState = (s) => { state = s; persist(); };

  async function wake() {
    if (stopping) await stopping;
    if (state === 'awake') return;
    if (starting) return starting;
    starting = (async () => {
      setState('starting');
      const internal = await freePort();
      const h = startChild(argv, { port: internal, cwd, env, stdio });
      child = h;
      starts++;
      let dead = false;
      h.exited.then(({ code, signal, error }) => {
        dead = true;
        if (child !== h) return;
        if (state === 'awake' || state === 'starting') {
          log(`server exited (${error ? error.message : signal || `code ${code}`}); will restart on next request`);
        }
        child = null;
        target = null;
        setState('sleeping');
      });
      log(`waking: ${argv.join(' ')} (internal port ${internal})`);
      const t0 = Date.now();
      try {
        const h2 = await waitForPort(internal, bootTimeoutMs, () => dead);
        target = { host: h2, port: internal };
        lastActivity = Date.now();
        setState('awake');
        log(`awake in ${formatDuration(Date.now() - t0)} → http://localhost:${port}`);
      } catch (e) {
        await stopTree(h.pid, { graceMs: 2000 });
        if (child === h) { child = null; setState('sleeping'); }
        throw e;
      }
    })().finally(() => { starting = null; });
    return starting;
  }

  async function sleepNow(reason) {
    if (state !== 'awake' || stopping) return;
    const h = child;
    setState('stopping');
    stopping = (async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await stopTree(h.pid, { graceMs });
      await h.exited;
      if (child === h) child = null;
      target = null;
      setState('sleeping');
      log(`asleep (${reason}); next request wakes it`);
    })().finally(() => { stopping = null; });
    return stopping;
  }

  const fail = (res, code, msg) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`devsnooze: ${msg}\n`);
  };

  const server = http.createServer(async (req, res) => {
    if (!isHeartbeat(req.url)) lastActivity = Date.now();
    inflight++;
    let done = false;
    const finish = () => { if (!done) { done = true; inflight--; } };
    res.on('close', finish);
    try {
      await wake();
    } catch (e) {
      return fail(res, /did not listen/.test(e.message) ? 504 : 502, e.message);
    }
    const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
      ur.pipe(res);
    });
    up.on('error', (e) => fail(res, 502, `upstream error: ${e.message}`));
    req.pipe(up);
  });

  server.on('upgrade', async (req, sock, head) => {
    lastActivity = Date.now();
    sock.on('error', () => {});
    try {
      await wake();
    } catch {
      return sock.destroy();
    }
    const up = net.connect(target.port, target.host, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${raw}\r\n`);
      if (head?.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    sockets.add(sock);
    sockets.add(up);
    const drop = () => { sockets.delete(sock); sockets.delete(up); sock.destroy(); up.destroy(); };
    up.on('error', drop);
    up.on('close', drop);
    sock.on('close', drop);
  });

  const tick = Math.max(50, Math.min(Math.floor(idleMs / 3), 5000));
  function startTimers() {
    timers.push(setInterval(() => {
      if (state === 'awake' && inflight === 0 && Date.now() - lastActivity > idleMs) {
        sleepNow(`idle ${formatDuration(Date.now() - lastActivity)}`);
      }
    }, tick));
    timers.push(setInterval(async () => {
      if (state !== 'awake' || !child) return;
      try {
        lastRss = treeRss(await listProcs(), child.pid);
      } catch { return; }
      persist();
      if (maxMem > 0 && lastRss > maxMem && inflight === 0) {
        sleepNow(`using ${formatBytes(lastRss)} > --max-mem ${formatBytes(maxMem)}, restarting fresh`);
      }
    }, memCheckMs));
    for (const t of timers) t.unref();
  }

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          startTimers();
          persist();
          resolve();
        });
      });
    },
    async close() {
      timers.forEach(clearInterval);
      if (starting) await starting.catch(() => {});
      if (stopping) await stopping;
      if (child) {
        for (const s of sockets) s.destroy();
        const h = child;
        await stopTree(h.pid, { graceMs });
        await h.exited;
        child = null;
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      removeState(process.pid, port);
    },
    /** Stop the child now (used by `devsnooze stop` without killing the proxy). */
    sleep: (reason = 'requested') => sleepNow(reason),
    stats: () => ({ state, starts, lastActivity, childPid: child?.pid ?? null, rss: lastRss, port }),
  };
}
