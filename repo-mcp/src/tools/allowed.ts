/** Allowed-tier handlers (repo-mcp-policy.md §6): git_fetch (plain), git_pull
 *  (--ff-only only), git_commit (staged only, supplied message only). These
 *  handlers are RAW — src/tools.ts applies the shared cancellation/error
 *  wrapper exactly once per handler.
 */

import { checkStagedFileSize, formatSizeViolations } from "../agent-file-size.js";
import { git } from "../exec.js";
import { stagedFromPorcelain } from "../generate.js";
import { resolveRepo, type RepoCtx } from "../repo.js";
import { result } from "../types.js";
import { ValidationError, previewCommand, validateMessage, validateRef, validateRemote } from "../validate.js";
import { TRUST_BOUNDARY, fail, failV, gitRun, refuseIgnoredContent, type ToolArgs, type ToolHandler } from "./common.js";

async function gitFetch(p: ToolArgs, signal?: AbortSignal) {
  let ctx: RepoCtx;
  let args: string[];
  try {
    ctx = await resolveRepo(p.repo);
    const remote = p.remote === undefined ? "origin" : validateRemote(p.remote);
    args = ["fetch", remote];
  } catch (e) {
    return failV(e);
  }
  const r = await gitRun(ctx.root, args, signal);
  if (!r.ok) return r.res;
  return result(`fetched (git ${args.join(" ")}):\n${r.stdout.trim() || "(no new objects)"}`, {
    mode: "allowed",
    repo: ctx.root,
    output: r.stdout,
    truncated: r.truncated,
    command: previewCommand(args),
  });
}

async function gitPull(p: ToolArgs, signal?: AbortSignal) {
  let ctx: RepoCtx;
  let args: string[];
  try {
    ctx = await resolveRepo(p.repo);
    const remote = p.remote === undefined ? null : validateRemote(p.remote);
    const branch = p.branch === undefined ? null : validateRef(p.branch, "branch");
    if (branch && !remote) throw new ValidationError("pass remote together with branch (branch alone is not accepted)");
    await refuseIgnoredContent(ctx.root, signal);
    args = ["pull", "--ff-only", ...(remote ? [remote] : []), ...(branch ? [branch] : [])];
  } catch (e) {
    return failV(e);
  }
  const r = await gitRun(ctx.root, args, signal);
  if (!r.ok) return r.res;
  return result(`pulled (fast-forward only):\n${r.stdout.trim() || "(already up to date)"}`, {
    mode: "allowed",
    repo: ctx.root,
    output: r.stdout,
    truncated: r.truncated,
    command: previewCommand(args),
  });
}

async function gitCommit(p: ToolArgs, signal?: AbortSignal) {
  let ctx: RepoCtx;
  let message: string;
  try {
    ctx = await resolveRepo(p.repo);
    message = validateMessage(p.message);
  } catch (e) {
    return failV(e);
  }
  const st = await gitRun(ctx.root, ["status", "--porcelain=v1"], signal);
  if (!st.ok) return st.res;
  const staged = stagedFromPorcelain(st.stdout);
  if (staged.length === 0) {
    return fail(
      "nothing staged — git_commit commits ONLY staged changes and stages nothing itself. Stage files explicitly first (the server never runs git add on your behalf); unstaged/untracked files are left alone.",
    );
  }
  const sizeCheck = await checkStagedFileSize(ctx.root, signal);
  if (sizeCheck.violations.length > 0) return fail(formatSizeViolations(sizeCheck));
  const args = ["commit", "-m", message];
  const r = await git({ cwd: ctx.root, args, signal });
  const out = (r.stdout.trim() || r.stderr.trim()).trim();
  if (r.code !== 0 || r.aborted) {
    const why = r.aborted ? "cancelled" : `exit code ${r.code}`;
    return result(`git commit failed (${why}):\n${out.slice(-3000)}`, { mode: "allowed", repo: ctx.root, error: why, output: out.slice(-3000) }, true);
  }
  const head = await git({ cwd: ctx.root, args: ["rev-parse", "HEAD"] });
  return result(
    `✅ committed staged changes (${staged.length} path${staged.length === 1 ? "" : "s"}):\n${out}\n\nnew HEAD: ${head.stdout.trim()}\n${TRUST_BOUNDARY}`,
    { mode: "allowed", repo: ctx.root, output: out, stagedCount: staged.length, head: head.stdout.trim(), command: previewCommand(args) },
  );
}

export const allowedHandlers = new Map<string, ToolHandler>([
  ["git_fetch", gitFetch],
  ["git_pull", gitPull],
  ["git_commit", gitCommit],
]);
