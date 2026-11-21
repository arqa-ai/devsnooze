import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../src/classify.mjs';

const DEV = [
  ['npm run dev', 'npx -y devsnooze run -- npm run dev'],
  ['cd /w/app && npm run dev -- -p 3007 > /tmp/log 2>&1 &', 'cd /w/app && npx -y devsnooze run -- npm run dev -- -p 3007 > /tmp/log 2>&1 &'],
  ['pnpm dev', 'npx -y devsnooze run -- pnpm dev'],
  ['yarn dev --port 4000', 'npx -y devsnooze run -- yarn dev --port 4000'],
  ['bun run dev', 'npx -y devsnooze run -- bun run dev'],
  ['npx next dev --turbopack -p 3008', 'npx -y devsnooze run -- npx next dev --turbopack -p 3008'],
  ['npx vite --port 5173', 'npx -y devsnooze run -- npx vite --port 5173'],
  ['vite', 'npx -y devsnooze run -- vite'],
  ['uvicorn app:app --reload --port 8000', 'npx -y devsnooze run -- uvicorn app:app --reload --port 8000'],
  ['python manage.py runserver 8000', 'npx -y devsnooze run -- python manage.py runserver 8000'],
  ['nuxt dev', 'npx -y devsnooze run -- nuxt dev'],
];
const NOT_DEV = ['npm run build', 'vite build', 'npx vite build', 'next build && next start', 'npm test', 'git commit -m "npm run dev fix"', 'npx -y devsnooze run -- npm run dev', 'devsnooze ps', 'grep -r "next dev" .', 'uvicorn app:app --port 8000', 'cat package.json | grep dev', 'npm run dev:css'];

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
