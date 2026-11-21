#!/usr/bin/env node
// SessionEnd: stop dev servers this Claude Code session started — managed (devsnooze) and unmanaged.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collect, killServer } from '../src/ps.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'devsnooze.mjs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let sessionId;
  let reason;
  try { ({ session_id: sessionId, reason } = JSON.parse(input)); } catch { return; }
  if (reason === 'clear') return; // /clear keeps working in the same terminal: keep its servers
  if (!sessionId || process.env.DEVSNOOZE_HOOK === 'off') return;
  try { execFileSync('node', [bin, 'stop', '--session', sessionId], { stdio: 'ignore', timeout: 20_000 }); } catch {}
  try {
    const rows = (await collect()).filter((r) => !r.managed && !r.protected && r.owner.sessionId === sessionId);
    await Promise.all(rows.map((r) => killServer(r, { graceMs: 5000 })));
  } catch {}
});
