# Contributing — pi-mag-mcp

Pi-specific MCP servers, one flat package per server, registered into
`~/.pi/agent/mcp.json` by `install.sh`. These are the repository-specific rules; harness-level working instructions
apply on top of them.

## Content hygiene (mandatory)

Everything in this repository is published with the package: code, comments,
tests, fixtures, documentation, the `requirements.json` tables, the skill files
and the commit messages. None of it may carry machine- or tenant-specific data.

Never commit:

- absolute home paths — use `~/...` in documentation and `mkdtempSync(tmpdir())`
  in tests;
- customer, employer, product or colleague names, domains, URLs, ticket
  prefixes, vault names or note titles from real data — use neutral placeholders
  (`example-vault`, `Projects/overview.md`, `service-a`, `ABC-123`,
  `/opt/notes/example-vault`);
- e-mail addresses, hostnames, tokens or anything copied out of a live
  configuration file.

When porting code from another catalogue, the source's tests and comments are
part of the port: sanitise them in the same change, do not defer it.

Check before committing:

```bash
scripts/check-content.sh            # tracked files
scripts/check-content.sh --history  # plus every commit message
```

The real-name denylist is machine-local (`~/.pi/agent/content-denylist.txt`) and
must never be committed — writing the names into the repository would leak them
again. Each package also guards itself: `tests/hygiene.test.mjs` asserts that no
home path or non-neutral ticket prefix appears in its shipped text.

If a leak already reached a commit, fix it in a follow-up commit and say so in
the message; rewriting published history needs explicit approval.

## Package conventions

- One directory per server at the repository root (`search-mcp/`,
  `knowledge-mcp/`, …), no nested type layers. A package is self-contained:
  its own `package.json`, `tsconfig.json`, `requirements.json`, README, tests and
  optional `skills/`.
- SDK v2 (`@modelcontextprotocol/server`) with zod input schemas; strict
  NodeNext TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  and `noUnusedLocals`; `engines.node >= 22`.
- Tests: `node --test --test-concurrency=4 tests/*.test.mjs`, files named after
  the capability they cover (`contract`, `domain`, `subprocess`, `pi-client`,
  `hygiene`). Fixtures live in the OS temp directory; no network, no live
  configuration, no user data.
- One owner per rule: the tool surface in `contract.ts`, text formats in
  `render.ts`, configuration in `config.ts`, readiness in `doctor.ts`, machine
  requirements in `requirements.json`. A handler never restates a rule another
  module owns.
- External commands always run with an argv array — never a shell string.
- A tool list is fixed at build time; availability is reported in answers, not by
  adding or hiding tools at runtime.
- `install.sh` registers one named server and prints, never performs, a
  server's declared `setup` step.

## Commits

`type(scope): imperative description` (`feat`, `fix`, `refactor`, `docs`,
`test`, `chore`), scope = server or area. The body explains why; no AI
attribution, no ticket id unless the branch carries one. State the verification
that was actually run.
