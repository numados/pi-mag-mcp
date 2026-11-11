/**
 * Jira Cloud backend — REST v3 with basic auth (email + API token). Both come
 * from the installation profile, resolved by credentials.ts; there is no
 * ambient Jira login and no legacy credential file.
 *
 * Minimal surface mirroring the ADO backend: get / query / create / update /
 * comment / transition. Assignees are resolved by email through the user search.
 */
import type { JiraCredential } from "./credentials.js";
import { safeBody } from "./redact.js";
import type { QueryFilters, WorkItem } from "./types.js";

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Plain text → Atlassian Document Format (paragraphs split on blank lines). */
export function plainToAdf(body: string): Record<string, unknown> {
  const paragraphs = body.split(/\n{2,}/).map((paragraph) => ({
    type: "paragraph",
    content: [{ type: "text", text: paragraph }],
  }));
  return { type: "doc", version: 1, content: paragraphs };
}

export function adfToPlain(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const object = node as Record<string, unknown>;
  let out = "";
  if (object.type === "text" && typeof object.text === "string") out += object.text;
  if (Array.isArray(object.content)) {
    for (const child of object.content) out += (child === object.content[0] ? "" : "\n") + adfToPlain(child).trimStart();
  }
  return out;
}

type JiraFields = Record<string, unknown>;

export function normalizeIssue(raw: Record<string, unknown>, domain?: string): WorkItem {
  const fields = (raw.fields ?? {}) as JiraFields;
  const key = String(raw.key ?? raw.id ?? "");
  const parent = fields.parent as { key?: string; fields?: { issuetype?: { name?: string }; summary?: string } } | undefined;
  const issueType = fields.issuetype as { name?: string } | undefined;
  const status = fields.status as { name?: string } | undefined;
  const assignee = fields.assignee as { displayName?: string; emailAddress?: string } | undefined;
  const reporter = fields.reporter as { displayName?: string } | undefined;
  const priority = fields.priority as { name?: string } | undefined;
  const project = fields.project as { key?: string } | undefined;
  const comment = fields.comment as { total?: number } | undefined;
  const subtasks = Array.isArray(fields.subtasks) ? (fields.subtasks as Array<Record<string, unknown>>) : [];
  return compact({
    backend: "jira" as const,
    id: key,
    key,
    url: domain ? `${domain}/browse/${key}` : undefined,
    type: issueType?.name,
    title: fields.summary as string | undefined,
    state: status?.name,
    assignedTo: assignee?.displayName ?? assignee?.emailAddress,
    createdBy: reporter?.displayName,
    created: fields.created as string | undefined,
    changed: fields.updated as string | undefined,
    area: project?.key,
    priority: priority?.name,
    tags: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
    description: fields.description ? adfToPlain(fields.description).trim() || undefined : undefined,
    commentCount: comment?.total,
    parent: parent
      ? compact({ id: String(parent.key ?? ""), type: parent.fields?.issuetype?.name, title: parent.fields?.summary })
      : undefined,
    children:
      subtasks.length > 0
        ? subtasks.map((subtask) => {
            const f = (subtask.fields ?? {}) as JiraFields;
            return compact({
              id: String(subtask.key ?? ""),
              type: (f.issuetype as { name?: string } | undefined)?.name,
              title: f.summary as string | undefined,
              state: (f.status as { name?: string } | undefined)?.name,
            });
          })
        : undefined,
  });
}

const ISSUE_FIELDS =
  "summary,description,status,assignee,reporter,created,updated,issuetype,priority,labels,parent,subtasks,comment,fixVersions";

export interface JiraCreateArgs {
  project: string;
  type: string;
  title: string;
  description?: string;
  assignedTo?: string;
  comment?: string;
}

export interface JiraUpdateArgs {
  key: string;
  title?: string;
  description?: string;
  state?: string;
  assignedTo?: string;
  comment?: string;
}

export class JiraClient {
  constructor(
    private readonly credential: () => JiraCredential,
    private readonly timeoutMs: number,
  ) {}

  private auth(): JiraCredential {
    const credential = this.credential();
    if (!credential.domain || !credential.email || !credential.token) {
      throw new Error(`Jira backend has no usable credential.\n${credential.notes.join("\n")}`);
    }
    return credential;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const credential = this.auth();
    const authorization = "Basic " + Buffer.from(`${credential.email}:${credential.token}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${credential.domain}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Jira ${response.status} ${path}: ${safeBody(body, 500, [credential.token])}`);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getIssue(key: string): Promise<WorkItem> {
    const raw = await this.request<Record<string, unknown>>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    );
    return normalizeIssue(raw, this.auth().domain);
  }

  async searchIssues(q: QueryFilters, top: number, projects: string[] = []): Promise<WorkItem[]> {
    const body = JSON.stringify({
      jql: buildJql(q, projects),
      maxResults: Math.max(1, q.top ?? top),
      fields: ["summary", "status", "issuetype", "assignee", "updated", "priority"],
    });
    let rows: Array<Record<string, unknown>> | undefined;
    try {
      const response = await this.request<{ issues?: Array<Record<string, unknown>> }>("/rest/api/3/search/jql", {
        method: "POST",
        body,
      });
      rows = response.issues;
    } catch (error) {
      if (!/Jira (404|410)/.test(String((error as Error).message))) throw error;
      const response = await this.request<{ issues?: Array<Record<string, unknown>> }>("/rest/api/3/search", {
        method: "POST",
        body,
      });
      rows = response.issues;
    }
    return (rows ?? []).map((row) => normalizeIssue(row, this.auth().domain));
  }

  async createIssue(args: JiraCreateArgs): Promise<WorkItem> {
    const fields: Record<string, unknown> = {
      project: { key: args.project },
      issuetype: { name: args.type },
      summary: args.title,
    };
    if (args.description) fields.description = plainToAdf(args.description);
    if (args.assignedTo) {
      const accountId = await this.findAccountId(args.assignedTo);
      if (accountId) fields.assignee = { accountId };
    }
    const raw = await this.request<Record<string, unknown>>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    const key = String(raw.key ?? "");
    if (args.comment) await this.addComment(key, args.comment);
    return this.getIssue(key);
  }

  async updateIssue(args: JiraUpdateArgs): Promise<WorkItem> {
    const fields: Record<string, unknown> = {};
    if (args.title) fields.summary = args.title;
    if (args.description) fields.description = plainToAdf(args.description);
    if (args.assignedTo) {
      const accountId = await this.findAccountId(args.assignedTo);
      if (accountId) fields.assignee = { accountId };
    }
    if (Object.keys(fields).length > 0) {
      await this.request(`/rest/api/3/issue/${encodeURIComponent(args.key)}`, {
        method: "PUT",
        body: JSON.stringify({ fields }),
      });
    }
    if (args.state) {
      const transitions = await this.request<{ transitions?: Array<{ id: string; name: string }> }>(
        `/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`,
      );
      const wanted = args.state.toLowerCase();
      const match = transitions.transitions?.find((t) => t.name.toLowerCase() === wanted);
      if (!match) {
        throw new Error(
          `transition "${args.state}" not found (available: ${(transitions.transitions ?? []).map((t) => t.name).join(", ")})`,
        );
      }
      await this.request(`/rest/api/3/issue/${encodeURIComponent(args.key)}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: match.id } }),
      });
    }
    if (args.comment) await this.addComment(args.key, args.comment);
    return this.getIssue(args.key);
  }

  async addComment(key: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: plainToAdf(body) }),
    });
  }

  private async findAccountId(query: string): Promise<string | null> {
    const users = await this.request<Array<{ accountId?: string }>>(
      `/rest/api/3/user/search?query=${encodeURIComponent(query)}`,
    );
    return users[0]?.accountId ?? null;
  }
}

export function buildJql(q: QueryFilters, projects: string[] = []): string {
  const where: string[] = [];
  const clean = (value: string): string => value.replace(/"/g, "");
  // The installation scope is part of every query: a filter cannot widen it.
  if (projects.length > 0) where.push(`project in (${projects.map((project) => `"${clean(project)}"`).join(", ")})`);
  if (q.type) where.push(`issuetype = "${clean(q.type)}"`);
  if (q.state) where.push(`status = "${clean(q.state)}"`);
  if (q.assignedTo) {
    where.push(/^(me|@me)$/i.test(q.assignedTo) ? "assignee = currentUser()" : `assignee = "${clean(q.assignedTo)}"`);
  }
  if (q.contains) where.push(`text ~ "${clean(q.contains)}"`);
  if (q.changedWithinDays && q.changedWithinDays > 0) where.push(`updated >= -${Math.floor(q.changedWithinDays)}d`);
  return `${where.join(" AND ")} ORDER BY updated DESC`.trim();
}
