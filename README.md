# devsnooze

**Dev servers that sleep when nobody looks at them.**

AI coding agents (Claude Code, Codex, Cursor) start `next dev`, `vite`, `uvicorn --reload` to check
their work — and leave them running. Run a few sessions in parallel worktrees and your laptop is
swapping by lunch.

Measured on a 16 GB MacBook running four agent sessions:

```
$ devsnooze ps
PORT  STATE      RAM   CONN  IDLE/AGE   OWNER                     DIR
3006  unmanaged  4.0G  1     age 1d0h   claude:app-89(shell)      ~/wt/app/esf-preview
3007  unmanaged  5.0G  0     age 2d21h  claude:app-ce(shell)      ~/wt/app/bank-connector
3008  unmanaged  3.6G  1     age 3h42   claude:app-ce(shell)      ~/wt/app/bank-mcp
3017  unmanaged  4.6G  3     age 4h49   claude:app-7f(shell)      ~/wt/app/company-card
...
11 dev servers, 19.2G total
```

Swap was 21.5 of 22.5 GB. Existing cleaners (zclean, cc-reaper, proc-janitor, devclean) would kill
**none** of these: they only reap orphans, and every one of these servers still had a live parent —
an agent session left open for days.

A dev server isn't wrong to exist. It's wrong to stay **awake while nobody uses it**.

## How it works

```
devsnooze run -- npm run dev -- -p 3007
```

- A ~40 MB proxy holds port 3007. The real dev server starts **on the first request**.
- After 20 minutes without requests it is stopped (whole process tree). The port stays open;
  the next request wakes it again. HMR heartbeats and open WebSockets don't count as activity,
  so a forgotten background tab doesn't keep it alive.
- If the server bloats past 4 GB, it's restarted fresh at the next quiet minute.
- HTTP and WebSocket (HMR) are proxied transparently.

Live run on a real Next.js 15 app (one page compiled):

| | RAM |
|---|---|
| awake, one page compiled | 2.0 GB |
| asleep (proxy only) | 42 MB |
| wake-up on next request | ~12 s (cold compile) |

## Install

```sh
npx -y devsnooze --help          # no install
npm i -g devsnooze               # or globally
```

Node ≥ 18, macOS or Linux (`lsof` required), zero dependencies.

## Usage

```sh
devsnooze run [options] -- <command...>
  -p, --port N         public port (default: the command's -p/--port, $PORT, or 3000)
  --idle 20m           stop after this long without requests
  --max-mem 4g         restart at the next quiet minute once bigger than this (0 = off)
  --boot-timeout 120s

devsnooze ps [--json]                 every dev server on the machine: owner, real RAM, connections
devsnooze reap [--yes] [--min-age 1h] stop forgotten unmanaged servers (dry run without --yes)
devsnooze stop --port N | --session ID | --all
```

How the real server gets its port: `{port}` in the command is replaced; otherwise a `-p N` /
`--port N` / `--port=N` argument is rewritten; `PORT` is always set in the environment.

```sh
devsnooze run -- next dev --turbopack -p 3007
devsnooze run -p 8000 -- uvicorn app:app --reload --port {port}
devsnooze run -p 5173 -- vite --port {port}
```

`ps` reports macOS `phys_footprint` (what Activity Monitor shows), not RSS — RSS misses compressed
and swapped memory, which is exactly where a bloated dev server lives when RAM is tight (RSS said
26 MB for a 5 GB server). OWNER walks the parent chain to the Claude Code session
(`~/.claude/sessions`), Codex, Cursor, or a terminal.

`reap` only proposes servers that are unmanaged, have 0 connections, are older than `--min-age`,
whose Claude session isn't busy, and that don't look like MCP servers.

## Claude Code plugin

```
/plugin marketplace add arqa-ai/devsnooze
/plugin install devsnooze@devsnooze
```

- **PreToolUse hook**: when Claude runs `next dev` / `vite` / `npm run dev` / `uvicorn --reload` /
  `rails s` / `manage.py runserver`…, the call is denied with the exact devsnooze-wrapped command,
  and Claude reruns it that way. `DEVSNOOZE_HOOK=warn` makes it a hint instead, `off` disables it.
- **SessionEnd hook**: servers started by the session are stopped when it ends.
- **/devps**: what's running, who owns it, how much RAM.

## Other agents

Paste [docs/agents-snippet.md](docs/agents-snippet.md) into `AGENTS.md`, `CLAUDE.md` or `.cursorrules`.

## License

MIT
