<!-- Paste into AGENTS.md / CLAUDE.md / .cursorrules -->
## Dev servers

- To verify a change, prefer tests, typecheck, lint or a production build (`next build && next start`)
  over a dev server. A dev server is for a human looking at the UI.
- If you do start a dev server, start it through devsnooze so it sleeps when nobody uses it:
  `npx -y devsnooze run -- npm run dev -- -p 3007`
  (same port; the real server starts on the first request and stops after 20 min without requests).
- Never leave a raw `next dev` / `vite` / `uvicorn --reload` running in the background.
- Say the port in your final answer. `npx devsnooze ps` shows every dev server on the machine.
