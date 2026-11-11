---
name: knowledge-vault
description: Use the knowledge MCP server (Obsidian-compatible Markdown vaults, possibly spread over several directories) for durable knowledge and numados task tracking — hybrid/lexical/graph search across sources, bounded reads, two-phase validated writes, link graph, and the knowledge_task workspace protocol. Use whenever reading or writing the knowledge store, diagnosing vault configuration, resolving a source or task workspace, promoting reusable engineering knowledge, or recovering numados task state on a machine where knowledge-mcp is installed. When the server's tools are not visible, numados skills fall back to the filesystem protocol over the same config files.
---

# Knowledge Vault (knowledge-mcp)

Single owner of the knowledge domain: source routing, storage, search, formats,
and the numados task-tracking protocol. `search-mcp` stays generic content
retrieval and does not search the vault.

## Two-level model

- **Central config** `~/.config/knowledge-mcp/config.json` (env
  `KNOWLEDGE_MCP_CONFIG`): `vaults` (name → one path or several), `defaultVaults`,
  `taskVault`, `projects` (cwd prefix → source), `knowledgeRoot`,
  `defaultTaskRoot`, `allowWrite`, `qmd`. Cross-repo tasks live at
  `<Area>/tasks/<TICKET>/`.
- **Per-repo** `<repo>/.knowledge-mcp.json`: binds a checkout to its slice —
  `vault`, `taskRoot`, `knowledgeRoot`, `repo`. It cannot change central paths,
  the write gate or qmd settings.

Never guess a source or a path: resolve through the server, these config files,
or `knowledge_status`.

## Sources can span several directories

One source is a named, ordered list of roots (for example a synced vault, a
shared notes folder and an archive). Consequences for everyday use:

- a reference is root-relative; `<label>:<rel>` addresses one root explicitly;
- the same relative path in two roots is reported as ambiguous, and the error
  names the exact form to use — copy it instead of guessing;
- a bare note name resolves when it is unique across the source;
- writes go to the first writable root; a read-only root refuses with
  `source root "<label>" is read-only by config`;
- wikilinks share one namespace per source, so a duplicated note name shows up
  as `AMBIGUOUS` in `knowledge_links`.

## Tools

| Tool | R/W | Exposure | Use for |
| --- | --- | --- | --- |
| `knowledge_status` | r | direct | config, binaries, sources, qmd state, repo layer — the doctor report |
| `knowledge_search` | r | direct | `hybrid` (qmd BM25 → rg), `lexical` (rg + context), `graph` (note → one-hop links/backlinks); one source, a list of sources, or `defaultVaults` |
| `knowledge_read` | r | direct | bounded read: `meta` / `outline` / `body` / `section` |
| `knowledge_links` | r | codemode | resolved outgoing wikilinks + backlinks |
| `knowledge_structure` | r | codemode | folder inventory; `conventions` answers "what format to write in here" |
| `knowledge_write` | w | codemode | `create` / `update` / `retire` / `supersede` — two-phase |
| `knowledge_move` | w | codemode | rename/move with `[[link]]` rewriting — two-phase |
| `knowledge_task` | rw | codemode | numados task protocol: `status`, `init`, `iteration`, `update` |
| `knowledge_repo` | r | codemode | knowledge map around a repository |

Codemode-exposure tools are not direct calls in every harness — invoke them
through the harness's MCP scripting facility (pi: codemode).

## Usage rules

- **Search, then bounded read:** `knowledge_search` for candidates, then
  `knowledge_read` with the smallest `part` that answers the question. Cite
  source-relative paths and headings, not pasted excerpts.
- **Writes are always two-phase:** a call without `confirm: true` returns a
  preview (rendered note or diff) plus warnings — duplicate titles, unresolved
  or ambiguous wikilinks, neighbour-convention mismatch, suspected secrets. Show
  the preview, then re-call with `confirm: true`; that call also re-reads,
  re-parses the frontmatter and checks rediscovery by search.
- **No deletions:** `retire` and `supersede` are frontmatter markers plus a
  redirect banner.
- **Formats:** Markdown + YAML frontmatter + `[[wikilinks]]`. Frontmatter is
  emitted when neighbours have it (>50%) or when asked explicitly. An
  unparsable frontmatter block is stored verbatim and never rewritten.
- **Task protocol:** `knowledge_task` owns `_task_index.md` (projection: status,
  `latest_iteration`, next action, blocker) and append-only
  `iterations/NNNN-<stage>.md` events with auto-numbering and `previous` links —
  the same `numados-task-*-v1` formats the workflow skills write directly on the
  filesystem when this server is absent. Open every session with `status`; one
  event per meaningful iteration, not per command; correct earlier conclusions
  with a later event.
  `status` is the event outcome (`active|ready|blocked|done`); `taskStatus` is
  the workspace lifecycle (`brainstorm|planning|implementing|reviewing|blocked|done`)
  and follows `stage` when omitted. `active` and `ready` never replace the
  lifecycle. Set `taskRoot` explicitly when neither central nor per-repository
  config provides one.

## When something is wrong

- `knowledge_status` first; it is the same report as `node dist/server.js
  --doctor`, so an agent may also run that command and report its exit code.
- `malformed` config, `missing` source, `stale path` or `drifted` qmd entry, a
  `nested` or a `copy of` note set: each line names the next action. Do not
  invent a fix the report does not state.
- Configuration is created with `node dist/server.js --setup` (preview), and
  applied with `--setup --confirm` (backup, atomic write, unknown keys kept).
  `--group name=/a,/b` composes a multi-root source; `--qmd` adds the qmd
  collections. Never hand-write a vault path you did not verify.
- `qmd` missing means hybrid search degrades to ripgrep; the answer says so
  (`note: degraded: lexical only`). That is a degradation, not an error.

## Degradation and absence

- If the server's tools are not visible in the harness, it is not installed:
  numados workflow skills then read and write the same vault through the
  filesystem protocol using the same config files. Do not fabricate tools.
- A failed search is not proof of absence: try other terms, another source, or
  `mode=graph` before concluding a note does not exist.
