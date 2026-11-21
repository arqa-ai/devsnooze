# devsnooze — spec

Status: approved design, 2026-11-21

## Problem

AI coding agents (Claude Code, Codex, Cursor) start dev servers — `next dev`, `vite`,
`uvicorn --reload` — to check their work and never stop them. With several parallel sessions
in git worktrees this eats the laptop: measured on a 16 GB MacBook, four `next dev --turbopack`
processes held 3.6–4.9 GB each (~17 GB total), swap was 18.6 of 19.4 GB.

Existing cleaners (zclean, cc-reaper, proc-janitor, devclean) kill only **orphans** (parent
dead, PPID=1). Here every server had a live parent — an agent session left open for days — so
they would kill nothing. A dev server is not wrong to exist; it is wrong to stay **awake while
nobody looks at it**.

## Goal

1. A dev server consumes RAM only while someone actually uses it.
2. One command shows every dev server on the machine: who owns it, RAM, idle state.
3. Agents start servers the snoozable way by default (plugin + instructions snippet).

Non-goals (v1): GUI/menu bar, Windows, sharing `node_modules` (saves disk, not RAM).

## Components

### 1. `devsnooze run` — lazy server

```
devsnooze run [-p PORT] [--idle 20m] [--max-mem 3g] [--name NAME] -- <command...>
```

- Proxy listens on PORT (default: taken from `-p N` / `--port N` / `--port=N` in the command,
  else `$PORT`, else 3000). The proxy is small (~20–40 MB).
- The real server is **not** started until the first HTTP request. On start it gets a free
  internal port, passed by: replacing `{port}` in the command if present, else rewriting the
  `-p/--port` argument, else appending nothing and setting `PORT=<internal>` in env.
- Requests arriving while the child boots are held until the internal port accepts TCP
  (timeout 120 s → 504 with a plain explanation).
- HTTP and WebSocket upgrades are proxied (HMR works).
- **Activity** = any HTTP request except known HMR/heartbeat paths
  (`/_next/webpack-hmr`, `/__vite_ping`, `/@vite/client` ping, `/__webpack_hmr`).
  WebSocket frames and open sockets are **not** activity — otherwise a forgotten background
  tab keeps the server awake forever.
- **Idle** (no activity for `--idle`, default 20m, and no in-flight request) → stop: SIGTERM to
  the child's process group, SIGKILL after 10 s, open upgraded sockets closed. The proxy keeps
  the port; the next request wakes the server.
- **Memory cap**: every 15 s sum RSS of the child process tree; above `--max-mem` (default 3g,
  `0` disables) and no in-flight request → stop (it wakes fresh on the next request). Log it.
- Child stdout/stderr are passed through, prefixed with nothing (agent tools read them as usual).
- Ctrl-C / SIGTERM to devsnooze stops the child tree and exits.
- State file `~/.devsnooze/run/<proxyPid>.json`: port, internal port, cwd, command, childPid,
  state (`sleeping|starting|awake`), lastActivity, owner session id (see owner detection).
  Removed on exit; stale files (dead pid) ignored and cleaned by `ps`.

### 2. `devsnooze ps` / `devsnooze reap`

`ps` lists listening TCP processes that look like dev servers (command matches node, bun,
deno, python, ruby, php, go-run binaries started from a project dir), excluding a protect list
(docker, postgres, redis, mysql, Chrome, Electron apps, ollama, editors). Columns:

`PORT  STATE  RAM  CONN  IDLE  OWNER  DIR  CMD`

- RAM = summed RSS of the process tree (macOS RSS undercounts compressed memory; noted in README).
- CONN = established TCP connections to the port.
- STATE/IDLE = from devsnooze state files for managed servers; `unmanaged` + process age otherwise.
- OWNER = walk the parent chain: `claude` pid → `~/.claude/sessions/<pid>.json` (name, status
  busy/idle, session id); `codex`; `cursor`; otherwise `terminal`.
- `--json` for machine output.

`reap` = candidates among **unmanaged** servers: 0 established connections, age > 1h
(`--min-age`), owner session not `busy`. Dry-run by default; `--yes` sends SIGTERM to the tree
(SIGKILL after 10 s). Managed servers are never reaped — they already sleep.

### 3. Agent integration

**Claude Code plugin** (`plugin/` in this repo, installable via `/plugin`):
- `PreToolUse` hook on `Bash`: if the command starts a dev server (`next dev`, `vite`,
  `npm|pnpm|yarn|bun run dev`, `nuxt dev`, `astro dev`, `uvicorn … --reload`, `flask run`,
  `rails s`) and doesn't already contain `devsnooze`, deny with a reason that gives the exact
  rewritten command (`npx devsnooze run -p <port> -- <original>`). `DEVSNOOZE_HOOK=warn` turns
  the deny into a non-blocking note; `off` disables.
- `SessionEnd` hook: `devsnooze stop --session <session_id>` stops servers owned by that session.
- `/devps` command: runs `npx devsnooze ps` and summarizes.

**Instructions snippet** (`docs/agents-snippet.md`) for `AGENTS.md`/`CLAUDE.md`, any agent:
verify with tests/typecheck/`build && start` first; run a dev server only through
`devsnooze run`; say the port in the final answer.

### 4. `devsnooze stop [--session ID | --port P | --all]`

Signals managed proxies (from state files) to exit, which stops their children.

## Tech

Node ≥ 18, zero runtime dependencies (`node:http`, `node:net`, `node:child_process`).
macOS + Linux. Process data via `ps -axo pid,ppid,rss,etime,command` and
`lsof -nP -iTCP` (Linux: same tools, `lsof` required — documented).
Published to npm as `devsnooze`, MIT.

## Layout

```
bin/devsnooze.mjs        CLI entry, arg parsing, subcommand dispatch
src/run.mjs              lazy proxy: listen, wake, forward http/ws, idle + mem timers
src/child.mjs            spawn child in own process group, port injection, stop tree
src/proc.mjs             ps/lsof parsing: process table, tree RSS, listeners, connections
src/owner.mjs            parent-chain owner detection (claude/codex/cursor/terminal)
src/state.mjs            ~/.devsnooze/run state files
src/ps.mjs               ps + reap
src/duration.mjs         "20m", "3g" parsing
plugin/                  Claude Code plugin (hooks, command)
docs/agents-snippet.md
test/                    node:test
```

## Testing

`node --test`, real processes, no mocks for the proxy:
- fixture HTTP+WS server (`test/fixtures/server.mjs`, reads `PORT`) records its own starts;
- lazy start: no child before the first request; first request succeeds after boot;
- idle: with `--idle 300ms`, child is stopped, next request wakes it (start count = 2);
- HMR path and WS frames don't extend idle;
- WebSocket echo works through the proxy;
- memory cap: `--max-mem` tiny → child stopped after a check (check interval injectable);
- port injection: `{port}`, `-p N`, `--port=N`, env fallback;
- parsers (`proc.mjs`, `duration.mjs`) on captured `ps`/`lsof` samples;
- hook: command classifier table (dev-server commands → deny + rewrite; others → allow).

Acceptance: live run on 4 real `next dev` worktrees — RAM before/after reported in README.
