/** Approval-tier engine: the ApprovalSpec shape and the shared runApproval
 *  flow (validate → fingerprint → preview token, or consume-before-spawn →
 *  execute). Owns the preview notice text. The seven concrete specs live in
 *  approval.ts; handlers are RAW and src/tools.ts applies the shared wrapper.
 */

import { canonicalKey, consumeApproval, issueApproval } from "../approvals.js";
import { git } from "../exec.js";
import { repoState, resolveRepo, type RepoCtx, type RepoState } from "../repo.js";
import { result, type ToolResult } from "../types.js";
import { previewCommand } from "../validate.js";
import { TRUST_BOUNDARY, fail, failV, refuseIgnoredContent, type ToolArgs } from "./common.js";

const APPROVAL_NOTE = [
  "⚠️ PREVIEW — nothing executed.",
  "The CALLER must show this exact preview to the user and obtain explicit approval for this exact operation and target BEFORE confirming.",
  "confirm:true + token only transports that decision — it is NOT itself human permission, and this server cannot verify the approval conversation happened.",
  "The token is single-use, valid 5 minutes, bound to these exact arguments, this repository, this HEAD, and this working-tree state; any change requires a fresh preview.",
].join(" ");

export interface ApprovalSpec<F extends Record<string, unknown>> {
  tool: string;
  /** validate params → canonical fields used for the cache key and argv */
  fields: (ctx: { root: string; fromDir: string }, p: ToolArgs) => F;
  /** build the exact argv from validated fields */
  argv: (fields: F) => string[];
  /** human preview line */
  human: (fields: F) => string;
  /** optional extra dry-run evidence for the preview (destructive_local) */
  dryRun?: (root: string, fields: F) => Promise<string | null>;
  extraNote?: string;
}

export async function runApproval<F extends Record<string, unknown>>(spec: ApprovalSpec<F>, p: ToolArgs, signal?: AbortSignal): Promise<ToolResult> {
  let ctx: RepoCtx;
  try {
    ctx = await resolveRepo(p.repo);
  } catch (e) {
    return failV(e);
  }

  let fields: F;
  let argv: string[];
  try {
    fields = spec.fields(ctx, p);
    argv = spec.argv(fields);
  } catch (e) {
    return failV(e);
  }

  let state: RepoState;
  try {
    // Conservative guard: these operations can overwrite ignored paths, which
    // are intentionally absent from the approval fingerprint.
    if (["merge", "rebase", "restore"].includes(spec.tool) || (spec.tool === "reset" && fields.mode === "hard")) {
      await refuseIgnoredContent(ctx.root, signal);
    }
    state = await repoState(ctx.root);
  } catch (e) {
    return failV(e);
  }

  const facts = {
    repo: ctx.root,
    key: canonicalKey({ tool: spec.tool, fields }),
    head: state.head,
    digest: state.digest,
    argv,
  };

  if (p.confirm !== true) {
    let dry = "";
    if (spec.dryRun) {
      const d = await spec.dryRun(ctx.root, fields);
      if (d !== null) dry = `\n\nDry-run of the exact paths supplied:\n${d.trim() || "(clean -n lists nothing for these paths — nothing to remove)"}`;
    }
    const { token, expiresAt } = issueApproval(facts);
    const cmd = previewCommand(argv);
    return result(
      [APPROVAL_NOTE, "", `Repository: ${ctx.root}`, spec.human(fields), "", `Command (exact, run from the repository root):\n  ${cmd}${dry}`, "", `next: ${spec.tool}({ ...same args..., confirm: true, token: "${token}" })`, `token expires: ${expiresAt}`].join("\n"),
      { mode: "approval-preview", repo: ctx.root, requiresConfirmation: true, token, expiresAt, command: cmd, preview: { tool: spec.tool, fields, argv, head: state.head, statusDigest: state.digest } },
    );
  }

  // Cancellation must not burn an unused authorization token.
  if (signal?.aborted) return fail("cancelled before execution; token was not consumed");
  // confirm:true — consume BEFORE spawn so a concurrent replay cannot win.
  const consumed = consumeApproval(p.token, facts);
  if (!consumed.ok) return fail(consumed.error);

  const cmd = previewCommand(consumed.argv);
  const r = await git({ cwd: ctx.root, args: consumed.argv, signal });
  const out = (r.stdout.trim() || r.stderr.trim() || "(no output)").trim();
  if (r.code !== 0 || r.aborted) {
    const why = r.aborted ? "cancelled" : `exit code ${r.code}`;
    return result(
      `executed (approved) but git failed (${why}):\n${out.slice(-3000)}\n\nThe token was consumed — a retry needs a fresh preview.`,
      { mode: "approval-exec", repo: ctx.root, command: cmd, error: why, output: out.slice(-3000) },
      true,
    );
  }
  return result(
    `✅ executed (approved):\n  ${cmd}\n\n${out}${spec.extraNote ? `\n\n${spec.extraNote}` : ""}\n${TRUST_BOUNDARY}`,
    { mode: "approval-exec", repo: ctx.root, command: cmd, output: out },
  );
}
