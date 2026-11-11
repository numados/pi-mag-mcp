/** Default-branch detection (numados-branch §1, made server-side and cached).
 *
 *  1. `git symbolic-ref refs/remotes/origin/HEAD` — cached per toplevel 60s;
 *  2. else the local branch whose upstream is origin/master or origin/main;
 *  3. else explicit caller-supplied base only (never a guess).
 *
 *  Ambiguity (both master and main visible, or several candidates) is an
 *  error, not a heuristic — the caller must pass `base` explicitly.
 */

import { git } from "./exec.js";

export interface DefaultBranch {
  branch: string;
  how: string;
}

export class AmbiguousBaseError extends Error {}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: DefaultBranch; at: number }>();

function stripOrigin(ref: string): string {
  // full ref (refs/remotes/origin/X) or short upstream (origin/X) → X
  return ref.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
}

export async function detectDefaultBranch(root: string): Promise<DefaultBranch> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // 1. remote default
  const sym = await git({ cwd: root, args: ["symbolic-ref", "refs/remotes/origin/HEAD"] });
  if (sym.code === 0) {
    const stripped = stripOrigin(sym.stdout.trim());
    if (stripped && stripped !== sym.stdout.trim()) {
      const value = { branch: `origin/${stripped}`, how: `origin/HEAD via git symbolic-ref (cached 60s)` };
      cache.set(root, { value, at: Date.now() });
      return value;
    }
  }

  // 2. local branch tracking origin/master or origin/main
  const fer = await git({
    cwd: root,
    args: ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
  });
  if (fer.code === 0) {
    const candidates = fer.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t")[1])
      .filter((up): up is string => up === "origin/master" || up === "origin/main")
      .map((up) => stripOrigin(up));
    const unique = [...new Set(candidates)];
    if (unique.length === 1) {
      const value = { branch: `origin/${unique[0]}`, how: `tracking branch of origin/${unique[0]}` };
      cache.set(root, { value, at: Date.now() });
      return value;
    }
    if (unique.length > 1) {
      throw new AmbiguousBaseError(
        `default branch is ambiguous (both ${unique.map((b) => `origin/${b}`).join(" and ")} are tracked here) — pass base explicitly`,
      );
    }
  }

  throw new AmbiguousBaseError(
    "could not determine the default branch (no origin/HEAD, no local branch tracking origin/master or origin/main) — pass base explicitly",
  );
}
