import http from 'node:http';
import net from 'node:net';
import { startChild, stopTree, waitForPort, freePort, groupAlive } from './child.mjs';
import { listProcs, treeRss, treePids, footprints } from './proc.mjs';
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
  maxMem = 4 * 1024 ** 3,
  memCheckMs = 15_000,
  memQuietMs = 60_000, // over the cap, restart only after this long without requests
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
  let closing = false;
  let closed = null;
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
    if (closing) throw new Error('shutting down');
    if (stopping) await stopping;
    if (closing) throw new Error('shutting down');
    if (state === 'awake') return;
    if (starting) return starting;
    starting = (async () => {
      setState('starting');
      const internal = await freePort();
      if (closing) throw new Error('shutting down');
      const h = startChild(argv, { port: internal, cwd, env, stdio });
      child = h;
      starts++;
      let dead = false;
      h.exited.then(({ code, signal, error }) => {
        dead = true;
        if (child !== h) return;
        if (!closing && (state === 'awake' || state === 'starting')) {
          log(`server exited (${error ? error.message : signal || `code ${code}`}); will restart on next request`);
        }
        child = null;
        target = null;
        setState('sleeping');
        // a wrapper (npm, sh) can exit while its children still run: clean the whole group
        if (groupAlive(h.pid)) stopTree(h.pid, { graceMs: 2000 });
      });
      log(`waking: ${argv.join(' ')} (internal port ${internal})`);
      const t0 = Date.now();
      try {
        const h2 = await waitForPort(internal, bootTimeoutMs, () => dead || closing);
        if (closing) throw new Error('shutting down');
        target = { host: h2, port: internal };
        lastActivity = Date.now();
        setState('awake');
        log(`awake in ${formatDuration(Date.now() - t0)} → http://localhost:${port}`);
      } catch (e) {
        await stopTree(h.pid, { graceMs: 2000 });
        if (child === h) { child = null; target = null; setState('sleeping'); }
        if (/did not listen/.test(e.message)) {
          e.message += ". Does the command ignore $PORT or hardcode a port? Put '{port}' where the port goes, " +
            "e.g. `devsnooze run -p 5173 -- vite --port '{port}'`";
        }
        throw e;
      }
    })().finally(() => { starting = null; });
    return starting;
  }

  async function sleepNow(reason) {
    if (state !== 'awake' || stopping || closing) return;
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
    try {
      const beat = isHeartbeat(req.url);
      // tooling pings never wake a sleeping server and never count as use
      if (beat && state !== 'awake') return fail(res, 503, 'server is asleep; reload the page to wake it');
      if (!beat) {
        lastActivity = Date.now();
        inflight++;
        let done = false;
        res.on('close', () => { if (!done) { done = true; inflight--; } });
      }
      try {
        await wake();
      } catch (e) {
        return fail(res, /did not listen/.test(e.message) ? 504 : 502, e.message);
      }
      const t = target;
      if (!t || res.destroyed) return fail(res, 502, 'server went away; retry');
      const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.statusMessage, ur.rawHeaders);
        ur.on('error', () => res.destroy());
        ur.on('aborted', () => res.destroy());
        ur.pipe(res);
      });
      up.on('error', (e) => fail(res, 502, `upstream error: ${e.message}`));
      res.on('close', () => up.destroy());
      req.pipe(up);
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  server.on('upgrade', async (req, sock, head) => {
    sock.on('error', () => {});
    // WebSockets are mostly HMR: they never wake a sleeping server and never count as use.
    // A page load (plain HTTP) wakes it; the page then reconnects its sockets.
    if (state !== 'awake' || closing) return sock.destroy();
    const t = target;
    if (!t) return sock.destroy();
    const up = net.connect(t.port, t.host, () => {
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
    if (sock.destroyed) drop();
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
        const procs = await listProcs();
        lastRss = treeRss(procs, child.pid, await footprints(treePids(procs, child.pid)));
      } catch { return; }
      persist();
      if (maxMem > 0 && lastRss > maxMem && inflight === 0 && Date.now() - lastActivity >= memQuietMs) {
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
      if (closing) return closed;
      closing = true;
      closed = (async () => {
        timers.forEach(clearInterval);
        const done = new Promise((r) => server.close(() => r()));
        server.closeAllConnections?.();
        for (const s of sockets) s.destroy();
        sockets.clear();
        const h = child; // may still be booting: kill it now, don't wait for the boot
        if (h) {
          await stopTree(h.pid, { graceMs });
          await h.exited;
        }
        child = null;
        target = null;
        if (starting) await starting.catch(() => {});
        if (stopping) await stopping.catch(() => {});
        await done;
        removeState(process.pid, port);
      })();
      return closed;
    },
    /** Last resort for process 'exit': synchronous SIGKILL of the child group. */
    killNow() {
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    },
    /** Stop the child now (used by `devsnooze stop` without killing the proxy). */
    sleep: (reason = 'requested') => sleepNow(reason),
    stats: () => ({ state, starts, lastActivity, childPid: child?.pid ?? null, rss: lastRss, port }),
  };
}
