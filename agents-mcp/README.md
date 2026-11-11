# agents-mcp

Inter-agent channel MCP server for Pi. One coarse tool, `agent_call`, drives
the external `claude` / `codex` / `agy` CLIs in isolated processes with no
prior conversation; `agents_status` is the doctor. Ported from the
`agent-toolkit` catalogue at source revision `7cdf230` plus the local hygiene
diff that removed the tenant-specific builtin alias (carried through tests
and the skill).

## Tools

| Tool | Exposure | What it does |
| --- | --- | --- |
| `agent_call` | direct | `{mode, agent, task, model?, effort?, alias?, extra_dirs?}` — `mode` ∈ `research\|opinion\|review` shapes the answer; `agent` ∈ `claude\|codex\|agy\|auto`; runs the CLI, returns the answer in one envelope (`ok`, `mode`, `agent`, `alias`, `routing`, `retried`, `model`, `effort`, `sandbox`, `result`, `findings[]`). |
| `agents_status` | codemode | Doctor: CLI presence with install hints, subscription aliases (env keys only, never values), resolved defaults, active repo override, routing state. |

Every task is prefixed server-side with a SAFETY RULES block (no writes
outside the repository, no push, no system files, secret redaction).

## How the executor is resolved

Priority, highest first: explicit request `model`/`effort` → claude alias pin
→ Jev choice (`agent:"auto"`) → config defaults → built-ins.

Config layers, each overriding the previous:

1. built-ins (in `src/config.ts`);
2. machine config: `$AGENTS_MCP_CONFIG` or `~/.config/agents-mcp/config.json`
   (see `config.example.json`);
3. per-repo `.agents-mcp.json` (repo root found by walking up to `.git`;
   only `defaults`, `agents`, `aliases`, `routing` merge).

`agent:"auto"` asks the Jev classifier once per call to pick the agent and
rate the task complexity; the candidate registry, the complexity → effort
maps and the per-candidate model lists live under `routing` in config. Any
routing failure (disabled, missing `TYPESAFE_API_KEY`, timeout, unusable
answer) degrades to `routing.fallback` (default `agy`) — routing never blocks
a call. A model that answers with a rate-limit/overload error is parked in
`~/.cache/agents-mcp/cooldowns.json` (TTLs overridable via
`routing.cooldowns`) and the call retries once on the next model of the same
candidate.

Claude subscription aliases can pin `command`, `args`, `env`, `envClear`,
`model` and `effort`; env values may be literals, `~/path` or `env:VAR`
references expanded at call time.

## Requirements

See `requirements.json`: the three CLIs are each optional (the matching
agent is then unavailable and the doctor says so), and `TYPESAFE_API_KEY` is
optional and only enables `agent:"auto"` routing. `node >= 22`.

## Install

```bash
./install.sh agents --dry-run   # from the repository root
./install.sh agents             # build, test, register into ~/.pi/agent/mcp.json
```

Registration defaults to `codemode` exposure with `agent_call` also exposed
`direct` (the live pattern); the seed timeout is 900 s because a delegation
call can legitimately run for minutes.

## Development

```bash
npm install
npm test          # build + node --test: unit suite (fake CLI, hermetic),
                  # Pi-client smoke, content hygiene
node dist/server.js --doctor
```

Tests never spend real subscriptions: the end-to-end suite injects a fake CLI
through config (`command: node …`), the Pi-client smoke pins `HOME` and
`AGENTS_MCP_CONFIG` to the fixture, and the cooldown cache is redirected into
the fixture directory.
