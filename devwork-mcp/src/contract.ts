/**
 * Single owner of the devwork-mcp contract: tool names, descriptions, input
 * schemas, annotations, the shared response envelope and the write-operation
 * class of every tool. server.ts only registers what this file declares, and
 * the tests assert against it, so a drifting tool list fails a test instead of
 * a consumer.
 */
import { z } from "zod";
import { WRITE_OPERATIONS, type WriteOperation } from "./types.js";

export const BACKENDS = ["ado", "jira", "github"] as const;
export const BINARY = ["ado", "github"] as const;
export const VOTES = ["approve", "approve-with-suggestions", "no-vote", "wait-for-author", "reject"] as const;

export const LIMITS = {
  /** Read cache TTL default; 0 disables caching. */
  cacheTtlSeconds: 60,
  /** Default page size for queries. */
  top: 20,
  /** Upper bound accepted for any page size. */
  maxTop: 200,
  /** Preview lifetime before a confirm must be shown again. */
  approvalTtlSeconds: 600,
  /** ADO request budget. */
  adoTimeoutMs: 30_000,
  /** HTTP budget for GitHub and Jira. */
  httpTimeoutMs: 30_000,
} as const;

export const ENV = {
  /** Installation id; the project-scoped MCP entry sets it. */
  installation: "DEVWORK_INSTALLATION",
  /** Absolute path to an installation profile, when not using the id. */
  installationFile: "DEVWORK_INSTALLATION_FILE",
  /** Directory holding `<id>.json` profiles. */
  installationsDir: "DEVWORK_INSTALLATIONS_DIR",
  /** Repository layer that may only name an installation. */
  repoFile: ".devwork-mcp.json",
} as const;

// ── shared response envelope ───────────────────────────────────────────

/** One envelope for all fourteen tools: loose enough to always validate, typed
 *  enough for codemode autocompletion. */
export const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional().describe("Human-readable failure reason (ok=false only)"),
  backend: z.enum(BACKENDS).optional(),
  item: z.record(z.string(), z.unknown()).optional().describe("Normalized work item"),
  items: z.array(z.record(z.string(), z.unknown())).optional().describe("Query result rows (summaries)"),
  count: z.number().optional(),
  pr: z.record(z.string(), z.unknown()).optional().describe("Normalized pull request"),
  prs: z.array(z.record(z.string(), z.unknown())).optional(),
  repos: z.array(z.record(z.string(), z.unknown())).optional(),
  requiresConfirmation: z
    .boolean()
    .optional()
    .describe("true = preview returned; re-call with the same arguments, confirm:true and this approvalToken"),
  approvalToken: z.string().optional().describe("One-time token binding this preview to the confirming call"),
  approvalTtlSeconds: z.number().optional(),
  preview: z.record(z.string(), z.unknown()).optional().describe("What will change or be created; show it to the user before confirming"),
});
export type Envelope = z.infer<typeof envelopeSchema>;

// ── shared input pieces ────────────────────────────────────────────────

const ref = z.string().trim().min(1, "a work item id, key, owner/repo#N or URL is required");
const confirm = z.boolean().optional().describe("false/omitted returns a preview; true executes after the user approves it");
const approvalToken = z
  .string()
  .optional()
  .describe("approvalToken from the preview of exactly these arguments; required when the installation requires a preview");
const repoParam = z.string().min(3).optional().describe("owner/repo (GitHub) or repository name (ADO)");
const topParam = z.number().int().min(1).max(LIMITS.maxTop).optional().describe(`page size (1-${LIMITS.maxTop})`);
const workItemFields = z
  .record(z.string(), z.string())
  .optional()
  .describe("extra backend-native fields (ADO System.*/Microsoft.VSTS.*, Jira field names)");

// ── input schemas (exported: handlers derive their argument types here) ──

export const statusInput = z.strictObject({});

export const getInput = z.strictObject({
  ref,
  repo: repoParam,
  refresh: z.boolean().optional().describe("bypass the read cache (default false)"),
});

export const queryInput = z.strictObject({
  backend: z.enum(BACKENDS).optional(),
  repo: repoParam,
  type: z.string().optional().describe("work item type / issue type ('pr' on GitHub = pull requests)"),
  state: z.string().optional(),
  assignedTo: z.string().optional().describe("display name/email, or 'me'"),
  contains: z.string().optional().describe("substring in title or description"),
  changedWithinDays: z.number().int().min(1).optional(),
  top: topParam,
});

export const createInput = z.strictObject({
  type: z.string().min(1).describe("Bug, Task, User Story / Jira issuetype / GitHub: Issue"),
  title: z.string().min(1),
  description: z.string().optional(),
  assignedTo: z.string().optional().describe("display name or email (GitHub: login)"),
  area: z.string().optional().describe("ADO area path"),
  iteration: z.string().optional().describe("ADO iteration path"),
  state: z.string().optional(),
  comment: z.string().optional().describe("initial comment"),
  labels: z.array(z.string()).optional().describe("GitHub labels"),
  fields: workItemFields,
  project: z.string().optional().describe("Jira project key (required for Jira), ADO project override, GitHub owner/repo"),
  backend: z.enum(BACKENDS).optional().describe("force backend (default: installation routing)"),
  confirm,
  approvalToken,
});

export const updateInput = z.strictObject({
  ref,
  repo: repoParam,
  title: z.string().optional(),
  state: z.string().optional(),
  reason: z.string().optional().describe("ADO state-change reason"),
  assignedTo: z.string().optional(),
  description: z.string().optional(),
  comment: z.string().optional().describe("add a discussion comment"),
  area: z.string().optional(),
  iteration: z.string().optional(),
  fields: workItemFields,
  confirm,
  approvalToken,
});

export const reposInput = z.strictObject({});

export const prShowInput = z.strictObject({
  ref: z.string().trim().min(1, "a PR id or URL is required"),
  repository: repoParam,
});

export const prListInput = z.strictObject({
  backend: z.enum(BINARY).optional(),
  repository: repoParam,
  status: z.enum(["active", "completed", "abandoned", "all"]).optional(),
  creator: z.string().optional(),
  reviewer: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  top: topParam,
});

export const prCreateInput = z.strictObject({
  backend: z.enum(BINARY).optional(),
  repository: z.string().min(3, "repository is required (owner/repo or ADO repo name)"),
  sourceBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  draft: z.boolean().optional(),
  autoComplete: z.boolean().optional().describe("ADO only"),
  deleteSourceBranch: z.boolean().optional().describe("ADO only"),
  reviewers: z.array(z.string()).optional().describe("ADO only"),
  linkWorkItems: z.array(z.number().int()).optional().describe("work item/issue ids → AB# (ADO) / Closes # (GitHub)"),
  confirm,
  approvalToken,
});

export const prUpdateInput = z.strictObject({
  ref: z.string().trim().min(1, "a PR id or URL is required"),
  repository: repoParam,
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["active", "abandoned", "completed"]).optional().describe("GitHub: completed = merge (squash)"),
  autoComplete: z.boolean().optional().describe("ADO only"),
  draft: z.boolean().optional().describe("ADO only"),
  confirm,
  approvalToken,
});

export const prVoteInput = z.strictObject({
  ref: z.string().trim().min(1, "a PR id or URL is required"),
  vote: z.enum(VOTES),
  repository: repoParam,
  comment: z.string().optional().describe("GitHub review body"),
  confirm,
  approvalToken,
});

export const taskCreateInput = z.strictObject({
  parentId: z.string().trim().min(1, "a PBI/Bug id or URL is required"),
  hours: z.number().min(0).optional().describe("RemainingWork (default: parent Effort or 8)"),
  title: z.string().optional().describe("override the derived task title"),
  confirm,
  approvalToken,
});

export const taskDoneInput = z.strictObject({
  ref: z.string().trim().min(1, "a Task id or URL is required"),
  completedHours: z.number().min(0).optional().describe("default: the task's current RemainingWork"),
  confirm,
  approvalToken,
});

export const pbiStatusInput = z.strictObject({ ref });

export type StatusArgs = z.infer<typeof statusInput>;
export type GetArgs = z.infer<typeof getInput>;
export type QueryArgs = z.infer<typeof queryInput>;
export type CreateArgs = z.infer<typeof createInput>;
export type UpdateArgs = z.infer<typeof updateInput>;
export type ReposArgs = z.infer<typeof reposInput>;
export type PrShowArgs = z.infer<typeof prShowInput>;
export type PrListArgs = z.infer<typeof prListInput>;
export type PrCreateArgs = z.infer<typeof prCreateInput>;
export type PrUpdateArgs = z.infer<typeof prUpdateInput>;
export type PrVoteArgs = z.infer<typeof prVoteInput>;
export type TaskCreateArgs = z.infer<typeof taskCreateInput>;
export type TaskDoneArgs = z.infer<typeof taskDoneInput>;
export type PbiStatusArgs = z.infer<typeof pbiStatusInput>;

// ── tool definitions ───────────────────────────────────────────────────

export interface ToolContract {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  /** "read" or the write-operation class gated by the installation policy. */
  operation: "read" | WriteOperation;
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
  operation: "read" | WriteOperation,
  options: { destructive?: boolean; idempotent?: boolean } = {},
): ToolContract {
  const readOnly = operation === "read";
  return {
    name,
    title,
    description,
    inputSchema,
    operation,
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : options.destructive === true,
      idempotentHint: readOnly ? true : options.idempotent === true,
      openWorldHint: true,
    },
  };
}

const STATUS = defineTool(
  "devwork_status",
  "Tracker installation status",
  "Installation report: which installation this process serves, the repository root it was resolved for, config sources, enabled backends, credential source per backend, allowed projects/repositories, write policy and machine requirements with exact install commands. Call this before blaming routing or credentials.",
  statusInput,
  "read",
);

const GET = defineTool(
  "devwork_get",
  "Get work item",
  "Get one work item by backend id, Jira key (ABC-123), GitHub owner/repo#123, or a work-item URL; GitHub PRs are auto-detected. The target must fall inside the installation scope, checked before any request. Returns a normalized item.",
  getInput,
  "read",
);

const QUERY = defineTool(
  "devwork_query",
  "Query work items",
  "Query work items with structured filters (the server builds WIQL/JQL/GitHub search, so no query syntax is needed): type, state, assignedTo ('me' = authenticated user), contains, changedWithinDays, top. The backend defaults to the installation default; every result stays inside the installation scope.",
  queryInput,
  "read",
);

const CREATE = defineTool(
  "devwork_create",
  "Create work item",
  "Create a work item. Without confirm:true this returns a preview and creates nothing; show it to the user, then re-call with the same arguments plus confirm:true and the preview's approvalToken. ADO takes raw field names, Jira needs a project key, GitHub takes project:'owner/repo'. The target must be inside the installation scope.",
  createInput,
  "create",
);

const UPDATE = defineTool(
  "devwork_update",
  "Update work item",
  "Update a work item. Without confirm:true this returns a preview (current values plus the changes) and changes nothing. Handles the ADO Done-state invariant; Jira state is a transition name; GitHub state is open/closed. The target must be inside the installation scope.",
  updateInput,
  "update",
);

const REPOS = defineTool(
  "devwork_repos",
  "List ADO repositories",
  "List repositories of the configured Azure DevOps project (name, id, default branch). ADO only; the project comes from the installation.",
  reposInput,
  "read",
);

const PR_SHOW = defineTool(
  "devwork_pr_show",
  "Show pull request",
  "Show one pull request by id or URL: status, branches, reviewers with votes, merge status and description. ADO and GitHub.",
  prShowInput,
  "read",
);

const PR_LIST = defineTool(
  "devwork_pr_list",
  "List pull requests",
  "List pull requests (ADO or GitHub): status (active/completed/abandoned/all), repository, creator/reviewer (ADO), source/target branch, top. The repository must be inside the installation scope.",
  prListInput,
  "read",
);

const PR_CREATE = defineTool(
  "devwork_pr_create",
  "Create pull request",
  "Create a pull request. Without confirm:true this returns a preview and creates nothing. ADO appends AB#<id> auto-links; GitHub appends 'Closes #n'. The repository must be inside the installation scope.",
  prCreateInput,
  "pr",
);

const PR_UPDATE = defineTool(
  "devwork_pr_update",
  "Update pull request",
  "Update a pull request: title, description, status (active/abandoned/completed). On GitHub, status:completed MERGES the pull request (squash) — the preview names the merge explicitly and it is gated as a separate operation. Without confirm:true nothing changes.",
  prUpdateInput,
  "pr",
  { destructive: true },
);

const PR_VOTE = defineTool(
  "devwork_pr_vote",
  "Vote on pull request",
  "Vote on a pull request: approve, approve-with-suggestions, no-vote, wait-for-author, reject. ADO records a reviewer vote as the authenticated user; GitHub submits a review (approve / request-changes / comment). Without confirm:true nothing is sent.",
  prVoteInput,
  "vote",
);

const TASK_CREATE = defineTool(
  "devwork_task_create",
  "Create child Task under a PBI/Bug",
  "ADO: create a child 'Implement' Task under a parent PBI/Bug. Derives the title (parent '[Component] X' → 'Implement X'), iteration, assignee, Activity=Development, State=In Progress and RemainingWork (parent Effort or 8h). The preview lists existing child Tasks to avoid duplicates. Without confirm:true nothing is created.",
  taskCreateInput,
  "create",
);

const TASK_DONE = defineTool(
  "devwork_task_done",
  "Mark a Task Done",
  "ADO: mark a Task Done. Sets CompletedWork (default: the task's current RemainingWork) and State=Done, and never sends RemainingWork together with Done (ADO rejects that combination). Without confirm:true nothing changes.",
  taskDoneInput,
  "update",
);

const PBI_STATUS = defineTool(
  "devwork_pbi_status",
  "PBI/Bug status with child tasks",
  "ADO: show a PBI/Bug with all child Tasks (state, remaining/completed work) — a sprint board snapshot for one item.",
  pbiStatusInput,
  "read",
);

export const TOOLS: readonly ToolContract[] = [
  STATUS,
  GET,
  QUERY,
  CREATE,
  UPDATE,
  REPOS,
  PR_SHOW,
  PR_LIST,
  PR_CREATE,
  PR_UPDATE,
  PR_VOTE,
  TASK_CREATE,
  TASK_DONE,
  PBI_STATUS,
];

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function toolByName(name: string): ToolContract | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Write operations the plan knows about, re-exported so tests and the policy
 *  loader agree on one list. */
export const KNOWN_WRITE_OPERATIONS = WRITE_OPERATIONS;
