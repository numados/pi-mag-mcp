/** Tool surface composition facade (repo-mcp-policy.md §6).
 *
 *  The tool metadata (names, titles, descriptions, schemas, tiers) lives in
 *  contract.ts. Each tier's handlers live in src/tools/:
 *
 *    common.ts          — ToolArgs/ToolHandler, failure/result plumbing,
 *                         gitRun, ignored-content guard, trust-boundary text
 *    read.ts            — git_status..git_refs (8 read handlers)
 *    allowed.ts         — git_fetch / git_pull / git_commit
 *    approval-engine.ts — ApprovalSpec + runApproval + preview notice
 *    approval.ts        — the seven local-mutation approval specs
 *    generation.ts      — branch_plan / commit_message adapters
 *    status.ts          — repo_status handler + repoStatusReport
 *
 *  This file only binds those group maps to the contract metadata and applies
 *  the withGitSignal/cancellation/error wrapper exactly once per handler.
 *  Trust boundary (documented, not claimed to be sandboxed): git hooks and
 *  repository config run as part of fetch/pull/commit/merge/… exactly as they
 *  would on the user's machine. This server does not bypass them and does not
 *  sandbox them — it only refuses to add anything beyond the validated
 *  operation itself.
 */

import { TOOLS, type ToolContract } from "./contract.js";
import { withGitSignal } from "./exec.js";
import { allowedHandlers } from "./tools/allowed.js";
import { approvalHandlers } from "./tools/approval.js";
import { fail, failV, type ToolHandler } from "./tools/common.js";
import { generationHandlers } from "./tools/generation.js";
import { readHandlers } from "./tools/read.js";
import { statusHandlers } from "./tools/status.js";

export type { ToolArgs, ToolHandler } from "./tools/common.js";
export type { RepoStatusReport } from "./tools/status.js";
export { repoStatusReport } from "./tools/status.js";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  handler: ToolHandler;
}

function wrap(handler: ToolHandler): ToolHandler {
  return (p, signal) => withGitSignal(signal, async () => {
    if (signal?.aborted) return fail("cancelled before execution");
    try { return await handler(p, signal); } catch (e) { return failV(e); }
  });
}

const handlers = new Map<string, ToolHandler>();
for (const [name, handler] of [
  ...readHandlers,
  ...allowedHandlers,
  ...approvalHandlers,
  ...generationHandlers,
  ...statusHandlers,
]) {
  handlers.set(name, wrap(handler));
}

function handlerFor(name: string): ToolHandler {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler;
}

export function toolDefs(): ToolDef[] {
  return TOOLS.map((t: ToolContract) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    handler: handlerFor(t.name),
  }));
}

export function toolNames(): string[] {
  return TOOLS.map((t) => t.name);
}
