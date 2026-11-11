/**
 * Shared shapes plus the response envelope. The envelope is declared once in
 * contract.ts (it is part of the MCP contract); this module owns the domain
 * types the providers and renderers exchange.
 */

export type Backend = "ado" | "jira" | "github";

export interface ToolResult {
  /** The MCP host may attach its own fields; keep the envelope open. */
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

export function text(body: string, isErr = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isErr ? { isError: true } : {}) };
}

export function result(body: string, structured: Record<string, unknown>, isErr = false): ToolResult {
  return {
    content: [{ type: "text", text: body }],
    structuredContent: { ok: !isErr, ...structured },
    ...(isErr ? { isError: true } : {}),
  };
}

export interface WorkItemChild {
  id: string;
  type?: string | undefined;
  title?: string | undefined;
  state?: string | undefined;
  assignedTo?: string | undefined;
  remaining?: string | undefined;
  completed?: string | undefined;
}

export interface WorkItem {
  backend: Backend;
  id: string;
  key?: string | undefined;
  url?: string | undefined;
  type?: string | undefined;
  title?: string | undefined;
  state?: string | undefined;
  assignedTo?: string | undefined;
  createdBy?: string | undefined;
  created?: string | undefined;
  changed?: string | undefined;
  area?: string | undefined;
  iteration?: string | undefined;
  priority?: string | undefined;
  tags?: string[] | undefined;
  description?: string | undefined;
  acceptanceCriteria?: string | undefined;
  commentCount?: number | undefined;
  rev?: number | undefined;
  remaining?: string | undefined;
  completed?: string | undefined;
  parent?: { id: string; type?: string | undefined; title?: string | undefined } | undefined;
  children?: WorkItemChild[] | undefined;
  effort?: string | undefined;
}

export interface Reviewer {
  name: string;
  email?: string | undefined;
  vote?: string | undefined;
  required?: boolean | undefined;
}

export interface PullRequest {
  id: string;
  url?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  isDraft?: boolean | undefined;
  source?: string | undefined;
  target?: string | undefined;
  createdBy?: string | undefined;
  created?: string | undefined;
  mergeStatus?: string | undefined;
  autoComplete?: boolean | undefined;
  description?: string | undefined;
  reviewers?: Reviewer[] | undefined;
  repository?: string | undefined;
  /** Head revision, when the backend exposes one; used to detect a stale write. */
  headSha?: string | undefined;
}

/** Structured query filters — the server builds WIQL/JQL/GitHub search, so the
 *  caller never has to know backend syntax. */
export interface QueryFilters {
  type?: string | undefined;
  state?: string | undefined;
  /** Display name/email, or "me"/"@me" for the authenticated user. */
  assignedTo?: string | undefined;
  /** Substring in title or description. */
  contains?: string | undefined;
  changedWithinDays?: number | undefined;
  top?: number | undefined;
}

/** Write operation classes; each one is gated by the installation policy. */
export const WRITE_OPERATIONS = ["create", "update", "comment", "pr", "vote", "merge"] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
