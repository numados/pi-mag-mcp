/** Shared plumbing for repo-mcp tool handlers: the handler/argument types,
 *  the fixed-argv result and failure builders, the bounded git-run helper, the
 *  ignored-content guard, and the trust-boundary text every executable tier
 *  cites verbatim. No tier group imports another group — only this module.
 */

import { git } from "../exec.js";
import { result, type ToolResult } from "../types.js";
import { ValidationError } from "../validate.js";

export type ToolArgs = Record<string, unknown>;
export type ToolHandler = (args: ToolArgs, signal?: AbortSignal) => Promise<ToolResult>;

export function fail(msg: string): ToolResult {
  return result(msg, { error: msg }, true);
}

export function failV(e: unknown): ToolResult {
  return e instanceof ValidationError ? fail(e.message) : fail(String((e as Error)?.message ?? e));
}

/** Run one fixed git argv in the resolved repo; error envelope on nonzero.
 *  Discriminated by `ok` so the success path carries stdout/truncated and the
 *  failure path carries the ToolResult. */
export type GitRun =
  | { ok: true; stdout: string; truncated: boolean }
  | { ok: false; res: ToolResult };

export async function gitRun(root: string, args: string[], signal?: AbortSignal): Promise<GitRun> {
  const r = await git({ cwd: root, args, signal });
  // A bounded prefix does not turn failure or cancellation into success.
  if (r.code !== 0 || r.aborted) {
    const why = r.aborted ? "cancelled" : `exit code ${r.code}`;
    const tail = (r.stdout.slice(-2000) || r.stderr.slice(-2000) || "(no output)").trim();
    return { ok: false, res: result(`git ${args[0]} failed (${why}):\n${tail}`, { error: why, output: r.stdout || r.stderr }, true) };
  }
  return { ok: true, stdout: r.stdout, truncated: r.truncated };
}

export async function refuseIgnoredContent(root: string, signal?: AbortSignal): Promise<void> {
  const r = await git({ cwd: root, args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], signal });
  if (r.code !== 0 || r.aborted || r.truncated) throw new ValidationError(`cannot check ignored files: ${r.stderr || "incomplete or cancelled output"}`);
  if (r.stdout.length) throw new ValidationError("operation refused: ignored local files are present and could be overwritten; preserve them outside the repository before retrying");
}

export const TRUST_BOUNDARY =
  "Trust boundary: git hooks and repository config (commit.gpgsign, hooks, aliases in config) execute as part of this operation exactly as on your machine — repo-mcp does not bypass or sandbox them.";
