/** Read-tier handlers (repo-mcp-policy.md §6): git_status, git_log, git_diff,
 *  git_show, git_branch_list, git_blame, git_default_branch, git_refs. Every
 *  argv is a fixed template; callers only supply values that land in fixed
 *  positions. These handlers are RAW — src/tools.ts applies the shared
 *  cancellation/error wrapper exactly once per handler.
 */

import { detectDefaultBranch } from "../defaults.js";
import { resolveRepo, type RepoCtx } from "../repo.js";
import { result, type ToolResult } from "../types.js";
import { ValidationError, previewCommand, validatePathArg, validateRef } from "../validate.js";
import { fail, failV, gitRun, type ToolArgs, type ToolHandler } from "./common.js";

async function readTool(
  p: ToolArgs,
  build: (ctx: { root: string; fromDir: string }) => string[],
  signal?: AbortSignal,
  render?: (out: string) => string,
): Promise<ToolResult> {
  let ctx: RepoCtx;
  try {
    ctx = await resolveRepo(p.repo);
  } catch (e) {
    return failV(e);
  }
  let args: string[];
  try {
    args = build(ctx);
  } catch (e) {
    return failV(e);
  }
  const r = await gitRun(ctx.root, args, signal);
  if (!r.ok) return r.res;
  const out = r.stdout.trimEnd();
  return result((render ? render(out) : out) || "(no output)", {
    mode: "read",
    repo: ctx.root,
    output: out,
    truncated: r.truncated,
    command: previewCommand(args),
  });
}

function gitStatus(p: ToolArgs, signal?: AbortSignal) {
  return readTool(p, () => ["status", "--porcelain=v1", "-b"], signal);
}

function gitLog(p: ToolArgs, signal?: AbortSignal) {
  return readTool(
    p,
    (ctx) => {
      let n = 20;
      if (p.limit !== undefined) {
        const limit = p.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit)) {
          throw new ValidationError("limit must be an integer 1..500");
        }
        if (limit < 1 || limit > 500) {
          throw new ValidationError("limit must be an integer 1..500");
        }
        n = limit;
      }
      const rel = p.path === undefined ? null : validatePathArg(ctx.root, ctx.fromDir, p.path);
      return ["log", "--oneline", "--decorate=short", "-n", String(n), ...(rel ? ["--", rel] : [])];
    },
    signal,
  );
}

function gitDiff(p: ToolArgs, signal?: AbortSignal) {
  return readTool(
    p,
    (ctx) => {
      if (p.staged === true && p.base !== undefined) throw new ValidationError("pass either staged:true or base, not both");
      const base = p.base === undefined ? null : validateRef(p.base, "base");
      const rel = p.path === undefined ? null : validatePathArg(ctx.root, ctx.fromDir, p.path);
      return ["diff", ...(p.staged === true ? ["--cached"] : []), ...(base ? [base] : []), ...(rel ? ["--", rel] : [])];
    },
    signal,
  );
}

function gitShow(p: ToolArgs, signal?: AbortSignal) {
  return readTool(
    p,
    (ctx) => {
      const ref = p.ref === undefined ? "HEAD" : validateRef(p.ref);
      const rel = p.path === undefined ? null : validatePathArg(ctx.root, ctx.fromDir, p.path);
      return ["show", ref, ...(rel ? ["--", rel] : [])];
    },
    signal,
  );
}

function gitBranchList(p: ToolArgs, signal?: AbortSignal) {
  return readTool(
    p,
    () => ["for-each-ref", "--format=%(HEAD)\t%(refname)\t%(objectname:short)\t%(upstream:short)", "refs/heads", "refs/remotes"],
    signal,
    (out) =>
      out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const parts = l.split("\t");
          const head = parts[0] ?? "";
          const ref = parts[1] ?? "";
          const sha = parts[2] ?? "";
          const up = parts[3] ?? "";
          return `${head ? "*" : " "} ${ref.padEnd(48)} ${sha.slice(0, 10)}${up ? `  → ${up}` : ""}`;
        })
        .join("\n"),
  );
}

function gitBlame(p: ToolArgs, signal?: AbortSignal) {
  return readTool(
    p,
    (ctx) => {
      const rel = validatePathArg(ctx.root, ctx.fromDir, p.path);
      const ref = p.ref === undefined ? null : validateRef(p.ref);
      // blame takes a literal filename, not a pathspec expression.
      return ["blame", "--porcelain", ...(ref ? [ref] : []), "--", rel.slice(":(literal)".length)];
    },
    signal,
  );
}

async function gitDefaultBranch(p: ToolArgs) {
  let ctx: RepoCtx;
  try {
    ctx = await resolveRepo(p.repo);
  } catch (e) {
    return failV(e);
  }
  try {
    const d = await detectDefaultBranch(ctx.root);
    return result(`default branch: ${d.branch}\ndetermined by: ${d.how}`, { mode: "read", repo: ctx.root, branch: d.branch, base: d.branch });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function gitRefs(p: ToolArgs, signal?: AbortSignal) {
  return readTool(p, () => {
    const rawKind = p.kind ?? "all";
    if (typeof rawKind !== "string") {
      throw new ValidationError("kind must be one of: heads, remotes, tags, all");
    }
    if (!["heads", "remotes", "tags", "all"].includes(rawKind)) {
      throw new ValidationError("kind must be one of: heads, remotes, tags, all");
    }
    const scopes = rawKind === "all" ? ["refs/heads", "refs/remotes", "refs/tags"] : [`refs/${rawKind}`];
    return ["for-each-ref", "--format=%(refname)\t%(objectname:short)\t%(objecttype)", ...scopes];
  }, signal);
}

export const readHandlers = new Map<string, ToolHandler>([
  ["git_status", gitStatus],
  ["git_log", gitLog],
  ["git_diff", gitDiff],
  ["git_show", gitShow],
  ["git_branch_list", gitBranchList],
  ["git_blame", gitBlame],
  ["git_default_branch", gitDefaultBranch],
  ["git_refs", gitRefs],
]);
