import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../src/classify.mjs';

const W = 'npx -y devsnooze run ';
const DEV = [
  // explicit port: devsnooze reads and rewrites it itself
  ['cd /w/app && npm run dev -- -p 3007 > /tmp/log 2>&1 &', `cd /w/app && ${W}-- npm run dev -- -p 3007 > /tmp/log 2>&1 &`],
  ['npx next dev --turbopack -p 3008', `${W}-- npx next dev --turbopack -p 3008`],
  ['npx vite --port 5174', `${W}-- npx vite --port 5174`],
  ['uvicorn app:app --reload --port 8001', `${W}-- uvicorn app:app --reload --port 8001`],
  ['yarn dev --port=4000', `${W}-- yarn dev --port=4000`],
  // no port: tool default as the public port, {port} handed to the tool its own way
  ['npm run dev', `${W}-p 3000 -- npm run dev -- --port '{port}'`],
  ['npm run dev -- --turbo', `${W}-p 3000 -- npm run dev -- --port '{port}' --turbo`],
  ['pnpm dev', `${W}-p 3000 -- pnpm dev --port '{port}'`],
  ['bun run dev', `${W}-p 3000 -- bun run dev --port '{port}'`],
  ['next dev', `${W}-p 3000 -- next dev -p '{port}'`],
  ['vite', `${W}-p 5173 -- vite --port '{port}'`],
  ['npx vite > vite.log 2>&1 &', `${W}-p 5173 -- npx vite --port '{port}' > vite.log 2>&1 &`],
  ['uvicorn main:app --reload', `${W}-p 8000 -- uvicorn main:app --reload --port '{port}'`],
  ['flask run', `${W}-p 5000 -- flask run --port '{port}'`],
  ['python manage.py runserver', `${W}-p 8000 -- python manage.py runserver '{port}'`],
  ['python manage.py runserver 0.0.0.0', `${W}-p 8000 -- python manage.py runserver 0.0.0.0:'{port}'`],
  ['python manage.py runserver localhost', `${W}-p 8000 -- python manage.py runserver localhost:'{port}'`],
  ['python manage.py runserver 0.0.0.0:8000', `${W}-p 8000 -- python manage.py runserver 0.0.0.0:'{port}'`],
  ['python manage.py runserver 8002', `${W}-p 8002 -- python manage.py runserver '{port}'`],
  ['python manage.py runserver 0.0.0.0:8001', `${W}-p 8001 -- python manage.py runserver 0.0.0.0:'{port}'`],
  ['bin/rails s', `${W}-p 3000 -- bin/rails s -p '{port}'`],
  ['astro dev', `${W}-p 4321 -- astro dev --port '{port}'`],
  ['PORT=3005 npm run dev', `PORT=3005 ${W}-p 3000 -- npm run dev -- --port '{port}'`],
  ['( cd app && npm run dev )', `( cd app && ${W}-p 3000 -- npm run dev -- --port '{port}' )`],
  ['npm install\nnpm run dev', `npm install\n${W}-p 3000 -- npm run dev -- --port '{port}'`],
  ['npm run build & npm run dev', `npm run build & ${W}-p 3000 -- npm run dev -- --port '{port}'`],
  ["cat > f <<'EOF'\nnpm run dev\nEOF\nnpm run dev", `cat > f <<'EOF'\nnpm run dev\nEOF\n${W}-p 3000 -- npm run dev -- --port '{port}'`],
  ['cd ~/devsnooze-demo && npm run dev', `cd ~/devsnooze-demo && ${W}-p 3000 -- npm run dev -- --port '{port}'`],
];
const NOT_DEV = [
  'npm run build', 'vite build', 'npx vite build', 'next build && next start', 'npm test',
  'git commit -m "npm run dev fix"', 'npx -y devsnooze run -- npm run dev', "node '/p/bin/devsnooze.mjs' run -p 3000 -- vite --port {port}",
  'devsnooze ps', 'grep -r "next dev" .', 'grep -r next dev .', 'echo npm run dev', 'uvicorn app:app --port 8000',
  'cat package.json | grep dev', 'npm run dev:css', 'next dev --help', 'vite --version',
  'cat > README.md <<EOF\nRun `npm run dev` to start\nEOF', 'man next dev',
  "cat > R.md <<'EOF'\nrun npm run dev\nEOF",
  'git commit -F - <<"EOF"\nnpm run dev now works\nEOF',
  "git commit -F - <<'EOF'\ndon't use npm run dev\nEOF",
  "cat <<-'EOF' > notes.md\n\tnext dev is slow\n\tEOF",
];

test('dev-server commands are caught and rewritten', () => {
  for (const [cmd, want] of DEV) {
    const r = classifyCommand(cmd);
    assert.equal(r.dev, true, cmd);
    assert.equal(r.rewritten, want, cmd);
  }
});

test('other commands pass', () => {
  for (const cmd of NOT_DEV) assert.equal(classifyCommand(cmd).dev, false, cmd);
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('rewritten commands keep {port} when run by real shells (zsh named-fd trap)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-shell-'));
  const dump = path.join(dir, 'dump.cjs');
  fs.writeFileSync(dump, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const shells = ['zsh', 'bash'].filter((sh) => { try { execFileSync('which', [sh]); return true; } catch { return false; } });
  assert.ok(shells.length > 0);
  for (const sh of shells) {
    for (const cmd of ['npx vite > OUT 2>&1', 'npm run dev > OUT 2>&1', 'python manage.py runserver 0.0.0.0:8001 > OUT']) {
      const out = path.join(dir, `${sh}.out`);
      const r = classifyCommand(cmd.replaceAll('OUT', out), { wrap: `node ${dump} ` });
      execFileSync(sh, ['-c', r.rewritten], { cwd: dir });
      const argv = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.ok(argv.some((a) => a.includes('{port}')), `${sh}: ${cmd} → ${JSON.stringify(argv)}`);
    }
  }
});
