# pi-mag-mcp

Pi-specific MCP servers: nine stdio servers written for the Pi coding agent
and registered in `~/.pi/agent/mcp.json`.

## Status

In progress. Five of the nine servers are implemented and tested:
`web-search-mcp/`, `office-mcp/`, `teams-mcp/`, `search-mcp/` and `knowledge-mcp/`. Design, source
inventory and per-server research live in the local planning workspace
`.numados/tasks/` (not tracked by git — see `.git/info/exclude`).

| Server | Tools | State |
| --- | --- | --- |
| `web-search-mcp` | `web_search` | implemented and tested; live registration still points at the old catalog |
| `office-mcp` | `create_pdf`, `pdf_clean` | implemented and tested; live registration still points at the old catalog |
| `teams-mcp` | `teams_message` | implemented and tested; not registered on this machine |
| `search-mcp` | `providers`, `search`, `search_{text,files,structure,docs,semantic,machine,crossrepo}` | implemented and tested; live registration still points at the old catalog |
| `knowledge-mcp` | `knowledge_{status,search,read,links,structure,write,move,task,repo}` | implemented and tested; live registration still points at the old catalog; the machine's vault configuration still needs `--setup` |

## Installing a server

`install.sh` builds one server, gates registration on its tests, and merges the
entry into Pi's configuration:

```bash
./install.sh list                     # readiness report; changes nothing
./install.sh web-search --dry-run     # show the plan; changes nothing
./install.sh web-search               # build, test, register
./install.sh office                   # build, test, register the PDF server
./install.sh teams                    # build, test, register the Teams server
./install.sh search                   # build, test, register the search router
./install.sh knowledge                # build, test, register the vault and task server
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
