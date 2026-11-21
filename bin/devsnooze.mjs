#!/usr/bin/env node
import fs from 'node:fs';
import { createSnooze } from '../src/run.mjs';
import { detectPort, sleep } from '../src/child.mjs';
import { parseDuration, parseBytes, formatBytes, formatDuration } from '../src/duration.mjs';
import { collect, formatTable, reapCandidates, killServer } from '../src/ps.mjs';
import { readStates } from '../src/state.mjs';
import { listProcs, listListeners } from '../src/proc.mjs';
import { ownerOf } from '../src/owner.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `devsnooze ${VERSION} — dev servers that sleep when nobody looks at them

Usage:
  devsnooze run [options] -- <command...>   start <command> lazily behind a proxy
      -p, --port N        public port (default: from the command's -p/--port, $PORT, or 3000)
      --idle 20m          stop the server after this long without requests
      --max-mem 3g        restart the server when its process tree grows past this (0 = off)
      --boot-timeout 120s how long to wait for the server to listen
  devsnooze ps [--json]                     list every dev server on this machine
  devsnooze reap [--yes] [--min-age 1h]     stop forgotten servers (dry run without --yes)
  devsnooze stop (--port N | --session ID | --all)   stop devsnooze-managed servers

Examples:
  devsnooze run -- npm run dev -- -p 3007
  devsnooze run --idle 10m -- next dev --turbopack -p {port}
  devsnooze run -p 8000 -- uvicorn app:app --reload --port {port}
`;

function parseFlags(args, spec) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out['--'] = args.slice(i + 1); break; }
    const [k, inline] = a.startsWith('--') ? a.slice(2).split(/=(.*)/s) : [a.startsWith('-') ? spec.alias?.[a] : null];
    if (k && spec.bool?.includes(k)) out[k] = true;
    else if (k && spec.value?.includes(k)) out[k] = inline ?? args[++i];
    else if (a.startsWith('-') && !out._.length) die(`unknown option ${a}\n\n${HELP}`);
    else { out['--'] = args.slice(i); break; }
  }
  return out;
}

function die(msg, code = 1) {
  process.stderr.write(`devsnooze: ${msg}\n`);
  process.exit(code);
}

async function cmdRun(args) {
  const f = parseFlags(args, { value: ['port', 'idle', 'max-mem', 'boot-timeout'], alias: { '-p': 'port' } });
  const argv = f['--'] || [];
  if (!argv.length) die(`no command given\n\n${HELP}`);
  const port = f.port ? Number(f.port) : detectPort(argv);
  const idleMs = parseDuration(f.idle ?? '20m');
  const maxMem = parseBytes(f['max-mem'] ?? '3g');
  const procs = await listProcs().catch(() => []);
  const owner = ownerOf(procs, process.pid);
  const snooze = createSnooze({
    argv, port, idleMs, maxMem,
    bootTimeoutMs: parseDuration(f['boot-timeout'] ?? '120s'),
    meta: { ownerKind: owner.kind, ownerSessionId: owner.sessionId ?? null },
  });
  try {
    await snooze.listen();
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const l = (await listListeners()).find((x) => x.port === port);
    const p = l && procs.find((x) => x.pid === l.pid);
    die(`port ${port} is already in use${p ? ` by pid ${p.pid} (${p.command.slice(0, 60)})` : ''}.\n` +
      `Is the server already running? See \`devsnooze ps\`, or pick another port with -p.`);
  }
  process.stderr.write(`[devsnooze] http://localhost:${port} — sleeping until the first request ` +
    `(idle ${formatDuration(idleMs)}${maxMem ? `, max-mem ${formatBytes(maxMem)}` : ''})\n`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    setTimeout(() => process.exit(0), 15_000).unref();
    await snooze.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
}

async function cmdPs(args) {
  const f = parseFlags(args, { bool: ['json'] });
  const rows = await collect();
  if (f.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No dev servers running.');
  console.log(formatTable(rows));
}

async function cmdReap(args) {
  const f = parseFlags(args, { bool: ['yes'], value: ['min-age'], alias: { '-y': 'yes' } });
  const minAgeSec = parseDuration(f['min-age'] ?? '1h') / 1000;
  const rows = reapCandidates(await collect(), { minAgeSec });
  if (!rows.length) return console.log('Nothing to reap: every unmanaged dev server is either in use, young, busy, or protected.');
  console.log(formatTable(rows));
  if (!f.yes) return console.log('\nDry run. Re-run with --yes to stop these.');
  for (const r of rows) {
    await killServer(r);
    console.log(`stopped :${r.port} (${formatBytes(r.rss)})`);
  }
}

async function cmdStop(args) {
  const f = parseFlags(args, { bool: ['all'], value: ['port', 'session'] });
  if (!f.all && !f.port && !f.session) die('stop needs --port N, --session ID or --all');
  const targets = readStates().filter((s) => f.all || (f.port && s.port === Number(f.port)) ||
    (f.session && s.ownerSessionId === f.session));
  for (const s of targets) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  const end = Date.now() + 15_000;
  const alive = () => targets.filter((s) => { try { process.kill(s.pid, 0); return true; } catch { return false; } });
  while (alive().length && Date.now() < end) await sleep(200);
  console.log(targets.length ? `stopped ${targets.length - alive().length}/${targets.length}: ${targets.map((s) => `:${s.port}`).join(' ')}` : 'no matching devsnooze servers');
}

const [cmd, ...rest] = process.argv.slice(2);
const table = { run: cmdRun, ps: cmdPs, reap: cmdReap, stop: cmdStop };
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') console.log(HELP);
else if (cmd === '-v' || cmd === '--version') console.log(VERSION);
else if (table[cmd]) table[cmd](rest).catch((e) => die(e.stack || e.message));
else die(`unknown command ${cmd}\n\n${HELP}`);
