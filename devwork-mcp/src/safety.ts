/**
 * Write safety. Two independent gates:
 *
 *  1. policy — the installation decides which operation classes are allowed at
 *     all (`write.policy` + `write.allow`); `merge` is never implied.
 *  2. preview binding — a confirm call must match a preview issued for exactly
 *     these arguments, within a time limit, at most once. Without it, "show the
 *     preview, then confirm" degenerates into confirming whatever the caller
 *     likes, which is how a previewed title change becomes an unannounced merge.
 *
 * The token is a convenience for the caller, not proof that a human saw the
 * preview: a real human gate needs the host's permission policy.
 */
import { createHash, randomUUID } from "node:crypto";
import { LIMITS } from "./contract.js";
import { allowedWriteOperations, type Installation } from "./installation.js";
import { result, type ToolResult, type WriteOperation } from "./types.js";

// ── fingerprints ───────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Arguments that participate in the operation, without the approval plumbing. */
export function operationArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "confirm" || key === "approvalToken") continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function fingerprintArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(operationArguments(args)))).digest("hex");
}

// ── preview store ──────────────────────────────────────────────────────

interface PreviewRecord {
  token: string;
  installationId: string;
  tool: string;
  fingerprint: string;
  expiresAt: number;
  /** State the preview was computed against, re-checked before the mutation. */
  guard?: string;
}

export interface IssuedPreview {
  token: string;
  ttlSeconds: number;
}

export type ConsumeOutcome = { ok: true; guard?: string } | { ok: false; reason: string };

export class PreviewStore {
  private records = new Map<string, PreviewRecord>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private static key(installationId: string, tool: string, fingerprint: string): string {
    return `${installationId}\u0000${tool}\u0000${fingerprint}`;
  }

  issue(
    installationId: string,
    tool: string,
    fingerprint: string,
    ttlSeconds = LIMITS.approvalTtlSeconds,
    guard?: string,
  ): IssuedPreview {
    this.evict();
    const token = randomUUID();
    this.records.set(PreviewStore.key(installationId, tool, fingerprint), {
      token,
      installationId,
      tool,
      fingerprint,
      expiresAt: this.now() + ttlSeconds * 1000,
      ...(guard !== undefined ? { guard } : {}),
    });
    return { token, ttlSeconds };
  }

  /** Consume the preview for exactly these arguments. One use only. */
  consume(installationId: string, tool: string, fingerprint: string, token?: string): ConsumeOutcome {
    this.evict();
    const key = PreviewStore.key(installationId, tool, fingerprint);
    const record = this.records.get(key);
    if (!record) {
      return {
        ok: false,
        reason:
          "no matching preview for these arguments — call without confirm first, show the preview to the user, then confirm the same arguments",
      };
    }
    if (token === undefined || token.length === 0) {
      return {
        ok: false,
        reason: "approvalToken is required: re-call with the token returned by the preview of exactly these arguments",
      };
    }
    if (token !== record.token) {
      return { ok: false, reason: "approvalToken does not match the preview of these arguments" };
    }
    this.records.delete(key);
    return { ok: true, ...(record.guard !== undefined ? { guard: record.guard } : {}) };
  }

  size(): number {
    return this.records.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }
}

// ── policy gate ────────────────────────────────────────────────────────

/** Which operation classes a call needs. A call that changes fields and adds a
 *  comment needs both. */
export function requiredOperations(tool: string, args: Record<string, unknown>): WriteOperation[] {
  const ops = new Set<WriteOperation>();
  const hasComment = typeof args.comment === "string" && args.comment.length > 0;
  switch (tool) {
    case "devwork_create":
      ops.add("create");
      if (hasComment) ops.add("comment");
      break;
    case "devwork_task_create":
      ops.add("create");
      break;
    case "devwork_task_done":
      ops.add("update");
      break;
    case "devwork_update": {
      const fieldChange = ["title", "state", "reason", "assignedTo", "description", "area", "iteration", "fields"].some(
        (key) => args[key] !== undefined,
      );
      if (fieldChange) ops.add("update");
      if (hasComment) ops.add("comment");
      if (ops.size === 0) ops.add("update");
      break;
    }
    case "devwork_pr_create":
      ops.add("pr");
      // ADO auto-complete schedules the merge even though the PR is created now.
      if (args.autoComplete === true) ops.add("merge");
      break;
    case "devwork_pr_update":
      if (args.status === "completed" || args.autoComplete === true) ops.add("merge");
      ops.add("pr");
      break;
    case "devwork_pr_vote":
      ops.add("vote");
      break;
    default:
      break;
  }
  return [...ops];
}

export function writeGate(installation: Installation, required: WriteOperation[]): string | null {
  const allowed = allowedWriteOperations(installation.write);
  if (allowed.size === 0) {
    return `writes are disabled for this installation (write.policy is "read-only" in ${installation.source})`;
  }
  const refused = required.filter((op) => !allowed.has(op));
  if (refused.length > 0) {
    return (
      `operation ${refused.join(", ")} is not allowed for this installation — ` +
      `write.allow is [${[...allowed].join(", ")}] in ${installation.source}`
    );
  }
  return null;
}

// ── the two-phase flow ─────────────────────────────────────────────────

export interface WriteFlow {
  installation: Installation;
  store: PreviewStore;
  tool: string;
  args: Record<string, unknown>;
  required: WriteOperation[];
  /** Rendered preview and its structured payload; may read current state. */
  preview: () => Promise<{ human: string; data: Record<string, unknown>; guard?: string }>;
  /** `guard` is the state captured by the preview (e.g. a PR head SHA). */
  execute: (guard: string | undefined) => Promise<ToolResult>;
}

const PREVIEW_NOTE =
  "PREVIEW — nothing was executed. Show this to the user; re-call the same tool with the same arguments, confirm:true and this approvalToken only after explicit approval.";

export async function runWrite(flow: WriteFlow): Promise<ToolResult> {
  const gate = writeGate(flow.installation, flow.required);
  if (gate !== null) return result(gate, { error: gate }, true);

  const fingerprint = fingerprintArgs(flow.args);

  if (flow.args.confirm !== true) {
    const preview = await flow.preview();
    const issued = flow.store.issue(flow.installation.id, flow.tool, fingerprint, LIMITS.approvalTtlSeconds, preview.guard);
    return result(
      [PREVIEW_NOTE, "", preview.human, "", `next: ${flow.tool}({ ..., confirm: true, approvalToken: "${issued.token}" })`, `expires: ${issued.ttlSeconds}s`].join("\n"),
      {
        requiresConfirmation: true,
        approvalToken: issued.token,
        approvalTtlSeconds: issued.ttlSeconds,
        preview: preview.data,
      },
    );
  }

  let guard: string | undefined;
  if (flow.installation.write.requirePreview) {
    const consumed = flow.store.consume(
      flow.installation.id,
      flow.tool,
      fingerprint,
      typeof flow.args.approvalToken === "string" ? flow.args.approvalToken : undefined,
    );
    if (!consumed.ok) return result(`refused: ${consumed.reason}`, { error: consumed.reason }, true);
    guard = consumed.guard;
  }

  return flow.execute(guard);
}
