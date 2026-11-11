/**
 * GitHub backend — REST v3 for issues and pull requests. The token comes from
 * the installation's credential resolver; this module never looks at the
 * environment or at the `gh` CLI itself, so there is exactly one place where an
 * identity is chosen (credentials.ts).
 *
 * GitHub quirk: issues and PRs share one number space — GET /issues/{n}
 * returns both, and PRs carry a `pull_request` field; they are re-fetched via
 * /pulls/{n} for merge/review shape.
 */
import { LIMITS } from "./contract.js";
import type { GithubSettings } from "./installation.js";
import { safeBody } from "./redact.js";
import type { PullRequest, QueryFilters, WorkItem } from "./types.js";

export const GH_INSTALL_HINT =
  "Set github.auth:\"ambient\" in the installation profile to borrow the machine login " +
  "(brew install gh && gh auth login), or put a token in the profile as token:\"env:<VARIABLE>\"";

export interface Fetched {
  item?: WorkItem;
  pr?: PullRequest;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function normalizeIssue(raw: Record<string, unknown>): WorkItem {
  const url = raw.html_url as string | undefined;
  const repoFromUrl = url?.match(/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\//)?.[1];
  const assignee = raw.assignee as { login?: string } | undefined;
  const assignees = Array.isArray(raw.assignees) ? (raw.assignees as Array<{ login?: string }>) : [];
  const labels = Array.isArray(raw.labels) ? (raw.labels as Array<string | { name?: string }>) : [];
  return compact({
    backend: "github" as const,
    id: String(raw.number ?? ""),
    url,
    type: raw.pull_request ? "PullRequest" : "Issue",
    title: raw.title as string | undefined,
    state: raw.state as string | undefined,
    assignedTo: assignee?.login ?? assignees[0]?.login,
    createdBy: (raw.user as { login?: string } | undefined)?.login,
    created: raw.created_at as string | undefined,
    changed: raw.updated_at as string | undefined,
    area: repoFromUrl,
    tags: labels.map((l) => (typeof l === "string" ? l : l.name)).filter((n): n is string => Boolean(n)),
    description: typeof raw.body === "string" && raw.body ? (raw.body as string) : undefined,
    commentCount: typeof raw.comments === "number" ? (raw.comments as number) : undefined,
  });
}

export function normalizePr(raw: Record<string, unknown>): PullRequest {
  const head = raw.head as { ref?: string; sha?: string } | undefined;
  const base = raw.base as { ref?: string; repo?: { full_name?: string } } | undefined;
  return compact({
    id: String(raw.number ?? ""),
    url: raw.html_url as string | undefined,
    title: raw.title as string | undefined,
    status: raw.state === "open" ? "active" : raw.merged ? "completed" : "abandoned",
    isDraft: Boolean(raw.draft),
    source: head?.ref,
    target: base?.ref,
    createdBy: (raw.user as { login?: string } | undefined)?.login,
    created: raw.created_at as string | undefined,
    mergeStatus: raw.mergeable_state as string | undefined,
    description: typeof raw.body === "string" && raw.body ? (raw.body as string) : undefined,
    repository: base?.repo?.full_name,
    headSha: head?.sha,
  });
}

/** GitHub search takes one text query, so every filter must be neutralised
 *  before it can be read as a qualifier (`repo:`, `org:`, `user:` …). */
export function buildSearchQuery(q: QueryFilters, repo: string): string {
  const parts = [`repo:${repo}`, /^pull/i.test(q.type ?? "") ? "is:pr" : "is:issue"];
  if (q.state) {
    const state = /^(active|open)$/i.test(q.state)
      ? "open"
      : /^(done|closed|merged|completed)$/i.test(q.state)
        ? "closed"
        : null;
    if (state === null) throw new Error(`unsupported state filter: "${q.state}" (use active/open or done/closed/merged/completed)`);
    parts.push(`state:${state}`);
  }
  if (q.assignedTo) {
    if (/^(me|@me)$/i.test(q.assignedTo)) {
      parts.push("assignee:@me");
    } else {
      const login = q.assignedTo.replace(/[^A-Za-z0-9_.@-]/g, "");
      if (login.length === 0) throw new Error(`invalid assignee filter: "${q.assignedTo}"`);
      parts.push(`assignee:${login}`);
    }
  }
  if (q.contains) {
    const phrase = q.contains.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    if (phrase.length > 0) parts.push(`"${phrase}"`);
  }
  parts.push("sort:updated-desc");
  return parts.join(" ");
}

/** GitHub search is repo-scoped by a query qualifier, which is text. The answer
 *  is filtered here so a crafted qualifier cannot leak another repository. */
export function onlyAllowedRepos(items: WorkItem[], allowedRepos: string[]): WorkItem[] {
  const allowed = new Set(allowedRepos.map((entry) => entry.toLowerCase()));
  return items.filter((item) => item.area !== undefined && allowed.has(item.area.toLowerCase()));
}

export interface GithubCreateArgs {
  repo: string;
  title: string;
  description?: string;
  labels?: string[];
  assignedTo?: string;
}

export interface GithubUpdateArgs {
  repo: string;
  n: string;
  title?: string;
  description?: string;
  state?: string;
  comment?: string;
}

export interface GithubPrCreateArgs {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  draft?: boolean;
  linkWorkItems?: number[];
}

export interface GithubPrUpdateArgs {
  repo: string;
  n: string;
  title?: string;
  description?: string;
  status?: string;
  /** Head SHA the preview was computed against; the merge is refused if the PR moved. */
  expectedHeadSha?: string;
}

export class GithubClient {
  constructor(
    private readonly settings: GithubSettings,
    private readonly token: () => Promise<string | undefined>,
    private readonly timeoutMs: number = LIMITS.httpTimeoutMs,
  ) {}

  private base(): string {
    return this.settings.apiBase.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.token();
    if (!token) throw new Error(`GitHub backend has no usable credential.\n${GH_INSTALL_HINT}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.base()}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // A provider error can echo request headers; never pass the body on raw.
        throw new Error(`GitHub ${response.status} ${path}: ${safeBody(body, 400, [token])}`);
      }
      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async getIssueOrPr(repo: string, n: string): Promise<Fetched> {
    const issue = await this.request<Record<string, unknown>>(`/repos/${repo}/issues/${n}`);
    if (issue.pull_request) {
      const pr = await this.request<Record<string, unknown>>(`/repos/${repo}/pulls/${n}`);
      return { pr: normalizePr(pr) };
    }
    return { item: normalizeIssue(issue) };
  }

  async search(q: QueryFilters, top: number, repo: string, allowedRepos: string[]): Promise<WorkItem[]> {
    const query = encodeURIComponent(buildSearchQuery(q, repo));
    const perPage = Math.min(100, Math.max(1, q.top ?? top));
    const response = await this.request<{ items?: Array<Record<string, unknown>> }>(
      `/search/issues?q=${query}&per_page=${perPage}`,
    );
    return onlyAllowedRepos(
      (response.items ?? []).map((item) => normalizeIssue(item)),
      allowedRepos,
    );
  }

  async prList(repo: string, state: string, top: number): Promise<PullRequest[]> {
    const requested = state === "all" ? "all" : state === "completed" || state === "abandoned" ? "closed" : "open";
    const rows = await this.request<Array<Record<string, unknown>>>(
      `/repos/${repo}/pulls?state=${requested}&per_page=${Math.min(100, top)}`,
    );
    const prs = rows.map((row) => normalizePr(row));
    if (state === "completed") return prs.filter((pr) => pr.status === "completed");
    if (state === "abandoned") return prs.filter((pr) => pr.status === "abandoned");
    return prs;
  }

  async createIssue(args: GithubCreateArgs): Promise<WorkItem> {
    const body: Record<string, unknown> = { title: args.title };
    if (args.description) body.body = args.description;
    if (args.labels?.length) body.labels = args.labels;
    if (args.assignedTo) body.assignees = [args.assignedTo];
    const raw = await this.request<Record<string, unknown>>(`/repos/${args.repo}/issues`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return normalizeIssue(raw);
  }

  async updateIssue(args: GithubUpdateArgs): Promise<WorkItem> {
    const body: Record<string, unknown> = {};
    if (args.title) body.title = args.title;
    if (args.description) body.body = args.description;
    if (args.state) {
      body.state = /^(done|closed|resolved)$/i.test(args.state)
        ? "closed"
        : /^(active|open|reopened)$/i.test(args.state)
          ? "open"
          : args.state;
    }
    if (Object.keys(body).length > 0) {
      await this.request(`/repos/${args.repo}/issues/${args.n}`, { method: "PATCH", body: JSON.stringify(body) });
    }
    if (args.comment) {
      await this.request(`/repos/${args.repo}/issues/${args.n}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: args.comment }),
      });
    }
    const raw = await this.request<Record<string, unknown>>(`/repos/${args.repo}/issues/${args.n}`);
    return normalizeIssue(raw);
  }

  async prCreate(args: GithubPrCreateArgs): Promise<PullRequest> {
    const links = (args.linkWorkItems ?? []).map((n) => `Closes #${n}`).join(" ");
    const payload = compact({
      title: args.title,
      head: args.sourceBranch,
      base: args.targetBranch,
      body: [args.description, links].filter(Boolean).join("\n\n") || undefined,
      draft: args.draft === true ? true : undefined,
    });
    const raw = await this.request<Record<string, unknown>>(`/repos/${args.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return normalizePr(raw);
  }

  /** `status: "completed"` merges the pull request (squash). */
  async prUpdate(args: GithubPrUpdateArgs): Promise<PullRequest> {
    if (args.status === "completed") {
      if (!args.expectedHeadSha) throw new Error("refusing to merge without the head SHA the preview was computed against");
      const raw = await this.request<Record<string, unknown>>(`/repos/${args.repo}/pulls/${args.n}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: "squash", sha: args.expectedHeadSha }),
      });
      if (!raw.merged) throw new Error(`PR #${args.n} was not merged: ${JSON.stringify(raw).slice(0, 300)}`);
    } else {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title;
      if (args.description) body.body = args.description;
      if (args.status === "abandoned") body.state = "closed";
      if (args.status === "active") body.state = "open";
      if (Object.keys(body).length > 0) {
        await this.request(`/repos/${args.repo}/pulls/${args.n}`, { method: "PATCH", body: JSON.stringify(body) });
      }
    }
    const raw = await this.request<Record<string, unknown>>(`/repos/${args.repo}/pulls/${args.n}`);
    return normalizePr(raw);
  }

  /** Approve / request-changes / comment as a review by the authenticated user. */
  async prVote(repo: string, n: string, vote: string, body?: string): Promise<string> {
    const event =
      vote === "approve" || vote === "approve-with-suggestions"
        ? "APPROVE"
        : vote === "wait-for-author" || vote === "reject"
          ? "REQUEST_CHANGES"
          : "COMMENT";
    await this.request(`/repos/${repo}/pulls/${n}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event, ...(body ? { body } : {}) }),
    });
    return event === "APPROVE" ? "✅ APPROVE" : event === "REQUEST_CHANGES" ? "❌ REQUEST_CHANGES" : "💬 COMMENT";
  }

  async whoami(): Promise<string | null> {
    try {
      const user = await this.request<{ login?: string }>("/user");
      return user.login ?? null;
    } catch {
      return null;
    }
  }
}
