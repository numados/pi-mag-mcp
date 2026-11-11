/** Per-repo knowledge routing. `.knowledge-mcp.json` at the repo root declares
 *  where THIS repo's knowledge lives in the central vault (task workspace
 *  root) and the repo identity used for knowledge-network queries.
 *
 *  Central config (config.ts) owns vaults; the repo layer points a checkout
 *  at its slice of the vault — cross-repo knowledge stays central, per-repo
 *  concerns stay in the repo. A repository-controlled file can only select a
 *  registered source and vault-relative directories; it can never override
 *  central paths, the write gate or qmd.
 *
 *  The git root is located with an argv `spawnSync` — never a shell — so a
 *  repo directory containing spaces or `$(…)` is a literal argument. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPlainObject } from "./types.js";
import type { RepoContext, RepoKnowledgeConfig } from "./types.js";

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  // git root first (works for worktrees/submodules)
  if (existsSync(startDir)) {
    const r = spawnSync("git", ["-C", startDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const out = r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    if (out) return out;
  }
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadRepoContext(startDir: string = process.cwd()): RepoContext {
  const repoRoot = findRepoRoot(startDir);
  const configPath = repoRoot ? join(repoRoot, ".knowledge-mcp.json") : null;
  const config: RepoKnowledgeConfig = {};
  if (configPath && existsSync(configPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (isPlainObject(raw)) {
        for (const key of ["vault", "taskRoot", "knowledgeRoot"] as const) {
          const v = raw[key];
          if (typeof v === "string") config[key] = v;
        }
        const repo = raw.repo;
        if (isPlainObject(repo)) {
          const repoCfg: NonNullable<RepoKnowledgeConfig["repo"]> = {};
          for (const key of ["name", "path"] as const) {
            const v = repo[key];
            if (typeof v === "string") repoCfg[key] = v;
          }
          config.repo = repoCfg;
        }
      }
    } catch {
      // malformed repo config — surfaced by the doctor, not fatal here
    }
  }
  return { repoRoot, config, configPath };
}

/** Resolve the task workspace root for knowledge_task calls:
 *  explicit arg > repo .knowledge-mcp.json > central config defaultTaskRoot. */
export function resolveTaskRoot(
  explicit: string | undefined,
  repoCtx: RepoContext,
  centralDefault: string | undefined,
): string {
  const root = explicit ?? repoCtx.config.taskRoot ?? centralDefault;
  if (!root) {
    throw new Error(
      `no task root: pass taskRoot=<vault-relative dir with <TICKET>/ workspaces>, or add ` +
        `{"taskRoot": "search/tasks"} to ${repoCtx.configPath ?? ".knowledge-mcp.json in the repo root"}`,
    );
  }
  return root.replace(/^\/+/, "");
}

export function repoName(repoCtx: RepoContext, explicit?: string): string | undefined {
  return explicit ?? repoCtx.config.repo?.name ?? (repoCtx.repoRoot ? repoCtx.repoRoot.split("/").pop() : undefined);
}
