/**
 * ADO task-ops absorbed from the former `ado-task` skill: create a derived
 * child Task under a PBI/Bug, close a Task with CompletedWork, and show a
 * PBI/Bug with its children. ADO only; the project is always the installation's.
 */
import { requiredOperations, runWrite } from "../safety.js";
import { renderItem } from "../render.js";
import { result, type ToolResult, type WorkItem } from "../types.js";
import type { PbiStatusArgs, TaskCreateArgs, TaskDoneArgs } from "../contract.js";
import type { Context } from "../context.js";
import { adoProject, fail, failure, routeOrError } from "./common.js";

export async function devworkTaskCreate(args: TaskCreateArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.parentId);
  if (!routed.ok) return routed.result;
  if (routed.target.backend !== "ado") return fail("task operations are Azure DevOps only", "ado only");
  const project = adoProject(ctx, routed.target.project);
  if (!project.ok) return project.result;

  const loadParent = async (refresh: boolean): Promise<WorkItem | ToolResult> => {
    try {
      return await ctx.ado.getWorkItem(routed.target.id, {
        refresh,
        cacheTtlSeconds: ctx.installation.cacheTtlSeconds,
        project: project.project,
      });
    } catch (error) {
      return failure(`failed to fetch parent ${args.parentId}`, error);
    }
  };

  const parent = await loadParent(true);
  if ("content" in parent) return parent;

  const derivedTitle = args.title ?? deriveTaskTitle(parent.title);
  const hours = args.hours ?? Number(parent.effort ?? 8);
  const existing = (parent.children ?? []).filter((child) => child.type === "Task" && child.state !== "Removed");

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_task_create",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_task_create", args as Record<string, unknown>),
    preview: async () => ({
      human: [
        `Create a child Task under #${parent.id} ${parent.title ?? ""}:`,
        `  Title:     ${derivedTitle}`,
        `  Iteration: ${parent.iteration ?? "(project default)"}`,
        `  Assigned:  ${parent.assignedTo ?? "(none)"}`,
        `  Remaining: ${hours}h`,
        ...(existing.length > 0
          ? ["", "⚠ Existing child Tasks (check for duplicates):", ...existing.map((child) => `  ${child.id} [${child.state ?? "?"}] ${child.title ?? "?"}`)]
          : []),
      ].join("\n"),
      data: {
        op: "task_create",
        parentId: parent.id,
        derived: {
          type: "Task",
          title: derivedTitle,
          state: "In Progress",
          iteration: parent.iteration ?? null,
          assignedTo: parent.assignedTo ?? null,
          remainingWork: hours,
          activity: "Development",
        },
      },
    }),
    execute: async () => {
      try {
        const task = await ctx.ado.createItem({
          type: "Task",
          title: derivedTitle,
          state: "In Progress",
          project: project.project,
          parentId: parent.id,
          description: `Child of #${parent.id} ${parent.title ?? ""}`.trim(),
          ...(parent.assignedTo !== undefined ? { assignedTo: parent.assignedTo } : {}),
          ...(parent.iteration !== undefined ? { iteration: parent.iteration } : {}),
          fields: {
            "Microsoft.VSTS.Common.Activity": "Development",
            "Microsoft.VSTS.Scheduling.RemainingWork": String(hours),
          },
        });
        return result(
          [
            `✅ Created Task #${task.id}: ${task.title}`,
            `Parent: #${parent.id} ${parent.title ?? ""}`,
            `State: In Progress | Remaining: ${hours}h | Assigned: ${task.assignedTo ?? "–"}`,
            task.url ?? "",
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
          { backend: "ado", item: task },
        );
      } catch (error) {
        return failure("task create failed", error);
      }
    },
  });
}

export function deriveTaskTitle(parentTitle: string | undefined): string {
  if (!parentTitle) return "Implement";
  const match = parentTitle.match(/^\[([^\]]+)\]\s*(.+)$/);
  return `Implement ${match ? match[2] : parentTitle}`.trim();
}

export async function devworkTaskDone(args: TaskDoneArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref);
  if (!routed.ok) return routed.result;
  if (routed.target.backend !== "ado") return fail("task operations are Azure DevOps only", "ado only");
  const project = adoProject(ctx, routed.target.project);
  if (!project.ok) return project.result;

  let task: WorkItem;
  try {
    task = await ctx.ado.getWorkItem(routed.target.id, { refresh: true, cacheTtlSeconds: 0, project: project.project });
  } catch (error) {
    return failure(`failed to fetch task ${args.ref}`, error);
  }
  if (task.type && task.type.toLowerCase() !== "task") {
    return fail(`#${task.id} is a ${task.type}, not a Task — use devwork_update instead`, "not a task");
  }
  const completed = args.completedHours ?? Number(task.remaining ?? 0);

  return runWrite({
    installation: ctx.installation,
    store: ctx.store,
    tool: "devwork_task_done",
    args: args as Record<string, unknown>,
    required: requiredOperations("devwork_task_done", args as Record<string, unknown>),
    preview: async () => ({
      human: [
        `Mark Task #${task.id} ${task.title ?? ""} Done:`,
        `  State: ${task.state ?? "?"} → Done`,
        `  CompletedWork: ${completed}h (remaining now: ${task.remaining ?? "0"}h)`,
      ].join("\n"),
      data: { op: "task_done", id: task.id, completedWork: completed },
    }),
    execute: async () => {
      try {
        const done = await ctx.ado.updateItem({
          id: task.id,
          state: "Done",
          project: project.project,
          fields: { "Microsoft.VSTS.Scheduling.CompletedWork": String(completed) },
        });
        return result(`✅ Task #${done.id} [${done.state}] ${done.title} — completed ${completed}h`, { backend: "ado", item: done });
      } catch (error) {
        return failure("task done failed", error);
      }
    },
  });
}

export async function devworkPbiStatus(args: PbiStatusArgs, ctx: Context): Promise<ToolResult> {
  const routed = routeOrError(ctx, args.ref);
  if (!routed.ok) return routed.result;
  if (routed.target.backend !== "ado") return fail("task operations are Azure DevOps only", "ado only");
  const project = adoProject(ctx, routed.target.project);
  if (!project.ok) return project.result;
  try {
    const item = await ctx.ado.getWorkItem(routed.target.id, {
      cacheTtlSeconds: ctx.installation.cacheTtlSeconds,
      project: project.project,
    });
    return result(renderItem(item), { backend: "ado", item });
  } catch (error) {
    return failure("failed to read the work item", error);
  }
}
