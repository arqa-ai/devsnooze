import { listProcs, listListeners, listEstablished, treeRss, treePids, footprints, descendants, ancestors, cwdOf } from './proc.mjs';
import { ownerOf, tokens } from './owner.mjs';
import { readStates } from './state.mjs';
import { formatBytes, formatDuration } from './duration.mjs';
import { sleep } from './child.mjs';

const RUNTIME = /^(node|bun|deno|python[\d.]*|Python|ruby|php|next-server|uvicorn|gunicorn|hypercorn|granian|air|rails)$/;
const NOT_DEV = /^\/(Applications|System|Library)\/|docker|postgres|redis|mysql|mongod|ollama|Helper|clickhouse/i;
const AGENTS = /^(claude|codex|cursor-agent)$/;
const DEV_TOOLS = /^(node|npm|npx|pnpm|yarn|bun|bunx|deno|uv|uvx|python[\d.]*|Python|poetry|pipenv|turbo|nx|concurrently|nodemon|tsx)$/;

export function isDevServer(command) {
  if (NOT_DEV.test(command)) return false;
  const [t0, t1] = tokens(command);
  if (AGENTS.test(t0) || AGENTS.test(t1 || '')) return false;
  return RUNTIME.test(t0);
}

/** MCP servers and the like are shown but never reaped. */
export const isProtected = (command) => /\bmcp\b|mcp[-_]|[-_]mcp/i.test(command);

/** Topmost ancestor that is still part of the dev tool chain (npm → node → next-server). */
export function serverRoot(procs, pid) {
  let root = procs.find((p) => p.pid === pid);
  for (const p of ancestors(procs, pid)) {
    const [t0] = tokens(p.command);
    if (!DEV_TOOLS.test(t0) || isProtected(p.command)) break;
    root = p;
  }
  return root;
}

export function reapCandidates(rows, { minAgeSec = 3600 } = {}) {
  return rows.filter((r) => !r.managed && !r.protected && r.conn === 0 && r.ageSec >= minAgeSec &&
    !(r.owner.kind === 'claude' && r.owner.status === 'busy'));
}

/** Every dev server listening on this machine. */
export async function collect({ claudeHome } = {}) {
  const [procs, listeners, established] = await Promise.all([listProcs(), listListeners(), listEstablished()]);
  const states = readStates();
  const internal = new Set(states.map((s) => s.internalPort).filter(Boolean));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rows = new Map();
  const now = Date.now();

  for (const l of listeners.sort((a, b) => a.port - b.port)) {
    if (internal.has(l.port)) continue;
    const proc = byPid.get(l.pid);
    if (!proc) continue;
    const conn = established.get(`${l.pid}:${l.port}`) || 0;
    const st = states.find((s) => s.pid === l.pid && s.port === l.port);
    if (st) {
      rows.set(`m${l.pid}:${l.port}`, {
        port: l.port, pid: l.pid, managed: true, state: st.state,
        rss: treeRss(procs, l.pid), conn, idleMs: now - st.lastActivity, ageSec: proc.etimeSec,
        owner: ownerOf(procs, l.pid, { claudeHome }), dir: st.cwd, command: st.command, protected: false,
      });
      continue;
    }
    if (!isDevServer(proc.command)) continue;
    const root = serverRoot(procs, l.pid);
    const key = `u${root.pid}`;
    if (rows.has(key)) { rows.get(key).conn += conn; rows.get(key).ports.push(l.port); continue; }
    rows.set(key, {
      port: l.port, ports: [l.port], pid: l.pid, rootPid: root.pid, managed: false, state: 'unmanaged',
      rss: treeRss(procs, root.pid), conn, idleMs: null, ageSec: root.etimeSec,
      owner: ownerOf(procs, root.pid, { claudeHome }), dir: null, command: root.command,
      protected: isProtected(root.command) || isProtected(proc.command),
    });
  }
  const out = [...rows.values()];
  const roots = out.map((r) => r.rootPid ?? r.pid);
  const fp = await footprints(roots.flatMap((pid) => treePids(procs, pid)));
  out.forEach((r, i) => { r.rss = treeRss(procs, roots[i], fp); });
  await Promise.all(out.filter((r) => !r.dir).map(async (r) => { r.dir = await cwdOf(r.rootPid ?? r.pid); }));
  return out;
}

const shortHome = (p) => (p ? p.replace(process.env.HOME || '\0', '~') : '?');
const ownerLabel = (o) => (o.kind === 'claude' ? `claude:${o.name || o.sessionId?.slice(0, 8) || o.pid}${o.status ? `(${o.status})` : ''}` : o.kind);

export function formatTable(rows) {
  const head = ['PORT', 'STATE', 'RAM', 'CONN', 'IDLE/AGE', 'OWNER', 'DIR', 'CMD'];
  const body = rows.map((r) => [
    String(r.ports?.join(',') || r.port),
    r.state + (r.protected ? '*' : ''),
    formatBytes(r.rss),
    String(r.conn),
    r.managed ? `idle ${formatDuration(r.idleMs)}` : `age ${formatDuration(r.ageSec * 1000)}`,
    ownerLabel(r.owner),
    shortHome(r.dir),
    r.command.length > 50 ? `${r.command.slice(0, 47)}...` : r.command,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cols) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  const total = rows.reduce((s, r) => s + r.rss, 0);
  return [line(head), ...body.map(line), '', `${rows.length} dev servers, ${formatBytes(total)} total` +
    (rows.some((r) => r.protected) ? '  (* protected, never reaped)' : '')].join('\n');
}

/** SIGTERM the server tree (root + descendants), SIGKILL whatever survives graceMs. */
export async function killServer(row, { graceMs = 10_000 } = {}) {
  const procs = await listProcs();
  const root = row.rootPid ?? row.pid;
  const pids = [root, ...descendants(procs, root).map((p) => p.pid)];
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const end = Date.now() + graceMs;
  while (alive().length && Date.now() < end) await sleep(200);
  for (const pid of alive()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
