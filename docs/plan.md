# devsnooze Implementation Plan

> Executed inline (executing-plans), TDD per task. Spec: `docs/spec.md`.

**Goal:** lazy dev-server proxy + machine-wide dev-server inventory + agent integration.
**Architecture:** zero-dep Node CLI; `run` = http/ws proxy that spawns the child on demand and
stops its process group when idle or over memory; `ps/reap` = ps+lsof parsing with owner detection.
**Tech Stack:** Node ≥ 18 ESM, node:test.

## Global Constraints
- Node ≥ 18, zero runtime dependencies, macOS + Linux.
- Defaults: idle 20m, max-mem 3g, boot timeout 120s, mem check 15s, SIGKILL after 10s.
- Activity excludes `/_next/webpack-hmr`, `/__vite_ping`, `/__webpack_hmr`, WS frames.
- State dir `~/.devsnooze/run/<proxyPid>.json` (override `DEVSNOOZE_HOME`).

### Task 1: parsing utils — `src/duration.mjs`
- `parseDuration("20m"|"300ms"|"15s"|"2h"|number) -> ms`, `parseBytes("3g"|"512m"|"0") -> bytes`.
- Test: `test/duration.test.mjs` table.

### Task 2: child management — `src/child.mjs`
- `injectPort(argv: string[], port: number) -> {argv, env}`: `{port}` placeholder → `-p/--port N`
  / `--port=N` rewrite → else env `PORT`.
- `detectPort(argv, env) -> number` (from `-p/--port`, `$PORT`, 3000).
- `startChild(argv, {port, cwd, env}) -> ChildHandle {pid, exited: Promise}` (detached, own pgid, stdio inherit).
- `stopTree(pid, {graceMs=10000}) -> Promise<void>` (SIGTERM -pid, SIGKILL after grace).
- `waitForPort(port, timeoutMs) -> Promise<void>`.
- Tests: injection table; start fixture, waitForPort, stopTree kills grandchild too.

### Task 3: process table — `src/proc.mjs`
- `parsePs(text) -> Proc[] {pid, ppid, rss(bytes), etimeSec, command}` (`ps -axo pid=,ppid=,rss=,etime=,command=`).
- `parseEtime("02-19:11:13"|"06:07:50"|"02:30") -> sec`.
- `listProcs() -> Promise<Proc[]>`, `treeRss(procs, pid) -> bytes`, `ancestors(procs, pid) -> Proc[]`.
- `parseLsofListen(text) -> [{pid, port}]` (`lsof -nP -iTCP -sTCP:LISTEN -Fpn`),
  `parseLsofEstablished(text) -> Map<localPort, count>`, `cwdOf(pid)`.
- Tests: captured samples.

### Task 4: lazy proxy — `src/run.mjs`, `src/state.mjs`
- `createSnooze({argv, port, idleMs, maxMem, memCheckMs, bootTimeoutMs, cwd, env, log}) -> {listen(): Promise, close(): Promise, stats()}`.
  `stats() -> {state, starts, lastActivity, childPid}`.
- state.mjs: `writeState(obj)`, `removeState(pid)`, `readStates() -> State[]` (dead pids dropped).
- Tests (`test/run.test.mjs`, fixture `test/fixtures/server.mjs` http+ws echo, counts starts in a file):
  lazy start, request proxied, idle stop then wake (starts=2), HMR path doesn't extend idle,
  ws echo through proxy, mem cap stops child.

### Task 5: owner + ps/reap/stop — `src/owner.mjs`, `src/ps.mjs`
- `ownerOf(procs, pid, {claudeHome}) -> {kind:'claude'|'codex'|'cursor'|'terminal', name?, status?, sessionId?}`.
- `isDevServer(proc) -> bool` (+ protect list), `collect() -> Row[]`, `formatTable(rows)`, `reapCandidates(rows, {minAgeSec})`.
- Tests: ownerOf with fake proc table + temp sessions dir; isDevServer table; reapCandidates.

### Task 6: CLI — `bin/devsnooze.mjs`
- `run`, `ps [--json]`, `reap [--yes] [--min-age 1h]`, `stop [--session|--port|--all]`, `--help`, `--version`.
- Test: `devsnooze --help` exit 0; `run` e2e via child process against fixture.

### Task 7: Claude Code plugin + docs
- `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/hooks/hooks.json`,
  `plugin/hooks/guard.mjs` (PreToolUse deny/warn), `plugin/hooks/session-end.mjs`, `plugin/commands/devps.md`.
- `src/classify.mjs`: `classifyCommand(cmd) -> {dev: bool, rewritten?: string}`; test table.
- README (problem, numbers, install, usage, plugin), `docs/agents-snippet.md`, LICENSE MIT, package.json.

### Task 8: live acceptance
- Run 2+ real Next.js worktrees through devsnooze, measure RAM before/after, record in README.
