---
name: git-ops
description: "Perform all Git operations through the repo MCP server — policy is enforced server-side, not by prompt rules: direct read tools, allowed fetch/pull/staged-commit, two-step approval tokens for branch/merge/rebase/reset/switch/clean, generation tools for branch names and commit messages, and structurally refused push. Use for any Git state inspection or mutation on machines where repo-mcp is installed; it replaces raw `git` CLI calls, which stay the fallback when the server is absent."
---

<!-- Ported from agent-toolkit/mcp/repo-mcp at ca48d8d. -->

# Git Ops (repo-mcp)

Git wrapper that enforces the destructive-operation policy **in the server**:
fixed argv templates, `shell:false`, no flags accepted, paths resolved inside
the repo toplevel. `git push` / `git send-pack` have **no tool at all** —
asking is structurally refused.

## Tool tiers

| Tier | Tools |
|---|---|
| read (direct) | `git_status`, `git_log`, `git_diff`, `git_show`, `git_branch_list`, `git_blame`, `git_default_branch`, `git_refs` |
| allowed (direct) | `git_fetch` (plain), `git_pull` (`--ff-only`), `git_commit` (staged only, supplied message only — never stages, amends, or bypasses hooks) |
| approval (two-step) | `branch_create`, `merge`, `rebase`, `reset`, `restore`, `switch`, `destructive_local` (`clean` with explicit paths / `branch_delete_force` with exact name) |
| generation (no exec) | `branch_plan`, `commit_message` |

## Two-step approval flow

1. Call **without** `confirm: true` → everything is validated; you get the
   exact shell-quoted command, an embedded `git clean -n` dry-run for `clean`,
   and a single-use opaque token (TTL 5 min).
2. Show the preview to the user and obtain approval.
3. Re-call with `confirm: true` + token → executes exactly the cached argv,
   only when args, repository, HEAD, and the working-tree **content
   fingerprint** are unchanged. Re-editing a modified file, re-staging
   different content, or rewriting an untracked file all invalidate the token.

`confirm: true` is a transport for the caller's obtained approval — it is not
human permission itself. `pull`/`merge`/`rebase`/`restore`/hard `reset`
refuse repositories with ignored local files as a conservative safeguard.

## Usage rules

- Prefer read tools over shell `git` for status/diff/history — bounded output
  (1 MiB/stream) and redacted credential-bearing URLs.
- Optional `repo` param (default cwd) binds every command to the resolved
  toplevel; `blame` takes a literal filename.
- Staging exception: the server has no staging tool. Only after the user
  authorizes the implementation/commit scope, stage verified exact phase paths
  using `git add -- <paths>` through the shell, or ask the user to stage.
  Never stage all files, alter unrelated staging, or use this exception for
  other Git mutations. `git_commit` remains staged-only.
- Generation tools produce plans/text without executing — pair
  `commit_message` with `git_commit`, `branch_plan` with `branch_create`.
- Trust boundary: hooks and repo config run as on your machine; the server
  neither bypasses nor sandboxes them.

## Absence

If these tools are not visible, use the `git` CLI directly while keeping the
same discipline: approval before any mutating operation, no push, no
amend/bypass, staged-only commits with supplied messages.
