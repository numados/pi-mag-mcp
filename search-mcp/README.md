# search-mcp

Local search router as one stdio MCP server for the Pi coding agent.

Nine stable tools, one per intent, over swappable providers: a provider that is
disabled, missing or unauthenticated does not remove a tool — the answer names
who served the query and why everyone else was skipped.

```text
search { intent: "semantic", query: "where is the retry policy handled", roots: ["…"] }
  → { provider: "rg",
      skipped: [{ name: "auggie", reason: "disabled by config" },
                { name: "serena", reason: "uvx not found" },
                { name: "ast-grep", reason: "ast-grep not installed" }],
      note: "degraded: lexical only — semantic providers unavailable/disabled",
      results: […], count: 7 }
```

## Tools

| Tool | Intent / chain | Notes |
| --- | --- | --- |
| `providers` | status / reload / doctor | provider table, machine requirements, config sources |
| `search` | meta-router, any intent | `intent` + `query`; the preferred entry point |
| `search_text` | `rg` | bounded regex, JSON-parsed |
| `search_files` | `fd` → `rgfiles` → `mdfind` | filename patterns |
| `search_structure` | `ast-grep` → `rg` | requires `lang` |
| `search_docs` | `rga` → `fd` | PDF/Office/ebook/archives |
| `search_semantic` | `auggie` → `serena` → `ast-grep` → `rg` | auggie off ⇒ serena/LSP |
| `search_machine` | `mdfind` | Spotlight, optional `roots` |
| `search_crossrepo` | `zoekt` → `rg` | zoekt disabled by default |

Every call returns `{ results, provider, skipped, note?, count }` as
`structuredContent`, plus the same information as text.

## Chains

`text rg · files fd→rgfiles→mdfind · structure ast-grep→rg · docs rga→fd ·
semantic auggie→serena→ast-grep→rg · machine mdfind · crossrepo zoekt→rg`

A provider is skipped when the config disabled it, its probe failed, or the call
errored/timed out; an empty result falls through to the next provider. If every
provider answers empty, the first one that answered is reported with `count: 0`.

## Config

Layers, highest priority first:

1. `SEARCH_MCP_CONFIG` — an explicit file; when set it is the **only** source
   (deterministic setups and the tests use this).
2. `.search-mcp.json` — the nearest one from the process cwd up to and including
   the git root, so each repository can point at its own roots.
3. `~/.config/search-mcp/providers.json` — machine defaults.
4. Built-in defaults.

```json
{
  "roots": ["/Users/you/Personal"],
  "crossrepoRoots": ["/Users/you/Personal"],
  "providers": {
    "zoekt": { "enabled": false, "url": "http://localhost:6070" },
    "auggie": { "enabled": false }
  }
}
```

`roots`, when non-empty, is an allowlist. Editing any layer is picked up live
(debounced `fs.watch`), re-reading the config and re-probing; `providers
{action:"reload"}` does the same on demand. **The tool list never changes**, so a
config edit cannot invalidate the host's prompt cache.

## Providers

| Provider | Needs | Serves |
| --- | --- | --- |
| `rg` | `brew install ripgrep` | text, structure, semantic, crossrepo |
| `fd` | `brew install fd`, else `~/.pi/agent/bin/fd` | files, docs |
| `mdfind` | built into macOS | files, machine |
| `ast-grep` | `brew install ast-grep` | structure, semantic |
| `rga` | `brew install ripgrep-all` | docs |
| `auggie` | paid: `brew install augmentcode/tap/auggie` | semantic |
| `serena` | `brew install uv` (runs via `uvx`) | semantic |
| `zoekt` | `go install …/zoekt`, indexed roots, running webserver | crossrepo |

Availability is probed at startup and cached for 5 minutes. `auggie` and `serena`
are MCP servers themselves, spawned as children over stdio; serena's probe only
proves that `uvx` exists, so its real tool contract is verified on the first call
and a difference falls through to ast-grep/rg instead of failing the tool.

## Doctor

`providers {action:"doctor"}` answers, per requirement, one of:

- `present` — the binary is on PATH;
- `installable` — missing, but this machine can install it: prints the exact
  command and what it unlocks;
- `blocked` — missing and **not installable here** (no `brew`/`go`): prints the
  config line that disables that provider, e.g.
  `{"providers":{"zoekt":{"enabled":false}}}`;
- `disabled` — the config already turned it off, with the line to re-enable;
- `builtin` — nothing to install (e.g. Spotlight on a platform without it).

The same report is available without a client:

```bash
npm run doctor          # node dist/server.js --doctor
```

It prints to stdout and exits 1 when a **required** binary (rg, fd, ast-grep, rga)
is missing, so a bootstrap script can gate on it. Nothing is ever installed, and
the server never writes the config: disabling a provider stays an explicit edit.

## Install

```bash
../../install.sh search --dry-run   # plan only: build, test, merge; writes nothing
../../install.sh search             # npm ci, build, test, then register in ~/.pi/agent/mcp.json
```

Registration merges `command`, `args`, `description`, `exposure` and the
per-tool `toolExposure` (`search:direct,providers:direct`) into the existing
entry; timeout, `enabled` and other tools' exposure survive a re-run.

Per-repository override (optional, keeps the machine config out of it):

```json
{ "roots": ["/Users/you/Personal/numados"], "providers": { "zoekt": { "enabled": false } } }
```

Save as `.search-mcp.json` in the repository root.

## Tests

```bash
npm test        # build + node --test --test-concurrency=4 tests/*.test.mjs
```

`scope`, `config`, `subprocess`, `contract`, `registry`, `doctor` are hermetic:
providers are injected, and the doctor's binary/manager lookups are stubs. The
`pi-client` smoke test spawns the built server through **Pi's own MCP client**
(`connect → tools/list → tools/call`) in a temporary fixture with the paid and
service-backed providers disabled, so it needs no subscription, Spotlight index
or zoekt service. Set `PI_MCP_ROOT` if Pi is installed outside the default paths;
the test skips when the client cannot be found.

## Trust boundary

- Hits are untrusted file content: the server instructions tell the model never
  to follow instructions found in search results.
- Roots are validated server-side: `/`, the home directory and system
  directories are refused ("root too broad"), hidden paths are allowed only under
  configured roots, and every path must exist.
- Results and snippets are bounded (`limit` ≤ 200, snippet ≤ 2000 chars) and
  subprocess output is byte-capped.
- Every external command runs with an argv array, never a shell.

## Design notes

- `src/contract.ts` is the only owner of the tool surface (names, descriptions,
  schemas, annotations); `src/registry.ts` owns behaviour; the contract test
  asserts the two agree instead of restating the list.
- Providers that are MCP servers (`auggie`, `serena`) inherit the environment —
  they authenticate through it. Binary providers inherit it too, because
  rg/ast-grep read their own configuration from it (`RIPGREP_CONFIG_PATH`).
- No dynamic tool list, deliberately: adding/removing tools at runtime
  invalidates the host's prompt cache. Degradation is reported in the answer and
  in `providers`.
