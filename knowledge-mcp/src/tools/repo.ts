/** knowledge_repo — the knowledge network around a repository: task
 *  workspaces whose index lists the repo (canonical `repository` or legacy
 *  `repos[]`), concept notes mentioning it under the configured knowledge
 *  roots, and the repo-index catalog line when present. Body mentions never
 *  count as task membership, and matching never depends on YAML quoting
 *  (indexes are parsed, not grepped). */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LIMITS, type RepoArgs } from "../contract.js";
import { err, text, type ToolContext } from "../context.js";
import { parseNote } from "../md.js";
import { displayRel, renderRepoMap, type RepoTaskLine } from "../render.js";
import { repoName } from "../repo-config.js";
import type { ToolResult } from "../types.js";

const metaCharsEscaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function knowledgeRepo(a: RepoArgs, ctx: ToolContext): Promise<ToolResult> {
  const name = repoName(ctx.repoCtx, a.repo);
  if (!name) {
    return err("repo name unknown — pass repo= or add .knowledge-mcp.json {repo:{name}} at the repo root");
  }
  const limit = Math.min(a.limit ?? LIMITS.limitDefault, LIMITS.limitMax);
  const multi = ctx.source.roots.length > 1;

  // task workspaces: parse candidate indexes, match canonical or legacy repos
  const tasks: RepoTaskLine[] = [];
  for (const root of ctx.source.roots) {
    const t = await ctx.run("rg", ["--files", "--glob", "**/_task_index.md"], { cwd: root.path, timeoutMs: 15_000 });
    if (t.code !== 0) continue;
    for (const rel of t.stdout.split("\n").filter(Boolean)) {
      try {
        const fm = parseNote(readFileSync(join(root.path, rel), "utf8")).frontmatter ?? {};
        const matches = (r: unknown): boolean =>
          typeof r === "string" && (r === name || basename(r) === name);
        const listed =
          matches(fm.repository) ||
          (Array.isArray(fm.repos) &&
            fm.repos.some((r) => matches(typeof r === "string" ? r : (r as { name?: unknown })?.name)));
        if (!listed) continue;
        tasks.push({
          updated: String(fm.updated ?? "????-??-??"),
          status: String(fm.status ?? "?"),
          id: String(fm.task_id ?? fm.ticket ?? (multi ? `${root.label}/${rel}` : rel)),
          title: String(fm.title ?? "").slice(0, 70),
        });
      } catch {
        /* unreadable candidate — the source skipped it too */
      }
      if (tasks.length >= limit) break;
    }
    if (tasks.length >= limit) break;
  }

  // concept notes mentioning the repo under the configured knowledge roots
  const scopes = [...new Set([ctx.repoCtx.config.knowledgeRoot, ctx.config.knowledgeRoot].filter(Boolean) as string[])];
  const notes: string[] = [];
  for (const scope of scopes) {
    for (const root of ctx.source.roots) {
      const r = await ctx.run("rg", ["-l", "--glob", "*.md", "-e", `\\b${metaCharsEscaped(name)}\\b`], {
        cwd: join(root.path, scope),
        timeoutMs: 10_000,
      });
      if (r.code !== 0) continue;
      for (const p of r.stdout.split("\n").filter(Boolean)) {
        notes.push(displayRel(ctx.source, root, `${scope}/${p}`));
      }
    }
  }
  const uniqueNotes = [...new Set(notes)];

  // repo-index catalog line
  let catalog: { entries: number } | null = null;
  for (const root of ctx.source.roots) {
    const cat = join(root.path, "knowledge-index/repo-index/catalog.jsonl");
    if (!existsSync(cat)) continue;
    const lines = readFileSync(cat, "utf8").split("\n").filter(Boolean);
    catalog = {
      entries: lines.filter(
        (l) => l.includes(`"repo": "${name}"`) || l.includes(`"repo_id": "${name.toLowerCase()}"`),
      ).length,
    };
    break;
  }

  return text(
    renderRepoMap({
      repo: name,
      vault: multi ? ctx.source.name : ctx.source.roots[0]!.path,
      tasks,
      notes: uniqueNotes,
      catalog,
    }),
  );
}
