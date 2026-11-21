import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ancestors } from './proc.mjs';

const base = (s = '') => s.split('/').pop();
export const tokens = (command) => command.trim().split(/\s+/).map(base);

function claudeSession(claudeHome, pid) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(claudeHome, 'sessions', `${pid}.json`), 'utf8'));
    return { sessionId: d.sessionId, name: d.name, status: d.status };
  } catch {
    return {};
  }
}

/** Who started this process: a Claude Code session, Codex, Cursor, or a plain terminal. */
export function ownerOf(procs, pid, { claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  for (const p of ancestors(procs, pid)) {
    const [t0, t1] = tokens(p.command);
    if (t0 === 'claude' || (t0 === 'node' && t1 === 'claude')) {
      return { kind: 'claude', pid: p.pid, ...claudeSession(claudeHome, p.pid) };
    }
    if (/codex/i.test(t0) || p.command.includes('Codex.app')) return { kind: 'codex', pid: p.pid };
    if (p.command.includes('Cursor.app') || t0 === 'cursor-agent') return { kind: 'cursor', pid: p.pid };
  }
  return { kind: 'terminal' };
}
