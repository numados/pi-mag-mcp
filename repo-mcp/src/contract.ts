/** Single owner of the repo-mcp contract: the 21 tool names, titles,
 *  descriptions, input schemas, tier membership, annotations and the shared
 *  response envelope. server.ts only registers what this file declares, and
 *  the tests assert against it, so a drifting tool list fails a test instead
 *  of a consumer.
 *
 *  Tier boundary (recoverability and visibility, not how dangerous a command
 *  sounds):
 *    read (direct)     — nothing can be broken;
 *    allowed (direct)  — fetch (plain), pull (--ff-only only), staged-only commit;
 *    doctor            — repo_status (git + gh presence, policy summary);
 *    approval (2-step) — branch_create, merge, rebase, reset, restore, switch,
 *                        destructive_local (local mutations: reflog-recoverable
 *                        in practice, so gated rather than removed);
 *    generation        — branch_plan, commit_message (produce text, execute nothing);
 *    forbidden         — push/send-pack has NO tool; server.ts structurally
 *                        refuses push-shaped names.
 */
import { z } from "zod";

// ── shared response envelope ───────────────────────────────────────────

/** One envelope for all 21 tools: loose enough to always validate, typed
 *  enough for codemode autocompletion. Every text field passes redact(). */
export const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional().describe("Human-readable failure reason (ok=false only)"),
  mode: z.enum(["read", "allowed", "approval-preview", "approval-exec", "generation"]).optional().describe("Policy tier this response came from"),
  repo: z.string().optional().describe("Resolved repository toplevel the command ran in"),
  output: z.string().optional().describe("Command output (bounded, redacted)"),
  truncated: z.boolean().optional().describe("true = output was cut at the size bound"),
  requiresConfirmation: z.boolean().optional().describe("true = preview returned; re-call with confirm:true + the issued token to execute"),
  preview: z.record(z.string(), z.unknown()).optional().describe("Exactly what will run; show it to the user and obtain real approval before confirming"),
  command: z.string().optional().describe("Exact shell-quoted command (preview or executed)"),
  token: z.string().optional().describe("Single-use approval token (preview only)"),
  expiresAt: z.string().optional().describe("Token expiry ISO timestamp (preview only)"),
  branch: z.string().optional(),
  base: z.string().optional(),
  message: z.string().optional().describe("generation tools: produced text"),
  scopeUsed: z.enum(["staged", "unstaged"]).optional(),
  ticket: z.string().nullish().describe("absent or null when no ticket was supplied and none could be taken from the branch"),
  ticketSource: z.enum(["supplied", "branch", "none"]).optional(),
  historyConvention: z.string().optional(),
  git: z.record(z.string(), z.unknown()).optional(),
  gh: z.record(z.string(), z.unknown()).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

// ── shared input pieces ────────────────────────────────────────────────

const repoParam = z
  .string()
  .optional()
  .describe("Path to the git repository (default: server cwd). Validated via rev-parse; commands bind to the resolved toplevel.");

const confirmParam = z
  .boolean()
  .optional()
  .describe("Set true with token only after the user explicitly approves the exact preview; omit or set false to preview without execution.");

const tokenParam = z
  .string()
  .optional()
  .describe("Single-use approval token returned by the preview, required when confirm is true.");

function approvalDescription(what: string, extra: string): string {
  return `${what} — approval tier. WITHOUT confirm:true: validates everything, returns the exact shell-quoted command + a single-use token (TTL 5 min, bound to these exact args + repo HEAD + working-tree digest) and executes NOTHING. WITH confirm:true + token: executes exactly that command. The caller MUST show the preview to the user and obtain explicit approval for this exact operation and target first — confirm:true+token is a transport, not permission. ${extra}`;
}

// ── tool definitions ───────────────────────────────────────────────────

export type Tier = "read" | "allowed" | "doctor" | "approval" | "generation";

export interface ToolContract {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  tier: Tier;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

function defineTool(
  name: string,
  title: string,
  description: string,
  inputSchema: z.ZodType,
  tier: Tier,
  options: { destructive?: boolean; openWorld?: boolean } = {},
): ToolContract {
  const readOnly = tier === "read" || tier === "doctor" || tier === "generation";
  return {
    name,
    title,
    description,
    inputSchema,
    tier,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : options.destructive === true,
      idempotentHint: readOnly,
      openWorldHint: readOnly ? false : options.openWorld === true,
    },
  };
}

// ── doctor ─────────────────────────────────────────────────────────────

const REPO_STATUS = defineTool(
  "repo_status",
  "Repo server status",
  "Doctor: git and gh CLI presence with exact install commands (gh is NOT used by any repo-mcp tool today — listed per the missing-CLI policy for the future GitHub integration), plus the enforced policy summary (no push tool exists; pull is --ff-only; commit is staged-only; approvals are single-use 5-min tokens). No config or environment is exposed.",
  z.looseObject({ repo: repoParam }),
  "doctor",
);

// ── read tools ─────────────────────────────────────────────────────────

const GIT_STATUS = defineTool(
  "git_status",
  "Git status",
  "Read-only: git status --porcelain=v1 -b (branch header + index/worktree state).",
  z.looseObject({ repo: repoParam }),
  "read",
);

const GIT_LOG = defineTool(
  "git_log",
  "Git log",
  "Read-only: git log --oneline --decorate=short -n <limit> (limit 1..500, default 20), optionally limited to one path inside the repo. No other options are accepted.",
  z.looseObject({
    repo: repoParam,
    limit: z.number().optional().describe("1..500, default 20"),
    path: z.string().optional().describe("one in-repo path (passed after --)"),
  }),
  "read",
);

const GIT_DIFF = defineTool(
  "git_diff",
  "Git diff",
  "Read-only: git diff, optionally --cached (staged) or against a base ref, optionally one in-repo path. staged and base are mutually exclusive. No other options.",
  z.looseObject({
    repo: repoParam,
    staged: z.boolean().optional().describe("diff --cached (index vs HEAD)"),
    base: z.string().optional().describe("commit-ish to diff against"),
    path: z.string().optional().describe("one in-repo path (passed after --)"),
  }),
  "read",
);

const GIT_SHOW = defineTool(
  "git_show",
  "Git show",
  "Read-only: git show <ref> (default HEAD), optionally one in-repo path. Output bounded to 1 MiB.",
  z.looseObject({
    repo: repoParam,
    ref: z.string().optional().describe("commit-ish (default HEAD)"),
    path: z.string().optional().describe("one in-repo path (passed after --)"),
  }),
  "read",
);

const GIT_BRANCH_LIST = defineTool(
  "git_branch_list",
  "List branches",
  "Read-only: all local and remote-tracking branches with sha and upstream (git for-each-ref over refs/heads and refs/remotes).",
  z.looseObject({ repo: repoParam }),
  "read",
);

const GIT_BLAME = defineTool(
  "git_blame",
  "Git blame",
  "Read-only: git blame --porcelain for one in-repo path, optionally at a ref.",
  z.looseObject({
    repo: repoParam,
    path: z.string().optional().describe("in-repo file to blame (required)"),
    ref: z.string().optional().describe("commit-ish (default working tree)"),
  }),
  "read",
);

const GIT_DEFAULT_BRANCH = defineTool(
  "git_default_branch",
  "Default branch",
  "Read-only: the repository integration branch — origin/HEAD (symbolic-ref, cached 60s), else the local branch tracking origin/master|main; ambiguous/undetectable is an error, never a guess.",
  z.looseObject({ repo: repoParam }),
  "read",
);

const GIT_REFS = defineTool(
  "git_refs",
  "List refs",
  "Read-only: for-each-ref listing (kind: heads | remotes | tags | all, default all). No patterns are accepted — no wildcard input.",
  z.looseObject({
    repo: repoParam,
    kind: z.enum(["heads", "remotes", "tags", "all"]).optional(),
  }),
  "read",
);

// ── allowed: fetch / pull / commit ─────────────────────────────────────

const GIT_FETCH = defineTool(
  "git_fetch",
  "Git fetch",
  "git fetch [<remote>] (default origin) — user-allowed without preview per repo-mcp policy. Deliberately plain: no --prune, no --tags, no refspec, no config changes, no force. Remote must be a configured remote NAME (never a URL). Network + remote hooks may run; output is credential-redacted.",
  z.looseObject({
    repo: repoParam,
    remote: z.string().optional().describe("configured remote name (default origin)"),
  }),
  "allowed",
  { openWorld: true },
);

const GIT_PULL = defineTool(
  "git_pull",
  "Git pull",
  "git pull --ff-only [<remote> [<branch>]] — user-allowed without preview. Conservative documented default: noninteractive fast-forward ONLY; a diverged branch fails instead of creating a merge; no rebase/merge strategy flags, no force, no config changes (an explicit merge after that is the approval-tier `merge` tool). Remote must be a configured remote NAME.",
  z.looseObject({
    repo: repoParam,
    remote: z.string().optional().describe("configured remote name (default: tracked upstream)"),
    branch: z.string().optional().describe("branch to pull (requires remote)"),
  }),
  "allowed",
  { openWorld: true },
);

const GIT_COMMIT = defineTool(
  "git_commit",
  "Git commit",
  "git commit -m <message> — user-allowed without preview. STRICT: commits ONLY what is already staged; stages nothing (no git add), never amends, never bypasses hooks. Before commit, repo-mcp enforces the staged text-file size policy (default 5,000 estimated tokens, bytes/4; new production source files only by default; tests, documentation and text/data files are excluded; see .agent-file-size.conf). Nothing staged is an error telling the caller to stage. Hooks and config (gpgsign, hooks) run normally — see the trust boundary in repo_status. Use commit_message first if you need message text.",
  z.looseObject({
    repo: repoParam,
    message: z.string().describe("the exact commit message (caller-supplied; multi-line allowed)"),
  }),
  "allowed",
);

// ── approval tier ──────────────────────────────────────────────────────

const BRANCH_CREATE = defineTool(
  "branch_create",
  "Create branch",
  approvalDescription(
    "git switch -c <name> <base>",
    "base defaults to the detected default branch (origin/HEAD → tracking fallback; ambiguous → error); pass base explicitly otherwise. Use branch_plan to derive the name first. Never checks out or moves the base branch itself.",
  ),
  z.looseObject({
    repo: repoParam,
    name: z.string().describe("new branch name (validated: plain refs/heads name)"),
    base: z.string().optional().describe("base ref (default: detected default branch)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
);

const MERGE = defineTool(
  "merge",
  "Merge",
  approvalDescription(
    "git merge --no-edit <ref>",
    "No squash, no strategy options, no editor. Noninteractive. Hooks run normally (trust boundary).",
  ),
  z.looseObject({
    repo: repoParam,
    ref: z.string().describe("commit-ish / branch to merge"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
);

const REBASE = defineTool(
  "rebase",
  "Rebase",
  approvalDescription(
    "git rebase [<base>]",
    "Plain noninteractive rebase onto base (default: the branch's configured upstream). No -i, no --onto, no --autosquash, no continue/skip plumbing.",
  ),
  z.looseObject({
    repo: repoParam,
    base: z.string().optional().describe("base ref (default: configured upstream)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
);

const RESET = defineTool(
  "reset",
  "Reset",
  approvalDescription(
    "git reset --soft|--mixed|--hard [<ref>]",
    "Local history/index rewrite — this is the destructive tier. mode is required at preview time (default mixed); ref defaults to HEAD. No pathspec form — use restore for files.",
  ),
  z.looseObject({
    repo: repoParam,
    mode: z.enum(["soft", "mixed", "hard"]).optional(),
    ref: z.string().optional().describe("commit-ish to reset to (default HEAD)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
  { destructive: true },
);

const RESTORE = defineTool(
  "restore",
  "Restore files",
  approvalDescription(
    "git restore [--source <ref>] -- <paths>",
    "Discards working-tree (or --source) changes for the explicitly supplied in-repo paths. Every path is validated to stay inside the repository and passed after a literal '--'.",
  ),
  z.looseObject({
    repo: repoParam,
    paths: z.array(z.string()).describe("in-repo paths to restore (required, non-empty)"),
    ref: z.string().optional().describe("--source commit-ish (default: index/HEAD)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
  { destructive: true },
);

const SWITCH = defineTool(
  "switch",
  "Switch branch",
  approvalDescription(
    "git switch <branch>",
    "Plain switch to an existing local branch — no -c (creation is branch_create), no --detach, no force. Dirty-worktree conflicts are left to git to refuse.",
  ),
  z.looseObject({
    repo: repoParam,
    branch: z.string().describe("existing local branch (validated name)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
);

const DESTRUCTIVE_LOCAL = defineTool(
  "destructive_local",
  "Destructive local cleanup",
  approvalDescription(
    "action clean → git clean -f -d -- <paths> (irreversibly deletes ONLY the supplied untracked paths; preview embeds the exact `git clean -n -d` dry-run listing); action branch_delete_force → git branch -D <name> (exact validated name, no globs, no ranges)",
    "Nothing here touches remotes. clean never uses -x (ignored files stay). The dry-run listing and the single-use token pin the exact paths; any working-tree change invalidates the token.",
  ),
  z.looseObject({
    repo: repoParam,
    action: z.enum(["clean", "branch_delete_force"]),
    paths: z.array(z.string()).optional().describe("clean only: in-repo untracked paths to delete (required, non-empty)"),
    name: z.string().optional().describe("branch_delete_force only: exact branch name (no globs)"),
    confirm: confirmParam,
    token: tokenParam,
  }),
  "approval",
  { destructive: true },
);

// ── generation (no execution) ──────────────────────────────────────────

const BRANCH_PLAN = defineTool(
  "branch_plan",
  "Plan a branch",
  "Generation only — returns the Numados-convention branch name + exact `git switch -c` command, executing NOTHING. Jira: bugfix|feature/<KEY> with the key preserved verbatim, no suffix. ADO: bugfix|feature/<numeric-id>-<2-5-kebab-words> with the id preserved verbatim. Base = cached origin/HEAD → tracking-branch fallback → error when ambiguous (pass base explicitly; never guesses). Task numbers are used exactly as supplied — never reformatted, padded, or invented.",
  z.looseObject({
    repo: repoParam,
    tracker: z.enum(["jira", "ado"]),
    type: z.enum(["bugfix", "feature"]),
    ticket: z.string().describe("Jira key (PROJ-123) or ADO numeric work-item id, exactly as supplied"),
    description: z.string().optional().describe("ADO only: 2–5 kebab words naming the change's topic (normalized, validated)"),
    base: z.string().optional().describe("explicit base ref — only used when supplied; else default-branch detection"),
  }),
  "generation",
);

const COMMIT_MESSAGE = defineTool(
  "commit_message",
  "Draft a commit message",
  "Generation only — formats message text, mutating nothing. Gathers context read-only: staged diff (falls back to unstaged when nothing is staged and says so), ticket from the branch name when present, a 10-subject history sample with convention detection, and which repo instruction files exist. Formatting is the deterministic Conventional-Commits FALLBACK from caller-supplied type/scope/summary/body — the response states the selected context and the limitation that semantics/conventions cannot be inferred reliably without caller judgment. Prefer supplying the final message to git_commit when the convention is known.",
  z.looseObject({
    repo: repoParam,
    type: z.enum(["feat", "fix", "test", "docs", "refactor", "perf", "build", "ops", "chore", "style"]),
    scope: z.string().optional().describe("changed topic token, not the repository name"),
    summary: z.string().describe("imperative one-liner naming the durable outcome"),
    body: z
      .union([z.array(z.string()), z.string()])
      .optional()
      .describe("1–3 bullets of durable outcomes (optional; an array, or newline-separated text as the source accepted)"),
    ticket: z.string().optional().describe("explicit ticket/id — used exactly as supplied; else taken from the branch name"),
  }),
  "generation",
);

export const TOOLS: readonly ToolContract[] = [
  REPO_STATUS,
  GIT_STATUS,
  GIT_LOG,
  GIT_DIFF,
  GIT_SHOW,
  GIT_BRANCH_LIST,
  GIT_BLAME,
  GIT_DEFAULT_BRANCH,
  GIT_REFS,
  GIT_FETCH,
  GIT_PULL,
  GIT_COMMIT,
  BRANCH_CREATE,
  MERGE,
  REBASE,
  RESET,
  RESTORE,
  SWITCH,
  DESTRUCTIVE_LOCAL,
  BRANCH_PLAN,
  COMMIT_MESSAGE,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function toolByName(name: string): ToolContract | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** The exact approval tier (D-R7): seven tools, none promoted to allowed,
 *  none demoted to forbidden. push/send-pack stays tool-less. */
export const APPROVAL_TIER: readonly string[] = [
  "branch_create",
  "merge",
  "rebase",
  "reset",
  "restore",
  "switch",
  "destructive_local",
];

/** Tool names that get the structural refusal (there is no such tool). */
export const FORBIDDEN_SHAPE = /push|send[_-]?pack|remote-write|exec/i;
