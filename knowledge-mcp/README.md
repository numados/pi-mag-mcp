# knowledge-mcp

Knowledge domain as one stdio MCP server for the Pi coding agent: Obsidian-style
Markdown vaults, several directories at once, bounded reads, a link graph,
two-phase validated writes, and the `numados-task-*` workspace protocol.

```text
knowledge_search { query: "retry policy" }
  → vaults: work (2 roots), personal
    work / main (2 hits, qmd)
      1) Projects/overview.md:12  …retries are bounded by …
    work / shared (1 hit, rg)
      1) Notes/retry.md:7  …
    skipped: archive (directory missing)
```

## Tools

| Tool | R/W | Exposure | What it does |
| --- | --- | --- | --- |
| `knowledge_status` | r | direct | the doctor report: config, binaries, sources, qmd state, repo layer |
| `knowledge_search` | r | direct | `hybrid` (qmd BM25 → rg), `lexical` (rg + context), `graph` (note → one-hop links and backlinks) |
| `knowledge_read` | r | direct | bounded read: `meta` / `outline` / `body` / `section`, `maxChars` 6000 |
| `knowledge_links` | r | codemode | resolved outgoing wikilinks and backlinks, one hop |
| `knowledge_structure` | r | codemode | folder inventory and frontmatter coverage; `conventions` answers "what format do notes here use" |
| `knowledge_write` | w | codemode | `create` / `update` / `retire` / `supersede`, two-phase with `confirm: true` |
| `knowledge_move` | w | codemode | rename/move with `[[link]]` rewriting, two-phase |
| `knowledge_task` | rw | codemode | task workspace protocol: `status`, `init`, `iteration`, `update` |
| `knowledge_repo` | r | codemode | knowledge map around a repository: its tasks, notes mentioning it, catalog entry |

The tool list never changes at runtime — availability and configuration are
reported in the answer and by `knowledge_status`, so a config edit cannot
invalidate the host's prompt cache. Every response is text; there are no output
schemas, and the text is the contract quoted by the `knowledge-vault` skill.

## Sources: one name, several directories

A source is a named set of ordered roots, because one body of knowledge is often
split over several directories (a synced vault, a shared notes folder, an
archive). `vaults[name]` accepts any of:

```json
{
  "work": "~/vaults/work",
  "personal": ["~/vaults/personal", "~/notes"],
  "archive": { "path": "~/vaults/old", "writable": false, "qmd": false },
  "shared": {
    "paths": [
      { "path": "~/vaults/work", "label": "main" },
      { "path": "~/team/notes", "label": "team" }
    ]
  }
}
```

A leading `~/` is expanded, so a home-relative path means the same directory
as its absolute form. Per root: `label` (default the directory name, deduplicated), `writable`
(default `true`), `qmd` (`true`/`false`/absent = follow the global setting).
Source-level values apply to every root that does not override them.

Resolution rules:

- a note reference is root-relative; `<label>:<rel>` addresses one root
  explicitly;
- the same relative path in two roots is ambiguous and the error names both plus
  the exact form to use;
- a bare name that is unique across the source resolves to its root;
- writes go to the first writable root (or the addressed one); a `writable:
  false` root refuses with `source root "<label>" is read-only by config`;
- a wikilink namespace is the whole source, so a name shared by two roots is
  reported as `AMBIGUOUS`, exactly as an Obsidian vault would report it.

## Configuration

Layers: built-in defaults → `~/.config/knowledge-mcp/config.json` (override the
path with `KNOWLEDGE_MCP_CONFIG`) → the nearest `.knowledge-mcp.json` from the
process cwd up to the git root.

```json
{
  "vaults": { "work": "~/vaults/work" },
  "defaultVaults": ["work"],
  "taskVault": "work",
  "projects": { "~/work/project": "work" },
  "knowledgeRoot": "Knowledge",
  "defaultTaskRoot": "tasks",
  "allowWrite": true,
  "qmd": { "enabled": true, "updateTtlMinutes": 10 }
}
```

| Key | Meaning |
| --- | --- |
| `vaults` | source name → one path, a list of paths, or `{path\|paths, label?, writable?, qmd?}` |
| `defaultVaults` | what an unqualified search covers; the first entry is the primary write target |
| `taskVault` | where `knowledge_task` workspaces live (defaults to the primary source) |
| `projects` | cwd prefix → source; the longest matching prefix wins, with a directory boundary |
| `knowledgeRoot` | source-relative root for curated notes |
| `defaultTaskRoot` | source-relative root for task workspaces when a repo has no `.knowledge-mcp.json` |
| `allowWrite` | global write gate; per-root `writable` narrows it further |

A repository may only select a registered source, the task/knowledge roots and
its own identity — `.knowledge-mcp.json` accepts `vault`, `taskRoot`,
`knowledgeRoot`, `repo.name`, `repo.path`, and nothing else. It cannot change
central paths, the write gate or the qmd settings.

Selection order for one source: explicit `vault` argument → repo config → longest
`projects` prefix → `defaultVaults[0]` → legacy `defaultVault` → error.
`knowledge_search` alone accepts an array of source names.

## Doctor

```bash
npm run doctor              # node dist/server.js --doctor
node dist/server.js --doctor --json | jq .
```

`knowledge_status` renders the same report, from the same code. Sections:

- **config** — path, state (`ok` / `missing` / `malformed` with the parser
  message), unknown keys kept as-is, legacy `defaultVault` migration hint, the
  write gate;
- **binaries** — `rg` (required), `qmd`, `git`: `present` (with path),
  `installable` (exact command), `blocked` (no manager on this machine),
  `disabled` (by config);
- **sources** — per source and per root: existence, readability, note count,
  `.obsidian` marker, `writable`, size, plus overlaps (`nested in …`,
  `copy of …: 120/211 notes`);
- **qmd** — per root: `ok`, `missing` (with the command that creates the
  collection), `stale path` (the collection still points at a directory that
  moved or vanished, with the remove/add commands), `stale index`, `drifted:
  N indexed vs M notes`, `disabled`, `unknown`;
- **repo** — `.knowledge-mcp.json` state, `taskRoot` (and whether it resolves in
  the write root), `knowledgeRoot`.

Exit code is 1 when anything required is broken, 0 otherwise; `--json` prints
the same data. The doctor never writes, never installs and never runs
`qmd update`.

## Setup

```bash
node dist/server.js --setup                    # discover + propose, writes nothing
node dist/server.js --setup --confirm          # merge into the config, with a backup
node dist/server.js --setup --confirm --qmd    # also create/refresh qmd collections
node dist/server.js --setup --force            # replace an unreadable config
node dist/server.js --setup --json             # machine-readable proposal
```

| Flag | Effect |
| --- | --- |
| `--roots a,b` | scan these directories instead of the defaults (`~/Obsidian`, `~/Documents`, `~/Personal`, `~/Work`, `~/Yandex.Disk*`, `~/Library/CloudStorage/*`, `~/Dropbox`, `~/iCloud Drive`) |
| `--min-notes N` | a directory counts as a source with at least N notes (default 20) |
| `--group name=/a,/b` | compose one multi-root source (repeatable) |
| `--task-vault name` | which source owns `knowledge_task` |
| `--project prefix=source` | add one `projects` entry explicitly (repeatable) |

Discovery reports nested vaults (a wrapper vault around another), copies (two
directories sharing most notes — the smaller one is proposed read-only), and
directories already registered. Existing keys that setup does not own are
preserved; the write is atomic, backed up as `<config>.bak.<timestamp>`, mode
`600`. `--qmd` runs `qmd collection add` and `qmd update` per root only with
`--confirm`; `qmd embed` is printed as a suggestion, never run.

Nothing is ever installed, and neither `~/.pi/agent/mcp.json` nor a repository's
`.knowledge-mcp.json` is written by setup — it prints the snippet instead.

## Task protocol

`knowledge_task` owns a workspace per ticket: `_task_index.md` (projection:
lifecycle, `latest_iteration`, `current_phase`, next action, blocker) and
append-only `iterations/NNNN-<stage>[-<phase>].md` events with auto-numbering and
`previous` links. Two separate axes: `status` is the event outcome
(`active`/`ready`/`blocked`/`done`), `taskStatus` is the workspace lifecycle
(`brainstorm`/`planning`/`implementing`/`reviewing`/`blocked`/`done`), inferred
from `stage` when omitted. Legacy `ticket`/`repos[]` indexes stay readable and
are never rewritten. Writes are two-phase; `status` is the fast recovery call.

## Writes

Without `confirm: true` a write returns a preview: the rendered note or a line
diff, plus warnings — duplicate titles, unresolved and ambiguous wikilinks,
frontmatter conventions of neighbouring notes, suspected secrets. With
`confirm: true` it writes, re-reads, re-parses the frontmatter and checks that
search rediscovers the note. Secrets are the only blocking warning.

Nothing is deleted: `retire` writes `status: retired` plus a date, `supersede`
writes `status: superseded` plus a `[[redirect]]` banner. Frontmatter is parsed
as a practical YAML subset; an unparsable block is kept verbatim and never
rewritten, and callers get a warning instead of a silent property loss.

## Trust boundary

- Notes are untrusted content: the server instructions tell the model not to
  follow instructions found inside them.
- Paths are resolved against the source roots: `..` escapes, absolute paths
  outside a root, symlinks pointing outside and protected directories
  (`.obsidian`, `.git`, `.trash`; `attachments` on write) are refused.
- Every external command runs with an argv array, never a shell.
- Reads and snippets are bounded; the largest body is `maxChars` (default 6000).

## Install

```bash
../../install.sh knowledge --dry-run   # plan only
../../install.sh knowledge             # npm ci, build, test, then register in ~/.pi/agent/mcp.json
```

Registration merges the entry and the per-tool exposure
(`knowledge_status`, `knowledge_search`, `knowledge_read`, `knowledge_task` are
direct; the rest are codemode). A fresh machine still needs the one-time
configuration — the installer prints the `--setup` hint from
`requirements.json`.

## Tests

```bash
npm test        # build + node --test --test-concurrency=4 tests/*.test.mjs
```

`md`, `safety`, `config`, `sources`, `repo-config`, `search`, `doctor`,
`discover`, `setup`, `task-compat`, `tools`, `contract`, `hygiene` and
`pi-client` — the last one spawns the built server through Pi's own MCP client
(`connect → tools/list → tools/call`) on a temporary tree with two sources, one
of them multi-root. Set `PI_MCP_ROOT` if Pi is installed outside the default
paths. Every fixture lives in the OS temp directory; qmd is disabled by config,
so the suite needs no index, no network and no vault.

`hygiene` guards the shipped text: no absolute home paths, no ticket-like
identifiers outside a neutral example prefix.

## Design notes

- `contract.ts` owns the tool surface, `render.ts` the text formats,
  `context.ts` the arg → context step, `doctor.ts` readiness, `sources.ts` path
  resolution, `collections.ts` the qmd collection-name rule, `overlap.ts` the
  copy rule, `requirements.json` the machine requirements. Nothing restates a
  rule it does not own.
- The qmd collection name is derived, never configured: `<source>` for a
  single-root source, `<source>-<label>` for a multi-root one, so the doctor can
  always pair an index with a directory.
- Examples in this package use neutral names only.
