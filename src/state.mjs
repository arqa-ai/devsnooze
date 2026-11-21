import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = () => process.env.DEVSNOOZE_HOME || path.join(os.homedir(), '.devsnooze');
const runDir = () => path.join(home(), 'run');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
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
