/** Approval-tier handler specs (repo-mcp-policy.md §1 APPROVAL-REQUIRED, §6):
 *  branch_create, merge, rebase, reset, restore, switch, destructive_local.
 *  Each spec validates its own inputs and hands validated canonical fields to
 *  runApproval. Handlers are RAW — src/tools.ts applies the shared wrapper.
 */

import { detectDefaultBranch } from "../defaults.js";
import { git } from "../exec.js";
import { resolveRepo, type RepoCtx } from "../repo.js";
import { ValidationError, validateBranchName, validatePathArg, validateRef } from "../validate.js";
import { runApproval } from "./approval-engine.js";
import { fail, failV, type ToolArgs, type ToolHandler } from "./common.js";

type BranchCreateFields = { name: string; base: string };
type MergeFields = { ref: string };
type RebaseFields = { base?: string };
type ResetFields = { mode: "soft" | "mixed" | "hard"; ref?: string };
type RestoreFields = { paths: string[]; ref?: string };
type SwitchFields = { branch: string };
type DestructiveFields =
  | { action: "clean"; paths: string[] }
  | { action: "branch_delete_force"; name: string };

async function branchCreate(p: ToolArgs, signal?: AbortSignal) {
  let ctx: RepoCtx;
  try {
    ctx = await resolveRepo(p.repo);
    const name = validateBranchName(p.name);
    let base: string;
    let baseHow: string;
    if (p.base !== undefined) {
      base = validateRef(p.base, "base");
      baseHow = "explicitly supplied";
    } else {
      const d = await detectDefaultBranch(ctx.root);
      base = d.branch;
      baseHow = d.how;
    }
    if (base === name) return fail("refusing to create a branch with the same name as its base");
    return runApproval<BranchCreateFields>(
      {
        tool: "branch_create",
        fields: () => ({ name, base }),
        argv: (f) => ["switch", "--no-overwrite-ignore", "-c", f.name, f.base],
        human: (f) => `Create branch ${f.name} from ${f.base} (${baseHow})`,
      },
      p,
      signal,
    );
  } catch (e) {
    return failV(e);
  }
}

function merge(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<MergeFields>(
    {
      tool: "merge",
      fields: (_ctx, pp) => ({ ref: validateRef(pp.ref) }),
      argv: (f) => ["merge", "--no-edit", f.ref],
      human: (f) => `Merge ${f.ref} into the current branch`,
    },
    p,
    signal,
  );
}

function rebase(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<RebaseFields>(
    {
      tool: "rebase",
      fields: (_ctx, pp): RebaseFields => (pp.base === undefined ? {} : { base: validateRef(pp.base, "base") }),
      argv: (f) => ["rebase", ...(f.base ? [f.base] : [])],
      human: (f) => `Rebase the current branch${f.base ? ` onto ${f.base}` : " onto its configured upstream"}`,
    },
    p,
    signal,
  );
}

function reset(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<ResetFields>(
    {
      tool: "reset",
      fields: (_ctx, pp): ResetFields => {
        const rawMode = pp.mode ?? "mixed";
        if (rawMode !== "soft" && rawMode !== "mixed" && rawMode !== "hard") {
          throw new ValidationError("mode must be soft | mixed | hard");
        }
        const mode = rawMode as "soft" | "mixed" | "hard";
        return pp.ref === undefined ? { mode } : { mode, ref: validateRef(pp.ref) };
      },
      argv: (f) => ["reset", `--${f.mode}`, ...(f.ref ? [f.ref] : [])],
      human: (f) => `Reset the current branch to ${f.ref ?? "HEAD"} (${f.mode}${f.mode === "hard" ? " — DISCARDS uncommitted worktree changes" : ""})`,
    },
    p,
    signal,
  );
}

function restore(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<RestoreFields>(
    {
      tool: "restore",
      fields: (ctx, pp): RestoreFields => {
        if (!Array.isArray(pp.paths) || pp.paths.length === 0) throw new ValidationError("paths must be a non-empty array of in-repo paths");
        const rels = pp.paths.map((x: unknown) => validatePathArg(ctx.root, ctx.fromDir, x));
        return pp.ref === undefined ? { paths: rels } : { paths: rels, ref: validateRef(pp.ref) };
      },
      argv: (f) => ["restore", ...(f.ref ? ["--source", f.ref] : []), "--", ...f.paths],
      human: (f) => `Restore (discard changes in) ${f.paths.join(", ")}${f.ref ? ` from ${f.ref}` : ""}`,
    },
    p,
    signal,
  );
}

function switch_(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<SwitchFields>(
    {
      tool: "switch",
      fields: (_ctx, pp) => ({ branch: validateBranchName(pp.branch) }),
      argv: (f) => ["switch", "--no-overwrite-ignore", f.branch],
      human: (f) => `Switch the working tree to branch ${f.branch}`,
    },
    p,
    signal,
  );
}

function destructiveLocal(p: ToolArgs, signal?: AbortSignal) {
  return runApproval<DestructiveFields>(
    {
      tool: "destructive_local",
      fields: (ctx, pp): DestructiveFields => {
        const action = pp.action;
        if (action === "clean") {
          if (!Array.isArray(pp.paths) || pp.paths.length === 0) throw new ValidationError("action 'clean' requires paths: non-empty array of in-repo untracked paths");
          const rels = pp.paths.map((x: unknown) => validatePathArg(ctx.root, ctx.fromDir, x));
          if (pp.name !== undefined) throw new ValidationError("name is only valid for action branch_delete_force");
          return { action, paths: rels };
        }
        if (action === "branch_delete_force") {
          if (pp.paths !== undefined) throw new ValidationError("paths are only valid for action clean");
          return { action, name: validateBranchName(pp.name) };
        }
        throw new ValidationError("action must be 'clean' or 'branch_delete_force'");
      },
      argv: (f) =>
        f.action === "clean"
          ? ["clean", "-f", "-d", "--", ...f.paths]
          : ["branch", "-D", f.name],
      human: (f) =>
        f.action === "clean"
          ? `IRREVERSIBLY DELETE untracked files under: ${f.paths.join(", ")} (git clean -f -d, no -x)`
          : `IRREVERSIBLY DELETE branch ${f.name} (git branch -D)`,
      dryRun: async (root, f) => {
        if (f.action !== "clean") return null;
        const d = await git({ cwd: root, args: ["clean", "-n", "-d", "--", ...f.paths] });
        return d.code === 0 ? d.stdout : `dry-run failed (exit ${d.code}): ${d.stderr.trim()}`;
      },
    },
    p,
    signal,
  );
}

export const approvalHandlers = new Map<string, ToolHandler>([
  ["branch_create", branchCreate],
  ["merge", merge],
  ["rebase", rebase],
  ["reset", reset],
  ["restore", restore],
  ["switch", switch_],
  ["destructive_local", destructiveLocal],
]);
