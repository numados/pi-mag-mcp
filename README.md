# pi-mag-mcp

Pi-specific MCP servers: eight stdio servers written for the Pi coding agent
and registered in `~/.pi/agent/mcp.json`.

## Status

In progress. `web-search-mcp/` and `office-mcp/` are implemented and tested; six
of the eight servers are not ported yet. Design, source inventory and per-server
research live in the local planning workspace `.numados/tasks/` (not tracked by
git — see `.git/info/exclude`).

| Server | State |
| --- | --- |
| `web-search-mcp` | implemented and tested; live registration still points at the old catalog |
| `office-mcp` | implemented and tested; live registration still points at the old catalog |

## Installing a server

`install.sh` builds one server, gates registration on its tests, and merges the
entry into Pi's configuration:

```bash
./install.sh list                     # readiness report; changes nothing
./install.sh web-search --dry-run     # show the plan; changes nothing
./install.sh web-search               # build, test, register
./install.sh office                   # build, test, register the office server
```

A server name is required. Without one the script prints usage and exits 2, so
a bare invocation cannot install whatever happens to be in the repository.

| Option | Effect |
| --- | --- |
| `--dry-run` | print the plan; build nothing, write nothing |
| `--no-pi` | build and test only, skip registration |
| `--exposure <mode>` | `codemode` (default, Pi's own default), `deferred`, `direct`, `hidden` |
| `--env <KEY=VALUE>` | add or override one entry in the server's `env` (repeatable; the plan prints keys, never values) |

Registration merges rather than replaces: fields the script does not own
(`timeout`, `enabled`, `toolExposure`, unrelated `env` keys) survive a re-run,
other servers are never touched, and a `mcp.json` that does not parse is left
alone with an error. A seed `timeout` from the registry is written only when the
entry has none, so a custom value is never overwritten. Each write is preceded
by a timestamped backup next to the file.

`list` exits 1 when something needs attention — a registered server whose entry
points at a different path, a server that was never built, or an unparseable
configuration file.

Set `PI_MCP_JSON` to point the script at another file, which is useful for
trying a registration before touching the real one.
