/**
 * Pull-request tools: show, list, create, update, vote. PRs exist on ADO and
 * GitHub; Jira has none, so a Jira default backend falls back to an enabled PR
 * backend instead of silently pretending.
 */
import { requiredOperations, runWrite } from "../safety.js";
import { renderPr, renderPrList } from "../render.js";
import { result, type Backend, type PullRequest, type ToolResult } from "../types.js";
import type { PrCreateArgs, PrListArgs, PrShowArgs, PrUpdateArgs, PrVoteArgs } from "../contract.js";
import type { Context } from "../context.js";
import { checkTarget } from "../scope.js";
import { adoProject, fail, failure, githubRepo, routeOrError } from "./common.js";

/** Which backend serves pull requests: the requested one, else the default when
 *  it can carry PRs, else the first enabled PR backend. */
export function prBackend(ctx: Context, requested: Backend | undefined): { ok: true; backend: "ado" | "github" } | { ok: false; result: ToolResult } {
  if (requested === "ado" || requested === "github") {
    const scope = checkTarget(ctx.installation, { backend: requested, kind: "pr", id: "0" });
    if (!scope.ok && ctx.installation[requested].auth === "off") return { ok: false, result: fail(scope.reason ?? "backend disabled", "backend disabled") };
    return { ok: true, backend: requested };
  }
  const preferred = ctx.installation.defaultBackend;
  if (preferred === "ado" || preferred === "github") return { ok: true, backend: preferred };
  if (ctx.installation.github.auth !== "off") return { ok: true, backend: "github" };
  if (ctx.installation.ado.auth !== "off") return { ok: true, backend: "ado" };
  return { ok: false, result: fail("pull requests need an enabled ADO or GitHub backend; both are disabled in this installation", "no pr backend") };
}

async function currentPr(ctx: Context, backend: "ado" | "github", id: string, repo: string | undefined, project: string | undefined): Promise<PullRequest | null> {
  try {
    if (backend === "github") {
      if (!repo) return null;
      const fetched = await ctx.github.getIssueOrPr(repo, id);
      return fetched.pr ?? null;
    }
    return await ctx.ado.prShow(id, project);
  } catch {
    return null;
  }
}

export async function devworkPrShow(args: PrShowArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref, "pr");
  if (!routed.ok) return routed.result;
  const target = routed.target;
  try {
    if (target.backend === "github") {
      const repo = githubRepo(ctx, target.repo, args.repository);
      if (!repo.ok) return repo.result;
      const fetched = await ctx.github.getIssueOrPr(repo.repo, target.id);
      if (!fetched.pr) return fail(`#${target.id} in ${repo.repo} is an issue, not a pull request`, "not a pr");
      return result(renderPr(fetched.pr), { backend: "github", pr: fetched.pr });
    }
    if (target.backend === "jira") return fail("pull requests exist on ADO and GitHub only", "pr not routable");
    const project = adoProject(ctx, target.project);
    if (!project.ok) return project.result;
    const pr = await ctx.ado.prShow(target.id, project.project);
    return result(renderPr(pr), { backend: "ado", pr });
  } catch (error) {
    return failure("failed to get the pull request", error);
  }
}

export async function devworkPrList(args: PrListArgs, ctx: Context): Promise<ToolResult> {
  const selected = prBackend(ctx, args.backend);
  if (!selected.ok) return selected.result;
  const backend = selected.backend;
  try {
    if (backend === "github") {
      const repo = githubRepo(ctx, args.repository);
      if (!repo.ok) return repo.result;
      const prs = await ctx.github.prList(repo.repo, args.status ?? "active", args.top ?? ctx.installation.top);
      return result(renderPrList(prs), { backend, prs, count: prs.length });
    }
    const project = adoProject(ctx);
    if (!project.ok) return project.result;
    const prs = await ctx.ado.prList({
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.repository !== undefined ? { repository: args.repository } : {}),
      ...(args.creator !== undefined ? { creator: args.creator } : {}),
      ...(args.reviewer !== undefined ? { reviewer: args.reviewer } : {}),
      ...(args.sourceBranch !== undefined ? { sourceBranch: args.sourceBranch } : {}),
      ...(args.targetBranch !== undefined ? { targetBranch: args.targetBranch } : {}),
      ...(args.top !== undefined ? { top: args.top } : {}),
    });
    return result(renderPrList(prs), { backend, prs, count: prs.length });
  } catch (error) {
    return failure("pull request list failed", error);
  }
}

export async function devworkPrCreate(args: PrCreateArgs, ctx: Context): Promise<ToolResult> {
  const selected = prBackend(ctx, args.backend);
  if (!selected.ok) return selected.result;
  const backend = selected.backend;

  if (backend === "github") {
    const repo = githubRepo(ctx, args.repository);
    if (!repo.ok) return repo.result;
  } else {
    const project = adoProject(ctx);
    if (!project.ok) return project.result;
  }

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_pr_create",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_pr_create", args as Record<string, unknown>),
    preview: async () => ({
      human: [
        `Create ${backend} pull request in ${args.repository}: ${args.sourceBranch} → ${args.targetBranch}`,
        `Title: ${args.title}`,
        ...(args.draft ? ["Draft: yes"] : []),
        ...(args.linkWorkItems?.length ? [`Auto-link: ${args.linkWorkItems.map((id) => `#${id}`).join(" ")}`] : []),
        ...(args.reviewers?.length ? [`Reviewers: ${args.reviewers.join(", ")}`] : []),
      ].join("\n"),
      data: { op: "pr_create", backend, repository: args.repository, source: args.sourceBranch, target: args.targetBranch },
    }),
    execute: async () => {
      try {
        if (backend === "github") {
          const pr = await ctx.github.prCreate({
            repo: args.repository,
            sourceBranch: args.sourceBranch,
            targetBranch: args.targetBranch,
            title: args.title,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.draft !== undefined ? { draft: args.draft } : {}),
            ...(args.linkWorkItems !== undefined ? { linkWorkItems: args.linkWorkItems } : {}),
          });
          return result(`✅ Created PR #${pr.id}\n${pr.url ?? ""}`.trim(), { backend, pr });
        }
        const pr = await ctx.ado.prCreate({
          repository: args.repository,
          sourceBranch: args.sourceBranch,
          targetBranch: args.targetBranch,
          title: args.title,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.draft !== undefined ? { draft: args.draft } : {}),
          ...(args.autoComplete !== undefined ? { autoComplete: args.autoComplete } : {}),
          ...(args.deleteSourceBranch !== undefined ? { deleteSourceBranch: args.deleteSourceBranch } : {}),
          ...(args.reviewers !== undefined ? { reviewers: args.reviewers } : {}),
          ...(args.linkWorkItems !== undefined ? { linkWorkItems: args.linkWorkItems } : {}),
        });
        return result(`✅ Created PR #${pr.id}\n${pr.url ?? ""}`.trim(), { backend, pr });
      } catch (error) {
        return failure("pull request create failed", error);
      }
    },
  });
}

export async function devworkPrUpdate(args: PrUpdateArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref, "pr");
  if (!routed.ok) return routed.result;
  const target = routed.target;
  if (target.backend === "jira") return fail("pull requests exist on ADO and GitHub only", "pr not routable");

  const backend = target.backend;
  let repo: string | undefined;
  let project: string | undefined;
  if (backend === "github") {
    const selected = githubRepo(ctx, target.repo, args.repository);
    if (!selected.ok) return selected.result;
    repo = selected.repo;
  } else {
    const selected = adoProject(ctx, target.project);
    if (!selected.ok) return selected.result;
    project = selected.project;
  }

  const merge = args.status === "completed" && backend === "github";
  const changes: Array<[string, unknown]> = Object.entries(args).filter(
    ([key, value]) => !["ref", "repository", "confirm", "approvalToken"].includes(key) && value !== undefined,
  );

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_pr_update",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_pr_update", args as Record<string, unknown>),
    preview: async () => {
      const current = await currentPr(ctx, backend, target.id, repo, project);
      const guard = merge ? current?.headSha : undefined;
      return {
        // The head SHA the user is approving. A merge that no longer matches it
        // is refused, so approving "this commit" cannot merge a later one.
        ...(guard !== undefined ? { guard } : {}),
        human: [
          `Update ${backend} PR ${args.ref}${current ? `\nCurrent: PR #${current.id} [${current.status ?? "?"}] ${current.title ?? "?"}` : ""}`,
          ...(merge
            ? ["", "⚠ operation: MERGE — status:completed merges this pull request (squash) on GitHub. This cannot be undone by the agent."]
            : []),
          "Changes:",
          ...changes.map(([key, value]) => `  ${key}: ${String(value).slice(0, 160)}`),
        ].join("\n"),
        data: {
          op: merge ? "merge" : "pr_update",
          backend,
          id: target.id,
          repository: repo ?? project ?? null,
          ...(merge && current?.headSha ? { headSha: current.headSha } : {}),
          changes: Object.fromEntries(changes),
        },
      };
    },
    execute: async (guard) => {
      try {
        if (backend === "github" && repo) {
          const pr = await ctx.github.prUpdate({
            repo,
            n: target.id,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(merge && guard !== undefined ? { expectedHeadSha: guard } : {}),
          });
          return result(`✅ Updated PR #${pr.id} [${pr.status}]`, { backend, pr });
        }
        const pr = await ctx.ado.prUpdate({
          id: target.id,
          ...(args.status === "completed" && guard !== undefined ? { expectedHeadSha: guard } : {}),
          ...(args.repository !== undefined ? { repository: args.repository } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.autoComplete !== undefined ? { autoComplete: args.autoComplete } : {}),
          ...(args.draft !== undefined ? { draft: args.draft } : {}),
        });
        return result(`✅ Updated PR #${pr.id} [${pr.status}]`, { backend, pr });
      } catch (error) {
        return failure("pull request update failed", error);
      }
    },
  });
}

export async function devworkPrVote(args: PrVoteArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref, "pr");
  if (!routed.ok) return routed.result;
  const target = routed.target;
  if (target.backend === "jira") return fail("pull requests exist on ADO and GitHub only", "pr not routable");

  const backend = target.backend;
  let repo: string | undefined;
  if (backend === "github") {
    const selected = githubRepo(ctx, target.repo, args.repository);
    if (!selected.ok) return selected.result;
    repo = selected.repo;
  } else {
    const selected = adoProject(ctx, target.project);
    if (!selected.ok) return selected.result;
  }

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_pr_vote",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_pr_vote", args as Record<string, unknown>),
    preview: async () => ({
      human: `Vote "${args.vote}" as the authenticated user on ${backend} PR ${args.ref}${args.comment ? `\nReview comment: ${args.comment.slice(0, 300)}` : ""}`,
      data: { op: "pr_vote", backend, id: target.id, vote: args.vote },
    }),
    execute: async () => {
      try {
        if (backend === "github" && repo) {
          const label = await ctx.github.prVote(repo, target.id, args.vote, args.comment);
          return result(`✅ ${label} on PR #${target.id}`, { backend, id: target.id, vote: args.vote });
        }
        const label = await ctx.ado.prVote(target.id, args.vote, args.repository);
        return result(`✅ ${label} on PR #${target.id}`, { backend, id: target.id, vote: args.vote });
      } catch (error) {
        return failure("vote failed", error);
      }
    },
  });
}
