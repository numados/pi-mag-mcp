import type { ReposArgs } from "../contract.js";
import type { Context } from "../context.js";
import { result, type ToolResult } from "../types.js";
import { adoProject, failure } from "./common.js";

export async function devworkRepos(_args: ReposArgs, ctx: Context): Promise<ToolResult> {
  const project = adoProject(ctx);
  if (!project.ok) return project.result;
  try {
    const repos = await ctx.ado.repoList();
    const text = repos.map((repo) => `  📁 ${repo.name}  (ID: ${repo.id})  ${repo.defaultBranch ?? ""}`).join("\n");
    return result(text || "No repositories.", { backend: "ado", repos, count: repos.length });
  } catch (error) {
    return failure("repository list failed", error);
  }
}
