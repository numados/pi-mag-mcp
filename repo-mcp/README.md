# repo-mcp

Git wrapper MCP server (stdio) that enforces three Git operation tiers
server-side: reads, allowed operations and approval-gated local mutations.
It uses TypeScript ESM, one fixed-argv Git template per tool and `shell:false`
for every subprocess.

> Ported from `agent-toolkit/mcp/repo-mcp` at revision `ca48d8d` onto the
> delivered `pi-mag-mcp` stack (`@modelcontextprotocol/server` 2.4.0 + zod 4,
> strict TypeScript, `engines.node >=22`). Safety bounds, check order and
> operation tiers remain unchanged. This port adds default test-file exclusions
> to the commit size policy.

## Tool surface

| Tier | Tools |
|---|---|
| read (direct) | `git_status`, `git_log`, `git_diff`, `git_show`, `git_branch_list`, `git_blame`, `git_default_branch`, `git_refs` |
| allowed (direct) | `git_fetch` (plain, no `--prune`), `git_pull` (`--ff-only` only, noninteractive), `git_commit` (staged only, supplied message only — never stages, amends, or bypasses hooks; staged text-size preflight) |
| doctor | `repo_status` — git/gh presence + exact install commands (gh unused by tools today), policy summary |
| approval (two-step) | `branch_create`, `merge`, `rebase`, `reset`, `restore`, `switch`, `destructive_local` (`clean` with explicit paths / `branch_delete_force` with an exact name) |
| generation (no exec) | `branch_plan`, `commit_message` |
| forbidden | `git push` / `git send-pack` — **no tool exists**, and asking for one is structurally refused |

## Commit size policy

`git_commit` performs a fail-closed preflight against staged Git blobs before
starting `git commit`. The default is 5,000 estimated tokens (`bytes/4`,
20,000 bytes). By default it checks new production source files, not existing
files, tests, blog posts, documentation, text/data files, locks, generated files
or binaries. A repository can tune the policy through its staged,
non-executable `.agent-file-size.conf`.

The size limit encourages focused production modules. Test suites and text
files do not need to be split to satisfy this limit. Test exclusions use
conventional directory and filename patterns, not file contents. Unrecognized
test layouts can use a narrow `ignore=...` rule in `.agent-file-size.conf`.

The preflight runs before the repository's own hooks. Those hooks still run
and can enforce different rules. This package does not install or update
external hooks. If a formatter changes the index, a later size-check hook
must support these exclusions independently.

## Two-step approvals

1. Call without `confirm:true` → everything is validated, you get the exact
   shell-quoted command, an embedded `git clean -n` dry-run for `clean`, and a
   single-use opaque token (TTL 5 min).
2. Re-call with `confirm:true` + `token` → executes exactly the cached argv,
   only when the args, repository, HEAD, and working-tree **content
   fingerprint** are unchanged.

The fingerprint hashes HEAD, raw `status -z -uall` bytes, every staged index
row (`ls-files --stage`), and the actual bytes/symlink targets of every
modified and untracked file — not just the porcelain shape, so re-editing an
already-modified file, re-staging different content, or rewriting an
untracked file all invalidate the token. `git diff` is deliberately avoided
(repository-configured external diff drivers / textconv would execute);
plumbing and direct bounded reads form the fingerprint. Ignored files are not hashed.
`clean` never uses `-x`. Switch operations use `--no-overwrite-ignore`.
As a conservative safeguard, pull, merge, rebase, restore and hard reset refuse repositories with ignored local files.
This restriction also applies to harmless ignored files, such as installed dependencies.
All fingerprint IO is bounded
(per-file 4 MiB, total 16 MiB, 4096 files, 2 MiB plumbing caps) and fails
closed: unreadable/special/oversized input refuses token issuance instead of
silently weakening the digest.

Tokens are consumed **before** the child spawns (no concurrent replay). The
tool descriptions and previews state plainly: `confirm:true` is a transport
for the caller's obtained approval, not human permission itself.

## Hard rules baked into the code

- No tool accepts commands, flags, or options — only values in fixed argv
  positions; refs reject leading `-` and control characters; paths resolve
  inside the repo toplevel. Pathspec arguments use `:(literal)` after `--`.
  `blame` takes a literal filename instead of a pathspec.
- Optional `repo` param (default cwd) validated with `rev-parse`; all commands
  bind to the resolved toplevel.
- Spawned git: `shell:false`, stdin closed, `GIT_TERMINAL_PROMPT=0`, output
  bounded (1 MiB/stream) with a truncated flag. The server drains output beyond the limit without terminating a mutation.
  Failed or cancelled commands never become successful because their output was truncated.
  Cancellation sends SIGTERM, then SIGKILL after five seconds. On POSIX, cancellation targets the process group.
  A pre-aborted call does not spawn Git or consume an approval token.
- Credential-bearing URLs and common token literals are redacted from all
  output.
- No config list, no env exposure, no generic exec.
- Trust boundary (documented, not sandboxed): hooks and repo config run as on
  your machine; the server neither bypasses nor sandboxes them.

## Code layout

`src/tools.ts` assembles the handlers and applies the cancellation/error wrapper.
The handlers are grouped by responsibility under `src/tools/`:

| Module | Responsibility |
| --- | --- |
| `read.ts` | Read-only Git operations |
| `allowed.ts` | Fetch, fast-forward pull and staged commit |
| `approval.ts` | Validation and command templates for local mutations |
| `approval-engine.ts` | Shared preview, fingerprint and confirmation flow |
| `generation.ts` | Branch-plan and commit-message result adapters |
| `status.ts` | Tool status and the command-line doctor report |
| `common.ts` | Shared Git results, failures and ignored-file guard |

Tool metadata and schemas remain in `src/contract.ts`.

## Install

```bash
# from the pi-mag-mcp repository root
./install.sh list              # readiness report, changes nothing
./install.sh repo              # build, test, register with Pi
./install.sh repo --dry-run    # print the plan; changes nothing
```

No config file is required beyond `git`. Registration is `pi-mag-mcp`'s
`install.sh` (one registry row), never the source `scripts/setup.sh`.

## Doctor

```bash
node dist/server.js --doctor     # or: the repo_status tool
```

Prints git/gh presence with the exact install commands and the enforced policy
summary; exits non-zero when `git` is missing.

## Tests

```bash
npm ci && npm run build && npm test
```

Tests build throwaway git fixtures under an isolated HOME (no real git config,
no hooks, no remotes), a recording mock runner for fetch/pull and injection
cases, and a real-Pi-client stdio smoke test. The 64 ported tests plus the
`contract`, `pi-client` and `hygiene` files are the specification of the
safety surface.
