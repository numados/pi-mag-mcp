# pi-mag-mcp

Pi-specific MCP servers: nine stdio servers written for the Pi coding agent
and registered in `~/.pi/agent/mcp.json`.

## Status

In progress. All nine servers are implemented and tested:
`web-search-mcp/`, `office-mcp/`, `teams-mcp/`, `search-mcp/`, `knowledge-mcp/`,
`devwork-mcp/`, `repo-mcp/`, `agents-mcp/` and `grafana-logs-mcp/`. Design, source inventory and per-server research live in the
local planning workspace
`.numados/tasks/` (not tracked by git — see `.git/info/exclude`).

| Server | Tools | State |
| --- | --- | --- |
| `web-search-mcp` | `web_search` | implemented and tested; live registration still points at the old catalog |
| `office-mcp` | `create_pdf`, `pdf_clean` | implemented and tested; live registration still points at the old catalog |
| `teams-mcp` | `teams_message` | implemented and tested; not registered on this machine |
| `search-mcp` | `providers`, `search`, `search_{text,files,structure,docs,semantic,machine,crossrepo}` | implemented and tested; live registration still points at the old catalog |
| `knowledge-mcp` | `knowledge_{status,search,read,links,structure,write,move,task,repo}` | implemented and tested; live registration still points at the old catalog; the machine's vault configuration still needs `--setup` |
| `devwork-mcp` | `devwork_{status,get,query,create,update,repos}`, `devwork_pr_{show,list,create,update,vote}`, `devwork_task_{create,done}`, `devwork_pbi_status` | implemented and tested; registered per repository, never user-level |
| `repo-mcp` | 21 Git tools: reads, fetch/pull/staged commit, approval-gated local mutations and branch/message generation | implemented and tested; live registration still points at the old catalog |
| `agents-mcp` | `agent_call`, `agents_status` | implemented and tested; live registration still points at the old catalog |
| `grafana-logs-mcp` | `grafana_logs_query`, `grafana_logs_raw` | implemented and tested; not registered on this machine |

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
./install.sh repo                     # build, test, register the Git server
./install.sh agents                   # build, test, register the inter-agent channel
./install.sh grafana-logs --env GRAFANA_URL=... --env GRAFANA_DATASOURCE_UID=UID
                                      # build, test, register the Grafana log server
./install.sh devwork --local --repo ~/work/example --installation example-service
                                      # build, test, register for one repository only
```

`devwork` is installation-scoped: `--local` writes a full entry into
`<repo>/.pi/mcp.json` and a private profile under
`~/.config/devwork-mcp/installations/`, and never touches the user-level file.
See `devwork-mcp/README.md` for the four-layer model, scope enforcement and the
preview binding on writes.
Local registration owns `DEVWORK_INSTALLATION` and `DEVWORK_INSTALLATIONS_DIR`.
It removes stale file selectors and rejects profile-path overrides through `--env`.

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

## Content hygiene

Code, tests, docs, fixtures and commit messages are published with the package,
so they must not carry machine- or tenant-specific data: no absolute home paths,
no customer or product names, no real ticket prefixes or note titles. Use neutral
placeholders (`~/vaults/work`, `example-vault`, `ABC-123`). Both checks are quick
and belong before a commit:

```bash
scripts/check-content.sh            # tracked files
scripts/check-content.sh --history  # plus every commit message
```

The name denylist stays machine-local (`~/.pi/agent/content-denylist.txt`) and is
never committed. See `CONTRIBUTING.md` for the full rule and the package conventions.
