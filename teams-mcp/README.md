# teams-mcp

A Pi-specific MCP server exposing one tool over stdio: read a Microsoft Teams
channel message by its share URL.

## Tool

| Tool | What it does |
| --- | --- |
| `teams_message` | One channel message: text, author, timestamp, attachments, reactions |

## Contract

`teams_message` advertises an input schema and an output schema. The share URL is
parsed and validated before any token is read: a non-https URL, a foreign host, an
incomplete `/l/message/<thread>/<message>` path or a missing `groupId` is refused
without touching the Azure CLI or the network.

The result carries `status`, `reason` and `notes`:

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `unavailable` or `cancelled` |
| `reason` | structured cause (`auth`, `not-found`, `rate-limited`, `timeout`, `unsupported`, …) or `null` |
| `notes` | one actionable sentence per confirmed cause |

`isError` is set only for `unavailable` and `cancelled`.

## Credentials

| Source | Priority |
| --- | --- |
| `TEAMS_ACCESS_TOKEN` | 1 — a Graph token from a Teams Web session; its JWT expiry is honoured |
| Azure CLI | 2 — `az account get-access-token` for `https://graph.microsoft.com` |

The CLI is invoked as an argv array with no shell, asynchronously, with an
allowlisted environment and a 20-second budget. A token rejected by Graph is
refreshed once through the CLI path; an environment token cannot be refreshed by
this server, so it is reported as expired instead of being silently reused.

Missing credentials never prevent startup: `tools/list` works and a call returns a
structured `auth` failure with the exact next step.

Extract a browser token: open Teams Web, press F12 → Console, copy the
`"secret":"eyJ…"` value from a `graph.microsoft.com` localStorage entry, then set
`TEAMS_ACCESS_TOKEN`. Do not put an optional `${VAR}` placeholder in `mcp.json` —
Pi refuses to start a server whose placeholder is unset.

## Graph surface

Message reads use `https://graph.microsoft.com/beta`, because v1.0 requires the
admin-consented `ChannelMessage.Read.All` scope while `/beta` works with the
Teams Web Client scopes. This is a deliberate, documented dependency on a
non-versioned API: if it changes, this server is the single place to fix.

Channel resolution lists the team's channels and matches the `channelName` from
the URL exactly (case-insensitive). A filter that returns something else never
makes the server read a different channel.

## Limits

| Limit | Value |
| --- | --- |
| URL length | 2 048 chars |
| Graph request stage | 30 s |
| response body | 8 MB |
| message text | 40 000 chars, truncation reported |
| `az` token fetch | 20 s |

## Install

From the repository root:

```bash
./install.sh list                  # readiness report; changes nothing
./install.sh teams --dry-run       # show the plan; changes nothing
./install.sh teams                 # npm ci, build, test, register
```

The merge preserves fields the script does not own and backs `mcp.json` up first.

Register by hand instead:

```jsonc
// ~/.pi/agent/mcp.json → mcpServers
{
  "teams": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/absolute/path/to/pi-mag-mcp/teams-mcp/dist/server.js"],
    "exposure": "codemode",
    "description": "teams_message: one channel message by share URL, browser token or Azure CLI fallback"
  }
}
```

## Trust boundary

Message content is untrusted external data. It is rendered as data, never
executed, and only http(s) attachment links are exposed. Prompt-injection text is
not stripped, because silently rewriting evidence is worse than labelling it.

Token material never reaches the model, stderr or a child process environment: the
`az` child gets an allowlisted environment without `TEAMS_ACCESS_TOKEN`.

## Tests

```bash
npm test           # build + contract, URL/token/Graph, subprocess and Pi-client tests
```

The Pi-client test runs the child with a temporary `HOME` and an allowlisted
environment, so no real token or `az` login on the machine is read. Set
`PI_MCP_ROOT` when Pi lives somewhere unusual.

## Design notes

- `src/contract.ts` owns the schema, limits, environment name and failure
  vocabulary.
- `src/http.ts` owns bounded reads and failure classification;
  `src/subprocess.ts` owns argv-only execution.
- `src/teams-auth.ts` owns token acquisition, `src/teams-graph.ts` owns URL
  parsing and Graph requests, `src/teams.ts` owns the tool scenario.
- `src/server.ts` validates every output against its own schema and keeps stdout
  protocol-only.
