import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const home = () => process.env.DEVSNOOZE_HOME || path.join(os.homedir(), '.devsnooze');
const runDir = () => path.join(home(), 'run');

/** Live AND still a devsnooze process — a crashed proxy's pid may have been reused by anything. */
function alive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString().includes('devsnooze');
  } catch {
    return false;
  }
}

export function stateFile(pid, port) {
  return path.join(runDir(), `${pid}-${port}.json`);
}

export function writeState(st) {
  fs.mkdirSync(runDir(), { recursive: true });
  const file = stateFile(st.pid, st.port);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(st));
  fs.renameSync(`${file}.tmp`, file);
}

export function removeState(pid, port) {
  fs.rmSync(stateFile(pid, port), { force: true });
}

/** All live proxies' states; files of dead proxies are deleted. */
export function readStates() {
  let names = [];
  try { names = fs.readdirSync(runDir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(runDir(), n);
    try {
      const st = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (alive(st.pid)) out.push(st);
      else fs.rmSync(file, { force: true });
    } catch {}
  }
  return out;
}
