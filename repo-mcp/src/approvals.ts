/** Two-step approval tokens (repo-mcp-policy.md §1 APPROVAL-REQUIRED, §5.5).
 *
 *  Flow: an approval-tier tool called WITHOUT confirm:true validates every
 *  argument, builds the exact argv, fingerprints the repository (HEAD +
 *  status/index plumbing + the BYTES of modified/untracked content — see
 *  repo.ts) and issues an opaque random token. Re-calling with confirm:true +
 *  that token executes ONLY when:
 *
 *    - the token exists and is unexpired (TTL 5 minutes);
 *    - the canonical validated arguments are identical to the previewed ones;
 *    - the repository is the same one, at the same HEAD;
 *    - the working tree is content-identical (byte-level digest).
 *
 *  A token is single-use: it is deleted from the cache BEFORE the child
 *  process is spawned, so a concurrent replay of the same token can never
 *  execute twice. Definitely-expired entries are pruned on every issuance so
 *  the cache cannot grow without bound across a long session.
 *
 *  TRUST BOUNDARY (stated in every preview): confirm:true + token is a
 *  transport for a decision, not the decision itself. The CALLER (agent) must
 *  show the preview to the human user and obtain explicit approval for the
 *  exact operation and target before confirming. This server cannot see or
 *  verify that conversation happened.
 */

import { createHash, randomBytes } from "node:crypto";

export const TTL_MS = 5 * 60_000;

export interface ApprovalFacts {
  repo: string;
  /** canonical JSON of the validated params — identical call required */
  key: string;
  head: string;
  digest: string;
  argv: string[];
}

interface Pending extends ApprovalFacts {
  expiresAt: number;
  /** monotonic issue order for diagnostics */
  seq: number;
}

const pending = new Map<string, Pending>();
let seq = 0;

let clock: () => number = () => Date.now();

/** tests only: virtual clock for expiry checks */
export function setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export function canonicalKey(params: Record<string, unknown>): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(record).sort()) o[k] = stable(record[k]);
      return o;
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(params))).digest("hex");
}

export function issueApproval(facts: ApprovalFacts): { token: string; expiresAt: string } {
  // Prune definitely-expired entries (same expiry notion as consumeApproval)
  // so the single-use cache cannot grow without bound across a long session.
  const now = clock();
  for (const [t, e] of pending) {
    if (now > e.expiresAt) pending.delete(t);
  }
  const token = randomBytes(24).toString("hex");
  pending.set(token, { ...facts, expiresAt: clock() + TTL_MS, seq: ++seq });
  return { token, expiresAt: new Date(clock() + TTL_MS).toISOString() };
}

export type ConsumeResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: string };

export function consumeApproval(token: unknown, facts: ApprovalFacts): ConsumeResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, error: "confirm:true requires the approval token from the preview response (token field)" };
  }
  const entry = pending.get(token);
  // Single use: delete FIRST, before any validation — a racing duplicate call
  // finds nothing, and a failed confirmation never leaves a reusable token.
  pending.delete(token);
  if (!entry) {
    return { ok: false, error: `unknown, expired, or already-used approval token (${token.slice(0, 8)}…) — request a fresh preview and re-confirm within ${Math.round(TTL_MS / 1000)}s` };
  }
  if (clock() > entry.expiresAt) {
    return { ok: false, error: `approval token expired (TTL ${Math.round(TTL_MS / 1000)}s) — request a fresh preview` };
  }
  if (entry.repo !== facts.repo) {
    return { ok: false, error: `approval token was issued for repository ${entry.repo}, not ${facts.repo} — request a fresh preview` };
  }
  if (entry.key !== facts.key) {
    return { ok: false, error: "arguments differ from the approved preview — request a fresh preview for the new arguments" };
  }
  if (entry.head !== facts.head) {
    return { ok: false, error: `repository HEAD moved since the preview (${entry.head.slice(0, 10)}… → ${facts.head.slice(0, 10)}…) — request a fresh preview` };
  }
  if (entry.digest !== facts.digest) {
    return { ok: false, error: "working tree changed since the preview (staged/unstaged/untracked state differs) — request a fresh preview" };
  }
  return { ok: true, argv: entry.argv };
}

/** tests/diagnostics only */
export function pendingCount(): number {
  return pending.size;
}
