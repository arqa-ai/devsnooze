import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** "02:30" | "06:07:50" | "02-19:11:13" -> seconds */
export function parseEtime(s) {
  let days = 0;
  let rest = s.trim();
  if (rest.includes('-')) [days, rest] = [Number(rest.split('-')[0]), rest.split('-')[1]];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** Parse `ps -axo pid=,ppid=,rss=,etime=,command=` (rss in KiB) */
export function parsePs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, etimeSec: parseEtime(m[4]), command: m[5] });
  }
  return out;
}

export async function listProcs() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command='], { maxBuffer: 32 * 1024 * 1024 });
  return parsePs(stdout);
}

export function childrenMap(procs) {
  const m = new Map();
  for (const p of procs) {
    if (!m.has(p.ppid)) m.set(p.ppid, []);
    m.get(p.ppid).push(p);
  }
  return m;
}

export function descendants(procs, pid, kids = childrenMap(procs)) {
  const out = [];
  const stack = [...(kids.get(pid) || [])];
  while (stack.length) {
    const p = stack.pop();
    out.push(p);
    stack.push(...(kids.get(p.pid) || []));
  }
  return out;
}

export function treePids(procs, pid) {
  return [pid, ...descendants(procs, pid).map((p) => p.pid)];
}

/** Memory of a process tree. `fp` (pid -> bytes) overrides RSS where larger (macOS footprint). */
export function treeRss(procs, pid, fp = new Map()) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return treePids(procs, pid).reduce((s, x) => s + Math.max(byPid.get(x)?.rss || 0, fp.get(x) || 0), 0);
}

const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Parse macOS `footprint --summary -p ...` -> Map(pid -> bytes) */
export function parseFootprint(text) {
  const m = new Map();
  for (const x of text.matchAll(/\[(\d+)\]:.*?Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/g)) {
    m.set(Number(x[1]), Math.round(Number(x[2]) * UNIT[x[3]]));
  }
  return m;
}

/**
 * On macOS, RSS misses compressed and swapped memory — exactly where a bloated dev server lives
 * when RAM is tight. phys_footprint (what Activity Monitor shows) is the honest number.
 */
export async function footprints(pids) {
  if (process.platform !== 'darwin' || !pids.length) return new Map();
  try {
    const { stdout } = await run('footprint', ['--summary', ...pids.flatMap((p) => ['-p', String(p)])], { maxBuffer: 8 * 1024 * 1024 });
    return parseFootprint(stdout);
  } catch (e) {
    return parseFootprint(e.stdout || '');
  }
}

export function ancestors(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = [];
  let cur = byPid.get(pid);
  const seen = new Set();
  while (cur && cur.ppid && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

const portOf = (addr) => Number(/:(\d+)$/.exec(addr)?.[1]);

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` -> [{pid, command, port}] unique by pid+port */
export function parseLsofListen(text) {
  const out = [];
  const seen = new Set();
  let pid = 0;
  let command = '';
  for (const line of text.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') command = val;
    else if (tag === 'n') {
      const port = portOf(val);
      const key = `${pid}:${port}`;
      if (port && !seen.has(key)) {
        seen.add(key);
        out.push({ pid, command, port });
      }
    }
  }
  return out;
}

/** Parse `lsof -nP -iTCP -sTCP:ESTABLISHED -Fpn` -> Map("pid:localPort" -> count) */
export function parseLsofEstablished(text) {
  const m = new Map();
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && line.includes('->')) {
      const key = `${pid}:${portOf(line.slice(1).split('->')[0])}`;
      m.set(key, (m.get(key) || 0) + 1);
    }
  }
  return m;
}

async function lsof(args) {
  try {
    const { stdout } = await run('lsof', args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return e.stdout || ''; // lsof exits 1 when some results are missing
  }
}

export const listListeners = async () => parseLsofListen(await lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
export const listEstablished = async () => parseLsofEstablished(await lsof(['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']));

export async function cwdOf(pid) {
  const out = await lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  return /^n(.*)$/m.exec(out)?.[1] || null;
}
