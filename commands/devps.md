---
description: List dev servers on this machine — owner session, real RAM, connections, reap candidates
---
Dev servers right now:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/devsnooze.mjs" ps`

Summarize in a few lines: total RAM, the biggest servers, which belong to this session, and which are
unmanaged with 0 connections (candidates for `devsnooze reap`). Do not stop anything yourself —
offer the exact command (`node "${CLAUDE_PLUGIN_ROOT}/bin/devsnooze.mjs" reap` is a dry run; `--yes` stops)
and let the user decide.
