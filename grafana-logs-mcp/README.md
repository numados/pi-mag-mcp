# grafana-logs-mcp

Two tools against a Grafana instance with a Quickwit datasource:

- `grafana_logs_query` — read-only Quickwit query language (QQL) search, returns formatted log
  entries (timestamp, severity emoji, service, body) plus the available field
  list. `timeRange` in Grafana notation (`now-1h` …), `limit` 1–1000.
- `grafana_logs_raw` — raw Grafana API passthrough for debugging
  (`GET /api/datasources`, `POST /api/ds/query`, …). It forwards arbitrary
  HTTP methods, so it **can mutate the Grafana instance**; only `/api` paths
  on the configured origin are accepted and redirects are refused.

`node dist/server.js --doctor` prints the environment readiness report
(values are never printed) and exits non-zero while a required variable is
missing or invalid. `./install.sh list` runs it for the requirements section.

Ported from the `agent-toolkit` catalogue at source revision `e985502`.
The port adds bearer authentication and safe error messages. It also corrects
ISO timestamps and counts rows across all successful frames.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `grafana_logs_query` | `query`, `timeRange?`, `limit?`, `datasourceUid?` | formatted entries (≤32k chars) + `{ rowCount }` |
| `grafana_logs_raw` | `endpoint` (`/api/...`), `method?`, `body?` | status + pretty JSON (≤8k chars) + `{ status }` |

## Setup

```bash
cd grafana-logs-mcp && npm install && npm test
```

Config is env-only — **both required values are machine-local** (no defaults
baked into the server); `requirements.json` owns the table:

| Env | Meaning |
| --- | --- |
| `GRAFANA_URL` | canonical HTTP or HTTPS base URL. A token requires HTTPS. Redirects and embedded credentials are rejected. |
| `GRAFANA_DATASOURCE_UID` | Quickwit datasource UID |
| `GRAFANA_DATASOURCE_TYPE` | default `quickwit-quickwit-datasource` |
| `GRAFANA_API_TOKEN` | optional Grafana service-account token or legacy API key. Authenticated requests require HTTPS and use `Authorization: Bearer …`. |

Without `GRAFANA_API_TOKEN`, requests are anonymous. Network access can require
a VPN. With a token, the server requires HTTPS before any request. There is
no insecure-authentication override.

The server rejects malformed tokens without quoting their values. It also
replaces transport exceptions with safe diagnostics. The doctor reports
presence only. Redirects remain disabled.

Without the required env the server still starts and answers `tools/list`;
calls return a clear configuration error instead of guessing a target.

Register through the repository installer (never edits values it does not
own; pass the machine-local env on the command line):

```bash
cd .. && ./install.sh grafana-logs --dry-run \
  --env GRAFANA_URL=https://grafana.your-company.net \
  --env GRAFANA_DATASOURCE_UID=YOUR-DATASOURCE-UID
./install.sh grafana-logs \
  --env GRAFANA_URL=https://grafana.your-company.net \
  --env GRAFANA_DATASOURCE_UID=YOUR-DATASOURCE-UID
```

HTTPS calls always verify the server certificate. For a corporate CA, start
Node with `NODE_EXTRA_CA_CERTS=/absolute/path/to/corporate-ca.pem`; do not
disable TLS verification.
