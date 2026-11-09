# web-search-mcp

A Pi-specific MCP server exposing one tool, `web_search`, over stdio.

Web search is best-effort here. DuckDuckGo has no SLA and blocks scrapers;
Tavily's free tier has daily caps. The server distinguishes a search that failed
from one that matched nothing, but it cannot promise that a search will succeed.

## What it does

| Mode | Provider chain | Cost |
| --- | --- | --- |
| `auto` (default) | DuckDuckGo scrape API → DuckDuckGo lite HTML | free, no key |
| `deep` | Tavily keyless → (opt-in) Tavily account → DuckDuckGo | free tier first |

Account-credit search is entered only when **both** `TAVILY_API_KEY` is set and
`WEB_SEARCH_ALLOW_QUOTA=1`. A key in the environment by itself never spends
anything.

## Contract

One tool, `web_search`:

```jsonc
// input
{
  "query": "string, 1..400 chars after trimming, required",
  "count": "integer 1..10, default 5",
  "mode": "\"auto\" | \"deep\", default \"auto\""
}
```

Invalid arguments are rejected before any network work: whitespace-only queries,
non-string queries, out-of-range or fractional counts and unknown modes are
errors, not silent fallbacks.

The structured output (`structuredContent`, mirrored by `outputSchema`):

| Field | Meaning |
| --- | --- |
| `status` | `ok`, `empty`, `unavailable`, `cancelled` |
| `provider` | provider that produced the results, `null` when none did |
| `results[]` | `title`, `url` (http/https only), `snippet`, `snippetTruncated` |
| `chain[]` | every provider attempt: `provider`, `outcome`, `error`, `reason`, `retryAfterSec` |
| `fallback` | `from`, `to`, `reason` when a later provider answered after a failure |
| `droppedUnsafeUrls` | results withheld because the link was not http(s) |
| `resultsTruncated` | the provider offered more usable results than `count` |
| `notes[]` | one actionable sentence per confirmed cause |

Status rules:

- `empty` means **every attempted provider answered** and matched nothing.
- `unavailable` means no usable answer was produced. It is not evidence that
  the information does not exist, and the notes say so.
- `isError` is set only for `unavailable` and `cancelled`. A zero-result answer
  is a successful search, not an error.

Failure causes are structured, not prose: `rate-limited`, `auth`, `blocked`,
`timeout`, `malformed`, `network`, `busy`, `cancelled`, `unknown`. Guidance is
derived from the cause only, and a wait hint appears only when the provider
supplied `Retry-After`.

## Limits

| Limit | Value | Environment |
| --- | --- | --- |
| query length | 400 chars | — |
| results per call | 10 | — |
| snippet length | 400 chars, truncation reported | — |
| provider HTTP stage | 15 s | — |
| whole search | 30 s, clamped to 1..120 s | `WEB_SEARCH_DEADLINE_MS` |
| provider response body | 2 MB | — |
| concurrent searches | 4 | — |

A provider that ignores its abort signal still cannot hold a call past the
whole-search budget. Cancelling the MCP request stops provider work instead of
merely abandoning the wait.

## Install

From the repository root:

```bash
./install.sh list                 # readiness report; changes nothing
./install.sh web-search --dry-run # show the plan; changes nothing
./install.sh web-search           # npm ci, build, test, register
```

The script registers this path and leaves the rest of the entry alone, so a
`timeout`, `toolExposure` or extra `env` key already in `mcp.json` survives.

To register by hand instead, write the entry into `mcp.json` yourself:

```jsonc
// ~/.pi/agent/mcp.json → mcpServers
{
  "web-search": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/absolute/path/to/pi-mag-mcp/web-search-mcp/dist/server.js"],
    "description": "web_search: DuckDuckGo free, Tavily deep mode on explicit quota opt-in",
    "exposure": "direct"
  }
}
```

`direct` is the practical choice for a single tool: with `codemode` (Pi's
default) the model must first find the tool before it can call it.

Do not write an optional secret as a `${VAR}` placeholder unless the variable
is always set. Pi substitutes at startup and fails before the server runs, so an
absent `TAVILY_API_KEY` makes the whole server unavailable. Either omit `env`
(it inherits Pi's environment), pass the value with `--env`, or use a
`!command` value that Pi executes.

Optional environment for `deep` mode:

| Variable | Effect |
| --- | --- |
| `TAVILY_API_KEY` | enables the account path |
| `WEB_SEARCH_ALLOW_QUOTA=1` | permits account-credit search |
| `WEB_SEARCH_DEADLINE_MS` | whole-search budget |

Without `env`, the process inherits Pi's environment, so an exported
`TAVILY_API_KEY` is visible to the server.

## Trust boundary

Search results are untrusted external data. The server keeps only `http` and
`https` links, clamps snippets, and never executes or fetches anything a result
points at. It does not strip prompt-injection text, because doing so would
silently rewrite evidence; treat result content as data, not instructions.

`readOnlyHint` is set because the tool writes nothing. It does not mean the call
is offline or free: the request leaves the machine and `deep` mode can consume
account quota when explicitly enabled.

## Tests

```bash
npm test           # build + parser, contract, pipeline and Pi-client tests
```

The compatibility test drives the real `McpClient` from the installed Pi, so it
fails when the server stops speaking Pi's protocol revision. Set `PI_MCP_ROOT`
to the `@earendil-works/pi-mcp` directory when Pi lives somewhere unusual; the
test skips with a message when it cannot find Pi at all.

None of the tests spend account credits: providers are injected or `fetch` is
stubbed, and the one end-to-end call runs in a sandbox that cannot reach the
network.

## Design notes

- `src/contract.ts` is the only owner of the schema, limits, environment names
  and status vocabulary. The advertised schema, runtime validation and output
  schema all derive from it.
- `src/ddg.ts` and `src/tavily.ts` are transports; they validate provider
  payloads at the boundary and report structured causes.
- `src/pipeline.ts` owns provider order, the deadline, concurrency and the
  status/notes rules.
- `src/render.ts` projects the structured result to text for clients that ignore
  `structuredContent`; it never adds information the structure lacks.
