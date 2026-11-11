/**
 * Azure DevOps backend — REST v7.1. The credential (PAT, or an `az` CLI login
 * when the installation opts into ambient auth) is chosen by credentials.ts;
 * this module never looks at the environment.
 *
 * Invariants encoded here:
 *  - State=Done must not carry RemainingWork (ADO rejects that combination).
 *  - PR creation appends AB#<id> lines to auto-link work items.
 *  - Votes are identity-based: the authenticated user votes on itself.
 */
import { cacheGet, cachePut, invalidate } from "./cache.js";
import { safeBody } from "./redact.js";
import type { AdoCredential } from "./credentials.js";
import type { AdoSettings } from "./installation.js";
import type { PullRequest, QueryFilters, WorkItem, WorkItemChild } from "./types.js";

const API_VERSION = "7.1";

export const AZ_INSTALL_HINT =
  "Give the installation a PAT (ado.pat: \"env:<VARIABLE>\", scope Work Items R&W + Code R&W) " +
  "or set ado.auth:\"ambient\" to use an `az` CLI login " +
  "(brew install azure-cli && az extension add --name azure-devops && az login --allow-no-subscriptions)";

type Fields = Record<string, unknown>;
type PatchOp = { op: "add" | "replace" | "remove"; path: string; value?: unknown };
type RawWi = { id: number; fields?: Fields; rev?: number; relations?: Array<{ rel: string; url: string }> };

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function identity(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const name = (object.uniqueName ?? object.displayName) as string | undefined;
  return name || undefined;
}

function stringField(fields: Fields, name: string): string | undefined {
  const value = fields[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

export function normalizeItem(raw: RawWi, settings: AdoSettings, project?: string): WorkItem {
  const fields = raw.fields ?? {};
  const description = fields["System.Description"];
  const acceptance = fields["Microsoft.VSTS.Common.AcceptanceCriteria"];
  return compact({
    backend: "ado" as const,
    id: String(raw.id),
    url: workItemUrl(settings, String(raw.id), project),
    type: stringField(fields, "System.WorkItemType"),
    title: stringField(fields, "System.Title"),
    state: stringField(fields, "System.State"),
    assignedTo: identity(fields["System.AssignedTo"]),
    createdBy: identity(fields["System.CreatedBy"]),
    created: stringField(fields, "System.CreatedDate"),
    changed: stringField(fields, "System.ChangedDate"),
    area: stringField(fields, "System.AreaPath"),
    iteration: stringField(fields, "System.IterationPath"),
    priority: stringField(fields, "Microsoft.VSTS.Common.Priority"),
    tags: (stringField(fields, "System.Tags") ?? "")
      .split(";")
      .map((tag) => tag.trim())
      .filter(Boolean),
    commentCount: typeof fields["System.CommentCount"] === "number" ? (fields["System.CommentCount"] as number) : undefined,
    rev: raw.rev,
    remaining: stringField(fields, "Microsoft.VSTS.Scheduling.RemainingWork"),
    completed: stringField(fields, "Microsoft.VSTS.Scheduling.CompletedWork"),
    effort: stringField(fields, "Microsoft.VSTS.Scheduling.Effort"),
    description: typeof description === "string" && description ? description : undefined,
    acceptanceCriteria: typeof acceptance === "string" && acceptance ? acceptance : undefined,
  });
}

function base(settings: AdoSettings): string {
  return (settings.org ?? "").replace(/\/+$/, "");
}

function workItemUrl(settings: AdoSettings, id: string, project?: string): string | undefined {
  if (!settings.org) return undefined;
  const selected = project ?? settings.project;
  return selected
    ? `${base(settings)}/${encodeURIComponent(selected)}/_workitems/edit/${id}`
    : `${base(settings)}/_workitems/edit/${id}`;
}

export function normalizePr(raw: Record<string, unknown>, settings: AdoSettings, project?: string): PullRequest {
  const reviewers = Array.isArray(raw.reviewers)
    ? (raw.reviewers as Array<Record<string, unknown>>).map((reviewer) =>
        compact({
          name: String(reviewer.displayName ?? "?"),
          email: reviewer.uniqueName as string | undefined,
          vote:
            reviewer.vote === 10
              ? "approve"
              : reviewer.vote === 5
                ? "approve-with-suggestions"
                : reviewer.vote === -5
                  ? "wait-for-author"
                  : reviewer.vote === -10
                    ? "reject"
                    : "no-vote",
          required: Boolean(reviewer.isRequired),
        }),
      )
    : undefined;
  const repository = raw.repository as { name?: string; webUrl?: string } | undefined;
  const id = String(raw.pullRequestId ?? "");
  return compact({
    id,
    url: repository?.webUrl
      ? `${repository.webUrl}/pullrequest/${id}`
      : project
        ? `${base(settings)}/${encodeURIComponent(project)}/_git/${repository?.name ?? "repo"}/pullrequest/${id}`
        : undefined,
    title: raw.title as string | undefined,
    status: raw.status as string | undefined,
    isDraft: Boolean(raw.isDraft),
    source: raw.sourceRefName as string | undefined,
    target: raw.targetRefName as string | undefined,
    createdBy: identity(raw.createdBy),
    created: raw.creationDate as string | undefined,
    mergeStatus: raw.mergeStatus as string | undefined,
    autoComplete: Boolean(raw.autoCompleteSetBy),
    description: raw.description as string | undefined,
    reviewers,
    repository: repository?.name,
    headSha: (raw.lastMergeSourceCommit as { commitId?: string } | undefined)?.commitId,
  });
}

export function buildWiql(q: QueryFilters): string {
  const escape = (value: string): string => value.replace(/'/g, "''");
  const where: string[] = [];
  if (q.type) where.push(`[System.WorkItemType] = '${escape(q.type)}'`);
  if (q.state) where.push(`[System.State] = '${escape(q.state)}'`);
  if (q.assignedTo) {
    const who = /^(me|@me)$/i.test(q.assignedTo) ? "@me" : `'${escape(q.assignedTo)}'`;
    where.push(`[System.AssignedTo] = ${who}`);
  }
  if (q.contains) {
    const needle = escape(q.contains);
    where.push(`([System.Title] CONTAINS '${needle}' OR [System.Description] CONTAINS '${needle}')`);
  }
  if (q.changedWithinDays && q.changedWithinDays > 0) {
    const since = new Date(Date.now() - q.changedWithinDays * 86_400_000).toISOString().slice(0, 10);
    where.push(`[System.ChangedDate] >= '${since}'`);
  }
  return `SELECT [System.Id] FROM WorkItems ${where.length > 0 ? "WHERE " + where.join(" AND ") + " " : ""}ORDER BY [System.ChangedDate] DESC`;
}

/** ADO rejects RemainingWork together with State=Done. */
export function sanitizeDoneUpdate(args: AdoUpdateArgs): AdoUpdateArgs {
  if (args.state && /^done$/i.test(args.state)) {
    const fields = { ...(args.fields ?? {}) };
    delete fields["Microsoft.VSTS.Scheduling.RemainingWork"];
    return { ...args, fields };
  }
  return args;
}

function branchRef(name: string): string {
  return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}

export interface AdoCreateArgs {
  type: string;
  title: string;
  description?: string;
  assignedTo?: string;
  area?: string;
  iteration?: string;
  state?: string;
  comment?: string;
  fields?: Record<string, string>;
  project?: string;
  /** Work item the new item becomes a child of (Hierarchy-Reverse relation). */
  parentId?: string;
}

export interface AdoUpdateArgs {
  id: string;
  title?: string;
  state?: string;
  reason?: string;
  assignedTo?: string;
  description?: string;
  comment?: string;
  area?: string;
  iteration?: string;
  fields?: Record<string, string>;
  project?: string;
}

export interface AdoPrListArgs {
  status?: string;
  repository?: string;
  creator?: string;
  reviewer?: string;
  top?: number;
  sourceBranch?: string;
  targetBranch?: string;
}

export interface AdoPrCreateArgs {
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  draft?: boolean;
  autoComplete?: boolean;
  deleteSourceBranch?: boolean;
  reviewers?: string[];
  linkWorkItems?: number[];
}

export interface AdoPrUpdateArgs {
  id: string;
  repository?: string;
  title?: string;
  description?: string;
  status?: string;
  autoComplete?: boolean;
  draft?: boolean;
  /** Head commit the preview was computed against; a completed transition is
   *  refused when the source branch moved since then. */
  expectedHeadSha?: string;
}

/** The create patch is a pure function so the parent relation and the Done
 *  invariants are testable without HTTP. */
export function buildCreatePatch(args: AdoCreateArgs, settings: AdoSettings): PatchOp[] {
  const patch: PatchOp[] = [{ op: "add", path: "/fields/System.Title", value: args.title }];
  if (args.description) patch.push({ op: "add", path: "/fields/System.Description", value: args.description });
  if (args.state) patch.push({ op: "add", path: "/fields/System.State", value: args.state });
  if (args.area) patch.push({ op: "add", path: "/fields/System.AreaPath", value: args.area });
  if (args.iteration) patch.push({ op: "add", path: "/fields/System.IterationPath", value: args.iteration });
  if (args.assignedTo) patch.push({ op: "add", path: "/fields/System.AssignedTo", value: args.assignedTo });
  for (const [key, value] of Object.entries(args.fields ?? {})) patch.push({ op: "add", path: `/fields/${key}`, value });
  if (args.parentId) {
    // Without this relation the "child" Task is a loose work item: the parent's
    // children list and the sprint board would not show it.
    const project = encodeURIComponent(args.project ?? settings.project ?? "");
    patch.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `${base(settings)}/${project}/_apis/wit/workItems/${args.parentId}`,
      },
    });
  }
  return patch;
}

const VOTE_NUMBER: Record<string, number> = {
  approve: 10,
  "approve-with-suggestions": 5,
  "no-vote": 0,
  "wait-for-author": -5,
  reject: -10,
};

const VOTE_LABEL: Record<string, string> = {
  approve: "✅ Approve",
  "approve-with-suggestions": "👍 Approve w/ suggestions",
  "no-vote": "⏳ No vote",
  "wait-for-author": "👎 Wait for author",
  reject: "❌ Reject",
};

export class AdoClient {
  constructor(
    private readonly installationId: string,
    private readonly settings: AdoSettings,
    private readonly credential: () => Promise<AdoCredential>,
  ) {}

  private async request<T>(path: string, init?: RequestInit & { patch?: unknown }): Promise<T> {
    const credential = await this.credential();
    if (!credential.header) throw new Error(`Azure DevOps backend has no usable credential.\n${AZ_INSTALL_HINT}`);
    if (!this.settings.org) throw new Error("Azure DevOps backend has no organization configured (ado.org)");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.requestTimeoutMs);
    try {
      const method = init?.method ?? "GET";
      const isPatch = init?.patch !== undefined;
      const body = isPatch ? JSON.stringify(init?.patch) : init?.body;
      const response = await fetch(`${base(this.settings)}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: credential.header,
          Accept: "application/json",
          "Content-Type": isPatch ? "application/json-patch+json" : "application/json",
        },
        ...(body !== undefined && body !== null ? { body: body as BodyInit } : {}),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`ADO ${response.status} ${method} ${path}: ${safeBody(text, 500, [credential.header])}`);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private orgPath(path: string): string {
    return `/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
  }

  private projPath(project: string | undefined, path: string): string {
    const selected = encodeURIComponent(project ?? this.settings.project ?? "");
    return `/${selected}/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
  }

  async selfId(): Promise<string> {
    const data = await this.request<{ authenticatedUser?: { id?: string } }>(this.orgPath("connectionData"));
    if (!data.authenticatedUser?.id) throw new Error("cannot resolve the authenticated ADO user (connectionData)");
    return data.authenticatedUser.id;
  }

  /** Authenticated principal, for the status report. Never a secret. */
  async whoami(): Promise<string | null> {
    try {
      const data = await this.request<{ authenticatedUser?: { providerDisplayName?: string; properties?: Record<string, unknown> } }>(
        this.orgPath("connectionData"),
      );
      const account = data.authenticatedUser?.properties?.["Account"] as { $value?: string } | undefined;
      return account?.$value ?? data.authenticatedUser?.providerDisplayName ?? null;
    } catch {
      return null;
    }
  }

  private async resolveEmail(email: string): Promise<string | null> {
    try {
      const response = await this.request<{ value?: Array<{ id: string }> }>(
        this.orgPath(`identities?searchFilter=MailAddress&filterValue=${encodeURIComponent(email)}`),
      );
      return response.value?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  async getWorkItem(id: string, options: { refresh?: boolean; cacheTtlSeconds: number; project?: string }): Promise<WorkItem> {
    const cacheKey = `item:${options.project ?? this.settings.project ?? ""}:${id}`;
    if (!options.refresh) {
      const hit = cacheGet<WorkItem>(this.installationId, cacheKey, options.cacheTtlSeconds);
      if (hit) return hit;
    }
    const raw = await this.request<RawWi>(this.projPath(options.project, `wit/workitems/${id}?$expand=all`));
    const item = normalizeItem(raw, this.settings, options.project);
    const relations = relationIds(raw);
    if (relations.children.length > 0) {
      const children = await this.fetchSummaries(relations.children, options.project);
      if (children) item.children = children;
    }
    if (relations.parent) {
      try {
        const parent = await this.getWorkItem(relations.parent, { ...options, refresh: false });
        item.parent = compact({ id: parent.id, type: parent.type, title: parent.title });
      } catch {
        /* the parent may be inaccessible; not fatal */
      }
    }
    cachePut(this.installationId, cacheKey, item);
    return item;
  }

  private async fetchSummaries(ids: string[], project?: string): Promise<WorkItemChild[] | null> {
    try {
      const response = await this.request<{ value?: RawWi[] }>(this.projPath(project, "wit/workitemsbatch"), {
        method: "POST",
        body: JSON.stringify({ ids: ids.map(Number).slice(0, 200), $expand: "fields" }),
      });
      if (!response.value) return null;
      return response.value.map((workItem) => {
        const fields = workItem.fields ?? {};
        return compact({
          id: String(workItem.id),
          type: stringField(fields, "System.WorkItemType"),
          title: stringField(fields, "System.Title"),
          state: stringField(fields, "System.State"),
          assignedTo: identity(fields["System.AssignedTo"]),
          remaining: stringField(fields, "Microsoft.VSTS.Scheduling.RemainingWork"),
          completed: stringField(fields, "Microsoft.VSTS.Scheduling.CompletedWork"),
        });
      });
    } catch {
      return null;
    }
  }

  async queryItems(q: QueryFilters, top: number, project?: string): Promise<WorkItem[]> {
    const response = await this.request<{ workItems?: Array<{ id: number }> }>(this.projPath(project, "wit/wiql"), {
      method: "POST",
      body: JSON.stringify({ query: buildWiql(q) }),
    });
    const ids = (response.workItems ?? []).map((entry) => String(entry.id)).slice(0, Math.max(1, q.top ?? top));
    const summaries = await this.fetchSummaries(ids, project);
    if (summaries) {
      return summaries.map((summary) =>
        compact({
          backend: "ado" as const,
          id: summary.id,
          type: summary.type,
          title: summary.title,
          state: summary.state,
          assignedTo: summary.assignedTo,
          remaining: summary.remaining,
          completed: summary.completed,
          url: workItemUrl(this.settings, summary.id, project),
        }),
      );
    }
    const items: WorkItem[] = [];
    for (const id of ids.slice(0, 25)) {
      try {
        items.push(await this.getWorkItem(id, { cacheTtlSeconds: 60, ...(project !== undefined ? { project } : {}) }));
      } catch {
        /* skip an unreadable row */
      }
    }
    return items;
  }

  async createItem(args: AdoCreateArgs): Promise<WorkItem> {
    const patch = buildCreatePatch(args, this.settings);
    const raw = await this.request<RawWi>(this.projPath(args.project, `wit/workitems/$${encodeURIComponent(args.type)}`), {
      method: "POST",
      patch,
    });
    const item = normalizeItem(raw, this.settings, args.project);
    if (args.comment) await this.addComment(item.id, args.comment, args.project);
    invalidate(this.installationId, item.id);
    return item;
  }

  async addComment(id: string, body: string, project?: string): Promise<void> {
    await this.request(this.projPath(project, `wit/workitems/${id}/comments?api-version=7.1-preview.4`), {
      method: "POST",
      body: JSON.stringify({ text: body }),
    });
  }

  async updateItem(args: AdoUpdateArgs): Promise<WorkItem> {
    const sanitized = sanitizeDoneUpdate(args);
    const patch: PatchOp[] = [];
    if (sanitized.title) patch.push({ op: "add", path: "/fields/System.Title", value: sanitized.title });
    if (sanitized.state) patch.push({ op: "add", path: "/fields/System.State", value: sanitized.state });
    if (sanitized.reason) patch.push({ op: "add", path: "/fields/System.Reason", value: sanitized.reason });
    if (sanitized.description) patch.push({ op: "add", path: "/fields/System.Description", value: sanitized.description });
    if (sanitized.area) patch.push({ op: "add", path: "/fields/System.AreaPath", value: sanitized.area });
    if (sanitized.iteration) patch.push({ op: "add", path: "/fields/System.IterationPath", value: sanitized.iteration });
    if (sanitized.assignedTo) patch.push({ op: "add", path: "/fields/System.AssignedTo", value: sanitized.assignedTo });
    for (const [key, value] of Object.entries(sanitized.fields ?? {})) patch.push({ op: "add", path: `/fields/${key}`, value });

    if (patch.length === 0 && !sanitized.comment) throw new Error("no changes given");
    let raw: RawWi | undefined;
    if (patch.length > 0) {
      raw = await this.request<RawWi>(this.projPath(sanitized.project, `wit/workitems/${sanitized.id}`), {
        method: "PATCH",
        patch,
      });
    }
    if (sanitized.comment) await this.addComment(sanitized.id, sanitized.comment, sanitized.project);
    invalidate(this.installationId, sanitized.id);
    return normalizeItem(raw ?? { id: Number(sanitized.id), fields: {} }, this.settings, sanitized.project);
  }

  async prShow(id: string, project?: string): Promise<PullRequest> {
    const raw = await this.request<Record<string, unknown>>(this.projPath(project, `git/pullrequests/${id}`));
    return normalizePr(raw, this.settings, project ?? this.settings.project);
  }

  async prList(args: AdoPrListArgs): Promise<PullRequest[]> {
    const params = new URLSearchParams();
    params.set("searchCriteria.status", args.status ?? "active");
    params.set("$top", String(args.top ?? 20));
    if (args.sourceBranch) params.set("searchCriteria.sourceRefName", branchRef(args.sourceBranch));
    if (args.targetBranch) params.set("searchCriteria.targetRefName", branchRef(args.targetBranch));
    if (args.creator) params.set("searchCriteria.creatorId", args.creator);
    if (args.reviewer) params.set("searchCriteria.reviewerId", args.reviewer);
    const raw = await this.request<{ value: Array<Record<string, unknown>> }>(
      this.projPath(undefined, `git/pullrequests?${params.toString()}`),
    );
    const prs = raw.value.map((entry) => normalizePr(entry, this.settings, this.settings.project));
    return args.repository ? prs.filter((pr) => pr.repository === args.repository) : prs;
  }

  async prCreate(args: AdoPrCreateArgs): Promise<PullRequest> {
    const links = (args.linkWorkItems ?? []).map((id) => `AB#${id}`).join(" ");
    const description = [args.description, links].filter(Boolean).join("\n\n");
    const body: Record<string, unknown> = {
      sourceRefName: branchRef(args.sourceBranch),
      targetRefName: branchRef(args.targetBranch),
      title: args.title,
    };
    if (description) body.description = description;
    if (args.draft) body.isDraft = true;
    if (args.deleteSourceBranch) body.deleteSourceRefAfterMerge = true;

    if (args.reviewers?.length) {
      const resolved: Array<{ id: string }> = [];
      const failed: string[] = [];
      for (const reviewer of args.reviewers) {
        const id = await this.resolveEmail(reviewer);
        if (id) resolved.push({ id });
        else failed.push(reviewer);
      }
      if (resolved.length > 0) body.reviewers = resolved;
      if (failed.length > 0) process.stderr.write(`[devwork] unresolved reviewers: ${failed.join(", ")}\n`);
    }

    const raw = await this.request<Record<string, unknown>>(
      this.projPath(undefined, `git/repositories/${encodeURIComponent(args.repository)}/pullrequests`),
      { method: "POST", body: JSON.stringify(body) },
    );
    const pr = normalizePr(raw, this.settings, this.settings.project);
    if (args.autoComplete) {
      try {
        await this.prUpdate({ id: pr.id, autoComplete: true });
      } catch {
        /* auto-complete is a convenience; the PR already exists */
      }
    }
    return pr;
  }

  async prUpdate(args: AdoPrUpdateArgs): Promise<PullRequest> {
    if (args.status === "completed") {
      if (!args.expectedHeadSha) throw new Error("refusing to complete a pull request without the head commit the preview was computed against");
      const current = await this.prShow(args.id);
      if (current.headSha !== args.expectedHeadSha) {
        throw new Error(
          `the pull request moved since the preview (head ${current.headSha ?? "unknown"} ≠ ${args.expectedHeadSha}) — review it again`,
        );
      }
    }
    const body: Record<string, unknown> = {};
    if (args.title) body.title = args.title;
    if (args.description) body.description = args.description;
    if (args.status) body.status = args.status;
    if (args.draft !== undefined) body.isDraft = args.draft;
    if (Object.keys(body).length === 0 && args.autoComplete === undefined) throw new Error("no changes given");
    if (args.autoComplete !== undefined) {
      body.autoCompleteSetBy = args.autoComplete ? { id: await this.selfId() } : null;
    }
    invalidate(this.installationId, args.id);
    const raw = await this.request<Record<string, unknown>>(this.projPath(undefined, `git/pullrequests/${args.id}`), {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return normalizePr(raw, this.settings, this.settings.project);
  }

  async prVote(id: string, vote: string, repository?: string): Promise<string> {
    const voteNumber = VOTE_NUMBER[vote];
    if (voteNumber === undefined) throw new Error(`invalid vote "${vote}"`);
    const me = await this.selfId();
    const path = repository
      ? `git/repositories/${encodeURIComponent(repository)}/pullrequests/${id}/reviewers/${me}`
      : `git/pullrequests/${id}/reviewers/${me}`;
    await this.request(this.projPath(undefined, path), { method: "PUT", body: JSON.stringify({ vote: voteNumber }) });
    invalidate(this.installationId, id);
    return VOTE_LABEL[vote] ?? vote;
  }

  async repoList(): Promise<Array<{ name: string; id: string; defaultBranch?: string | undefined }>> {
    const raw = await this.request<{ value: Array<Record<string, unknown>> }>(this.projPath(undefined, "git/repositories"));
    return raw.value.map((entry) =>
      compact({
        name: String(entry.name ?? "?"),
        id: String(entry.id ?? "?"),
        defaultBranch: (entry.defaultBranch as string | undefined) ?? undefined,
      }),
    );
  }
}

function relationIds(raw: RawWi): { parent?: string; children: string[] } {
  const result: { parent?: string; children: string[] } = { children: [] };
  for (const relation of raw.relations ?? []) {
    const match = relation.url.match(/\/workitems\/(\d+)$/);
    if (!match) continue;
    const id = match[1] as string;
    if (relation.rel === "System.LinkTypes.Hierarchy-Forward") result.children.push(id);
    else if (relation.rel === "System.LinkTypes.Hierarchy-Reverse" && !result.parent) result.parent = id;
  }
  return result;
}
