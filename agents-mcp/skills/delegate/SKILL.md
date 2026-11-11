---
name: delegate
description: Consult external agent CLIs (claude, codex, agy) through one `agent_call` tool for second opinions, independent reviews, and parallel research — isolated processes, subscription aliases, mode-shaped answers (research / opinion / review), and `agent:"auto"` Jev routing that picks the cheapest suitable executor. Use proactively for non-trivial decisions, high-risk changes, and independent verification; skip for atomic tasks you should just do.
---

# Delegate (agents-mcp)

Inter-agent channel. Every call runs in an isolated process with no prior
conversation — the whole task context goes in `task`. A SAFETY RULES block
(no-write-outside-repo, no-push, no system files, secret redaction) is
prepended server-side.

## The call

```
agent_call { mode, agent, task, model?, effort?, alias?, extra_dirs? }
```

- **mode** shapes the answer: `research` (facts + evidence, change nothing),
  `opinion` (independent second opinion, verdict first), `review` (confirmed
  findings only, parsed into `findings[]`).
- **agent**: `claude` | `codex` | `agy` | `auto`. `auto` = Jev complexity
  routing inside the server — picks executor + effort; falls back (default
  `agy`) if Jev is unavailable, so routing never blocks a call.
- **alias** (claude only): subscription pin from config (`cc`, `numados`,
  `gateway`, … — resolved from `~/.config/agents-mcp/config.json` and the
  per-repo `.agents-mcp.json`).
- **effort** (codex): low = read-only sandbox, medium/high = workspace-write.
- **extra_dirs** (agy): extend the worker's workspace.

Resolution priority: request model/effort > alias pin > Jev (auto) > defaults
(per-repo `.agents-mcp.json` over global `~/.config/agents-mcp/config.json`).

## Usage rules

- Include complete context in `task`: file paths, decisions, constraints —
  the callee starts fresh.
- Rate limits: a failing model is parked (cooldown) and the call retries once
  on the next available model of the same candidate — same task, no
  re-classification (`retried{from,to}` in the envelope).
- `agents_status` (codemode exposure) is the doctor: CLI presence, aliases,
  routing state, repo override.
- Cheap isolated lookups favor `agy` (free); deep reasoning / independent
  review goes through `claude`/`codex`, never a harness subagent.
- Atomic tasks must not be delegated — execute them directly.

## Absence

If `agent_call` is not visible, delegation is unavailable: say so and proceed
without the second opinion, or use the harness's native subagents for
read-only scout work.
