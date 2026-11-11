/** Generation-tier handlers (repo-mcp-policy.md §6): branch_plan and
 *  commit_message adapt the pure generators in generate.ts into tool results.
 *  Neither executes anything. Handlers are RAW — src/tools.ts applies the
 *  shared cancellation/error wrapper exactly once per handler.
 */

import { branchPlan, commitMessage } from "../generate.js";
import { result, type ToolResult } from "../types.js";
import { failV, type ToolArgs, type ToolHandler } from "./common.js";

async function branchPlanTool(p: ToolArgs): Promise<ToolResult> {
  try {
    const r = await branchPlan(p);
    return result(
      [`branch_plan (no execution)`, `base:   ${r.base} — ${r.baseHow}`, `name:   ${r.branch}`, `type:   ${r.type} · tracker ${r.tracker} · ticket ${r.ticket} (used exactly as supplied)`, ``, `command:`, `  ${r.command}`, ``, r.note].join("\n"),
      { mode: "generation", ...r },
    );
  } catch (e) {
    return failV(e);
  }
}

async function commitMessageTool(p: ToolArgs): Promise<ToolResult> {
  try {
    const r = await commitMessage(p);
    return result(
      [
        "```text",
        r.message,
        "```",
        "",
        `context used: scope=${r.scopeUsed}${r.files.length ? ` (${r.files.length} diff-stat lines)` : ""}; ticket=${r.ticket ?? "(none)"} [${r.ticketSource}]; history: ${r.historyConvention}; repo instruction files found: ${r.repoInstructionFiles.join(", ") || "(none)"}`,
        "",
        `limitation: ${r.limitation}`,
      ].join("\n"),
      { mode: "generation", ...r },
    );
  } catch (e) {
    return failV(e);
  }
}

export const generationHandlers = new Map<string, ToolHandler>([
  ["branch_plan", branchPlanTool],
  ["commit_message", commitMessageTool],
]);
