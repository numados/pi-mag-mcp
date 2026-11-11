/** Single owner of the knowledge-mcp tool surface: the nine tool names,
 *  titles, descriptions (verbatim from the source server — they are
 *  user-visible and quoted by the knowledge-vault skill), input schemas, the
 *  shared limits and the annotations. `server.ts` registers only what is
 *  declared here; the contract test asserts the surface against the source
 *  texts.
 *
 *  Schema policy, inherited from the source: plain `z.object` — unknown keys
 *  are stripped, never rejected, so an agent passing an extra field keeps
 *  working; `limit`/`maxChars` are clamped in code (they were never rejected
 *  by the source either). `vault` is a string everywhere except
 *  `knowledge_search`, where it also accepts an array of source names.
 *  There is no output schema — the text is the contract (D-K4). */

import { z } from "zod";

// ── shared limits (single owner; handlers clamp, never reject) ─────────────

export const LIMITS = {
  /** Default and hard cap for search/task limits (the source clamped too). */
  limitDefault: 20,
  limitMax: 100,
  /** Default body budget for knowledge_read. */
  maxCharsDefault: 6_000,
} as const;

// ── vocabulary (the accepted values are part of the surface) ──────────────

export const SEARCH_MODES = ["hybrid", "lexical", "graph"] as const;
export const WRITE_OPS = ["create", "update", "retire", "supersede"] as const;
export const READ_PARTS = ["meta", "outline", "body", "section"] as const;
export const LINK_DIRECTIONS = ["out", "back", "both"] as const;
export const STRUCTURE_ACTIONS = ["inventory", "conventions"] as const;
export const TASK_ACTIONS = ["status", "init", "iteration", "update"] as const;
export const TASK_STAGES = ["brainstorm", "gap-drill", "planning", "implementation", "review"] as const;
/** Task lifecycle states (independent of the event outcome). */
export const TASK_STATUSES = ["brainstorm", "planning", "implementing", "reviewing", "blocked", "done"] as const;
/** Event outcomes; only blocked/done affect the lifecycle. */
export const EVENT_STATUSES = ["active", "ready", "blocked", "done"] as const;

// ── annotations ───────────────────────────────────────────────────────────

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const readOnly = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const writing = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});

const taskTracking = (title: string): ToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

// ── input schemas ─────────────────────────────────────────────────────────

const vaultProperty = z.string().optional();

export const knowledgeSearchInputSchema = z.object({
  query: z.string().describe("search text (words, title, or note name)"),
  mode: z.enum(SEARCH_MODES).optional().describe("default hybrid"),
  scope: z.string().optional().describe("vault-relative dir to limit search (e.g. Knowledge)"),
  limit: z.number().optional().describe("max hits (default 20, cap 100)"),
  vault: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("vault name or names (else project map / default)"),
});

export const knowledgeReadInputSchema = z.object({
  path: z.string().describe("vault-relative path or unique note name"),
  part: z.enum(READ_PARTS).optional().describe("default meta"),
  section: z.string().optional().describe("heading text for part=section"),
  maxChars: z.number().optional().describe("body budget (default 6000)"),
  vault: vaultProperty,
});

export const knowledgeLinksInputSchema = z.object({
  path: z.string(),
  direction: z.enum(LINK_DIRECTIONS).optional().describe("default both"),
  vault: vaultProperty,
});

export const knowledgeStructureInputSchema = z.object({
  action: z.enum(STRUCTURE_ACTIONS).optional().describe("default inventory"),
  scope: z.string().optional().describe("vault-relative dir (conventions: default knowledgeRoot or vault root)"),
  vault: vaultProperty,
});

export const knowledgeWriteInputSchema = z.object({
  op: z.enum(WRITE_OPS).optional().describe("default create"),
  target: z.string().describe("vault-relative path ('dir/' + title → filename) or existing note"),
  title: z.string().optional(),
  frontmatter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("create: initial props; update: patch (null value deletes key)"),
  body: z.string().optional().describe("note body (without frontmatter fences)"),
  content: z.string().optional().describe("full raw note incl frontmatter (create/update)"),
  superseded_by: z.string().optional().describe("op=supersede: note that replaces target"),
  reason: z.string().optional().describe("one-line provenance for the change"),
  confirm: z.boolean().optional().describe("true = execute the previewed change"),
  vault: vaultProperty,
});

export const knowledgeMoveInputSchema = z.object({
  from: z.string().describe("existing note (path or unique name)"),
  to: z.string().describe("vault-relative new path"),
  updateLinks: z.boolean().optional().describe("rewrite [[links]] everywhere (default true)"),
  confirm: z.boolean().optional(),
  vault: vaultProperty,
});

export const knowledgeTaskInputSchema = z.object({
  action: z.enum(TASK_ACTIONS).optional().describe("default status"),
  ticket: z.string().describe("stable task id (e.g. ABC-123 or a slug)"),
  title: z.string().optional().describe("init: human title"),
  repos: z
    .array(z.string())
    .optional()
    .describe("init/update: repo names or paths touched by the task (knowledge-network link)"),
  stage: z.enum(TASK_STAGES).optional().describe("iteration: workflow stage; also infers task lifecycle"),
  status: z
    .enum(EVENT_STATUSES)
    .optional()
    .describe(
      "event outcome (default active); legacy init/update accepted. Only blocked/done affect task lifecycle.",
    ),
  taskStatus: z
    .enum(TASK_STATUSES)
    .optional()
    .describe(
      "init/iteration/update: task lifecycle override; otherwise inferred from stage or blocked/done outcome, never active/ready",
    ),
  phase: z
    .string()
    .nullable()
    .optional()
    .describe("init/iteration/update: current_phase; iteration filename suffix, e.g. p1 → 0003-implementation-p1.md"),
  intent: z.string().optional().describe("iteration: what this step set out to do"),
  verified: z.string().optional().describe("iteration: verified state / evidence"),
  changes: z.string().optional().describe("iteration: what changed (notes, files, commits)"),
  verification: z.string().optional().describe("iteration: how the change was verified"),
  handoff: z.string().optional().describe("iteration: next action / open blocker"),
  next: z.string().optional().describe("update: next action line"),
  blocker: z.string().optional().describe("update: current blocker line"),
  taskRoot: z
    .string()
    .optional()
    .describe("vault-relative task workspace root (else .knowledge-mcp.json / config defaultTaskRoot)"),
  confirm: z.boolean().optional(),
  vault: vaultProperty,
});

export const knowledgeRepoInputSchema = z.object({
  repo: z.string().optional().describe("repo name (else .knowledge-mcp.json repo.name, else cwd basename)"),
  limit: z.number().optional().describe("max tasks (default 20)"),
  vault: vaultProperty,
});

// ── the surface ───────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "knowledge_status",
    title: "Knowledge status",
    description:
      "Vault routing table, per-vault readiness (notes count, git, qmd), write gate, config sources. Run first when blaming routing or setup.",
    inputSchema: z.object({}),
    annotations: readOnly("Knowledge status"),
  },
  {
    name: "knowledge_search",
    title: "Knowledge search",
    description:
      "Search the knowledge vault. Use FIRST for past-work/task-history/domain questions (task indexes and research notes live there). Modes: hybrid (qmd BM25→rg, default), lexical (rg with context), graph (find a note, then one-hop links+backlinks).",
    inputSchema: knowledgeSearchInputSchema,
    annotations: readOnly("Knowledge search"),
  },
  {
    name: "knowledge_read",
    title: "Knowledge read",
    description:
      "Read a note bounded: part=meta (frontmatter+outline+summary) | outline | body | section (pass section name). Cites the vault-relative path.",
    inputSchema: knowledgeReadInputSchema,
    annotations: readOnly("Knowledge read"),
  },
  {
    name: "knowledge_links",
    title: "Knowledge links",
    description: "Outgoing wikilinks (with resolution) and backlinks of a note. One hop — the graph primitive.",
    inputSchema: knowledgeLinksInputSchema,
    annotations: readOnly("Knowledge links"),
  },
  {
    name: "knowledge_structure",
    title: "Knowledge structure",
    description:
      'action=inventory: per-folder note counts, frontmatter coverage, git/qmd state. action=conventions: detected format of a scope (naming, frontmatter keys, link style) — the answer to "what format to write in here".',
    inputSchema: knowledgeStructureInputSchema,
    annotations: readOnly("Knowledge structure"),
  },
  {
    name: "knowledge_write",
    title: "Knowledge write",
    description:
      "Write a note — two-phase: without confirm:true returns a preview (rendered note / diff + warnings: duplicates, unresolved links, conventions, secrets); with confirm:true executes and re-validates. ops: create | update (body/content/frontmatter patch) | retire (status marker) | supersede (redirect). Never deletes.",
    inputSchema: knowledgeWriteInputSchema,
    annotations: writing("Knowledge write"),
  },
  {
    name: "knowledge_move",
    title: "Knowledge move",
    description:
      "Rename/move a note with wikilink rewriting across the vault. Two-phase: preview lists affected files; confirm:true executes. Obsidian app is not required.",
    inputSchema: knowledgeMoveInputSchema,
    annotations: writing("Knowledge move"),
  },
  {
    name: "knowledge_task",
    title: "Task tracking",
    description:
      "Repo task workspace protocol (numados-task-*): _task_index.md + immutable iterations/. Actions: status (recover latest state fast — read this FIRST when resuming a task), init (create workspace), iteration (append ONE event per meaningful workflow step: stage/status/intent/verified/changes/verification/handoff — this is what a small agent calls during brainstorm/implementation), update (index projection fields). Writes are two-phase (confirm:true executes). Task notes live in the CENTRAL vault under taskRoot (per-repo .knowledge-mcp.json declares it).",
    inputSchema: knowledgeTaskInputSchema,
    annotations: taskTracking("Task tracking"),
  },
  {
    name: "knowledge_repo",
    title: "Repo knowledge map",
    description:
      "Knowledge network around a repository: task workspaces whose index lists the repo (progress history), concept notes mentioning/linking it, repo-index catalog entry if present. Answers 'what do we know about this repo / what happened here'.",
    inputSchema: knowledgeRepoInputSchema,
    annotations: readOnly("Repo knowledge map"),
  },
];

export type SearchArgs = z.infer<typeof knowledgeSearchInputSchema>;
export type ReadArgs = z.infer<typeof knowledgeReadInputSchema>;
export type LinksArgs = z.infer<typeof knowledgeLinksInputSchema>;
export type StructureArgs = z.infer<typeof knowledgeStructureInputSchema>;
export type WriteArgs = z.infer<typeof knowledgeWriteInputSchema>;
export type MoveArgs = z.infer<typeof knowledgeMoveInputSchema>;
export type TaskArgs = z.infer<typeof knowledgeTaskInputSchema>;
export type RepoArgs = z.infer<typeof knowledgeRepoInputSchema>;

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
