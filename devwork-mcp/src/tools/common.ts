/**
 * Small helpers shared by the tool handlers: routing with scope enforcement,
 * repository resolution and uniform failure results. Every handler routes,
 * checks scope and only then touches a provider.
 */
import type { Context } from "../context.js";
import { defaultAdoProject, defaultGithubRepo, checkRepo, checkTarget } from "../scope.js";
import { parseRef, unroutableMessage, type RouteTarget } from "../route.js";
import { redact } from "../redact.js";
import { result, type Backend, type ToolResult } from "../types.js";

export type Routed = { ok: true; target: RouteTarget } | { ok: false; result: ToolResult };

/** Route a reference and enforce the installation scope in one step. */
export function routeOrError(ctx: Context, ref: string, kindHint?: "item" | "pr"): Routed {
  const target = parseRef(ref, ctx.table, kindHint);
  if (!target) return { ok: false, result: result(unroutableMessage(ref, ctx.table), { error: `unroutable ref: ${ref}` }, true) };
  const scope = checkTarget(ctx.installation, target);
  if (!scope.ok) return { ok: false, result: result(scope.reason ?? "out of scope", { error: scope.reason ?? "out of scope" }, true) };
  return { ok: true, target };
}

export function enabledBackend(ctx: Context, requested: Backend | undefined): Backend {
  return requested ?? ctx.installation.defaultBackend;
}

export function fail(message: string, error = message): ToolResult {
  return result(message, { error }, true);
}

export function failure(prefix: string, error: unknown): ToolResult {
  const message = redact(error instanceof Error ? error.message : String(error));
  return result(`${prefix}: ${message}`, { error: message }, true);
}

/** Resolve and authorize a GitHub repository for this installation. */
export function githubRepo(ctx: Context, provided: string | undefined, fallback?: string): { ok: true; repo: string } | { ok: false; result: ToolResult } {
  const repo = provided ?? fallback ?? defaultGithubRepo(ctx.installation);
  if (!repo) {
    return {
      ok: false,
      result: fail(
        "a GitHub repository is required: pass owner/repo, use an owner/repo#N reference or a github.com URL, or set github.defaultRepo in the installation profile",
        "repo required",
      ),
    };
  }
  const scope = checkRepo(ctx.installation, repo);
  if (!scope.ok) return { ok: false, result: fail(scope.reason ?? "out of scope", "out of scope") };
  return { ok: true, repo };
}

/** Resolve and authorize an ADO project (the installation default when unset). */
export function adoProject(ctx: Context, provided?: string): { ok: true; project: string } | { ok: false; result: ToolResult } {
  const project = provided ?? defaultAdoProject(ctx.installation);
  if (!project) {
    return {
      ok: false,
      result: fail("no Azure DevOps project selected: set ado.project in the installation profile or name it in the reference", "project required"),
    };
  }
  const scope = checkTarget(ctx.installation, { backend: "ado", kind: "item", id: "0", project });
  if (!scope.ok) return { ok: false, result: fail(scope.reason ?? "out of scope", "out of scope") };
  return { ok: true, project };
}
