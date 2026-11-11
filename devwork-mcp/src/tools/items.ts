/**
 * Work-item tools: get, query, create, update. Every handler routes, checks the
 * installation scope, and only then talks to a backend; create and update go
 * through the two-phase write flow in safety.ts.
 */
import { requiredOperations, runWrite } from "../safety.js";
import { renderItem, renderPr, renderQueryResult } from "../render.js";
import { result, type QueryFilters, type ToolResult, type WorkItem } from "../types.js";
import type { CreateArgs, GetArgs, QueryArgs, UpdateArgs } from "../contract.js";
import type { Context } from "../context.js";
import { adoProject, enabledBackend, fail, failure, githubRepo, routeOrError } from "./common.js";
import { defaultGithubRepo } from "../scope.js";

function filters(args: QueryArgs, fallbackTop: number): QueryFilters {
  return {
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.state !== undefined ? { state: args.state } : {}),
    ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
    ...(args.contains !== undefined ? { contains: args.contains } : {}),
    ...(args.changedWithinDays !== undefined ? { changedWithinDays: args.changedWithinDays } : {}),
    ...(args.top !== undefined ? { top: args.top } : { top: fallbackTop }),
  };
}

export async function devworkGet(args: GetArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref);
  if (!routed.ok) return routed.result;
  const target = routed.target;

  try {
    if (target.backend === "github") {
      const repo = githubRepo(ctx, target.repo, args.repo);
      if (!repo.ok) return repo.result;
      const fetched = await ctx.github.getIssueOrPr(repo.repo, target.id);
      if (fetched.pr) return result(renderPr(fetched.pr), { backend: "github", pr: fetched.pr });
      if (!fetched.item) return fail(`#${target.id} in ${repo.repo} returned neither an issue nor a pull request`, "empty response");
      return result(renderItem(fetched.item), { backend: "github", item: fetched.item });
    }
    if (target.backend === "ado") {
      const project = adoProject(ctx, target.project);
      if (!project.ok) return project.result;
      const item = await ctx.ado.getWorkItem(target.id, {
        refresh: args.refresh === true,
        cacheTtlSeconds: ctx.installation.cacheTtlSeconds,
        project: project.project,
      });
      return result(renderItem(item), { backend: "ado", item });
    }
    const item = await ctx.jira.getIssue(target.id);
    return result(renderItem(item), { backend: "jira", item });
  } catch (error) {
    return failure(`failed to get ${args.ref}`, error);
  }
}

export async function devworkQuery(args: QueryArgs, ctx: Context): Promise<ToolResult> {
  const backend = enabledBackend(ctx, args.backend);
  const query = filters(args, ctx.installation.top);
  try {
    if (backend === "github") {
      const repo = githubRepo(ctx, args.repo);
      if (!repo.ok) return repo.result;
      const items = await ctx.github.search(query, ctx.installation.top, repo.repo, ctx.installation.github.repositories);
      return result(renderQueryResult(items, items.length), { backend, count: items.length, items });
    }
    if (backend === "ado") {
      const project = adoProject(ctx);
      if (!project.ok) return project.result;
      const items = await ctx.ado.queryItems(query, ctx.installation.top, project.project);
      return result(renderQueryResult(items, items.length), { backend, count: items.length, items });
    }
    const items = await ctx.jira.searchIssues(query, ctx.installation.top, ctx.installation.jira.projects);
    return result(renderQueryResult(items, items.length), { backend, count: items.length, items });
  } catch (error) {
    return failure("query failed", error);
  }
}

export async function devworkCreate(args: CreateArgs, ctx: Context): Promise<ToolResult> {
  const backend = enabledBackend(ctx, args.backend);

  // Authorize the destination before the preview exists, so an out-of-scope
  // target never reaches the confirm step.
  let project = "";
  if (backend === "github") {
    const repo = githubRepo(ctx, args.project ?? defaultGithubRepo(ctx.installation));
    if (!repo.ok) return repo.result;
    project = repo.repo;
  } else if (backend === "jira") {
    if (!args.project) return fail("Jira create needs a project key: pass project (one of the installation's jira.projects)", "project required");
    project = args.project;
    if (!ctx.installation.jira.projects.includes(project)) {
      return fail(`Jira project "${project}" is outside this installation's scope — allowed: ${ctx.installation.jira.projects.join(", ")}`, "out of scope");
    }
  } else {
    const selected = adoProject(ctx, args.project);
    if (!selected.ok) return selected.result;
    project = selected.project;
  }

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_create",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_create", args as Record<string, unknown>),
    preview: async () => ({
      human: [
        `Create ${backend === "github" ? `${project} issue` : `${project} ${args.type}`}: ${args.title}`,
        ...(args.description ? [`Description: ${args.description.slice(0, 300)}`] : []),
        ...(args.assignedTo ? [`Assigned: ${args.assignedTo}`] : []),
        ...(args.comment ? [`Initial comment: ${args.comment.slice(0, 200)}`] : []),
      ].join("\n"),
      data: { op: "create", backend, project, type: args.type, title: args.title },
    }),
    execute: async () => {
      try {
        if (backend === "github") {
          const item = await ctx.github.createIssue({
            repo: project,
            title: args.title,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
            ...(args.labels !== undefined ? { labels: args.labels } : {}),
          });
          return result(`✅ Created #${item.id}: ${item.title}\n${item.url ?? ""}`.trim(), { backend, item });
        }
        if (backend === "jira") {
          const item = await ctx.jira.createIssue({
            project,
            type: args.type,
            title: args.title,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          });
          return result(`✅ Created ${item.key ?? item.id}: ${item.title}\n${item.url ?? ""}`.trim(), { backend, item });
        }
        const item = await ctx.ado.createItem({
          type: args.type,
          title: args.title,
          project,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
          ...(args.area !== undefined ? { area: args.area } : {}),
          ...(args.iteration !== undefined ? { iteration: args.iteration } : {}),
          ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
          ...(args.fields !== undefined ? { fields: args.fields } : {}),
        });
        return result(`✅ Created #${item.id}: ${item.title}\n${item.url ?? ""}`.trim(), { backend, item });
      } catch (error) {
        return failure("create failed", error);
      }
    },
  });
}

export async function devworkUpdate(args: UpdateArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref);
  if (!routed.ok) return routed.result;
  const target = routed.target;

  let project: string | undefined;
  let repo: string | undefined;
  if (target.backend === "ado") {
    const selected = adoProject(ctx, target.project);
    if (!selected.ok) return selected.result;
    project = selected.project;
  }
  if (target.backend === "github") {
    const selected = githubRepo(ctx, target.repo, args.repo);
    if (!selected.ok) return selected.result;
    repo = selected.repo;
  }
  if (target.backend === "jira") {
    const key = target.key ?? target.id;
    const keyProject = key.split("-")[0] ?? "";
    if (!ctx.installation.jira.projects.includes(keyProject)) {
      return fail(`Jira project "${keyProject}" is outside this installation's scope — allowed: ${ctx.installation.jira.projects.join(", ")}`, "out of scope");
    }
  }

  const changes: Array<[string, unknown]> = Object.entries(args).filter(
    ([key, value]) => !["ref", "repo", "confirm", "approvalToken"].includes(key) && value !== undefined,
  );

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_update",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_update", args as Record<string, unknown>),
    preview: async () => {
      let current = "";
      try {
        if (target.backend === "ado") {
          const item = await ctx.ado.getWorkItem(target.id, {
            cacheTtlSeconds: ctx.installation.cacheTtlSeconds,
            ...(project !== undefined ? { project } : {}),
          });
          current = describeCurrent(item);
        } else if (target.backend === "github" && repo) {
          const fetched = await ctx.github.getIssueOrPr(repo, target.id);
          const item: WorkItem | undefined = fetched.item ?? (fetched.pr ? prAsItem(fetched.pr.id, fetched.pr.title, fetched.pr.status) : undefined);
          current = item ? describeCurrent(item) : "";
        } else {
          current = describeCurrent(await ctx.jira.getIssue(target.id));
        }
      } catch (error) {
        current = `(could not read the current values: ${(error as Error).message.slice(0, 140)})`;
      }
      return {
        human: [
          `Update ${args.ref}${current ? `\nCurrent: ${current}` : ""}`,
          "Changes:",
          ...changes.map(([key, value]) => `  ${key}: ${String(value).slice(0, 160)}`),
        ].join("\n"),
        data: { op: "update", backend: target.backend, id: target.id, changes: Object.fromEntries(changes) },
      };
    },
    execute: async () => {
      try {
        if (target.backend === "github" && repo) {
          const item = await ctx.github.updateIssue({
            repo,
            n: target.id,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          });
          return result(`✅ Updated #${item.id} [${item.state}] ${item.title}`, { backend: "github", item });
        }
        if (target.backend === "ado") {
          const item = await ctx.ado.updateItem({
            id: target.id,
            ...(project !== undefined ? { project } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
            ...(args.area !== undefined ? { area: args.area } : {}),
            ...(args.iteration !== undefined ? { iteration: args.iteration } : {}),
            ...(args.fields !== undefined ? { fields: args.fields } : {}),
          });
          return result(`✅ Updated #${item.id} [${item.state}] ${item.title}`, { backend: "ado", item });
        }
        const item = await ctx.jira.updateIssue({
          key: target.id,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.assignedTo !== undefined ? { assignedTo: args.assignedTo } : {}),
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
        });
        return result(`✅ Updated ${item.key ?? item.id} [${item.state}] ${item.title}`, { backend: "jira", item });
      } catch (error) {
        return failure("update failed", error);
      }
    },
  });
}

function describeCurrent(item: WorkItem): string {
  return `${item.backend === "jira" ? (item.key ?? item.id) : `#${item.id}`} [${item.state ?? "?"}] ${item.title ?? "?"}  (assigned: ${item.assignedTo ?? "–"})`;
}

function prAsItem(id: string, title: string | undefined, status: string | undefined): WorkItem {
  return { backend: "github", id, ...(title !== undefined ? { title } : {}), ...(status !== undefined ? { state: status } : {}) };
}
