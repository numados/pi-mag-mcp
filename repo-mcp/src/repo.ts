/** Repo resolution and state fingerprinting.
 *
 *  Every tool starts here: the optional `repo` param (default: server cwd) is
 *  validated to be a real git working tree via `git rev-parse --show-toplevel`,
 *  and ALL commands are then bound to that resolved toplevel — a caller naming
 *  a subdirectory still gets repo-rooted execution with repo-rooted paths.
 *
 *  repoState() produces the approval fingerprint. It binds CONTENT, not just
 *  status shape — a porcelain-only digest was blind to edits that leave the
 *  status output byte-identical (re-editing an already-modified file,
 *  re-staging different content, rewriting an untracked file). The digest
 *  now hashes:
 *
 *    1. the HEAD commit id;
 *    2. raw `git status --porcelain=v1 -z --untracked-files=all` bytes
 *       (NUL-separated: paths with spaces/newlines/quotes cannot be spoofed,
 *       and -uall enumerates every untracked FILE instead of collapsed dirs);
 *    3. raw `git ls-files --stage -z` rows — every staged blob sha + mode,
 *       so a changed index is caught even when the status line is constant;
 *    4. the actual bytes of every worktree-modified tracked file and every
 *       untracked file (the exact things restore/reset/destructive_local can
 *       destroy), and the targets of symlink entries.
 *
 *  Deliberately NOT `git diff`: repository-configured external diff drivers
 *  and textconv filters would make fingerprinting EXECUTE repository-
 *  controlled programs. status/ls-files plumbing plus direct bounded reads
 *  cannot be hijacked that way (no-ext-diff/no-textconv by construction).
 *
 *  Ignored files are intentionally NOT hashed: destructive_local's clean
 *  never passes -x (ignored content is unreachable by every executable
 *  argv), so hashing it would only burn the fail-closed byte budget.
 *
 *  All IO is bounded (per-file, total, file-count, and plumbing-output
 *  caps). Unreadable, unsupported (fifo/socket/device), or oversized inputs
 *  FAIL CLOSED — approval-token issuance is refused — rather than silently
 *  omitted from the digest. */

import { createHash, type Hash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./exec.js";
import { ValidationError, isString } from "./validate.js";

export interface RepoCtx {
  /** resolved git toplevel — the cwd every command runs in */
  root: string;
  /** the directory the caller named (paths resolve against this) */
  fromDir: string;
  /** the repo param as supplied (or "(cwd)") */
  repoParam: string;
}

export async function resolveRepo(repoParam: unknown): Promise<RepoCtx> {
  if (repoParam !== undefined && !isString(repoParam)) {
    throw new ValidationError("repo must be a string path when supplied");
  }
  const given: string | undefined = isString(repoParam) ? repoParam : undefined;
  const fromDir = realpathSync(resolve(given ?? process.cwd()));
  const r = await git({ cwd: fromDir, args: ["rev-parse", "--show-toplevel"] });
  if (r.code !== 0) {
    throw new ValidationError(
      `not a git repository: ${fromDir} (git rev-parse --show-toplevel failed${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""})`,
    );
  }
  const root = realpathSync(r.stdout.trim());
  if (!root) throw new ValidationError(`could not resolve repository toplevel for ${fromDir}`);
  return { root, fromDir, repoParam: given ?? "(cwd)" };
}

export interface RepoState {
  head: string;
  /** raw porcelain -z bytes (structure/presence component of the digest) */
  porcelain: string;
  /** content-bound digest: HEAD + status(-z) + index rows + changed bytes */
  digest: string;
}

// ── fingerprint bounds (all fail closed when exceeded) ───────────────────

const FP_MAX_PLUMBING_BYTES = 2 * 1024 * 1024; // status / ls-files output cap
const FP_MAX_FILES = 4096; // changed+untracked files hashed per fingerprint
const FP_MAX_FILE_BYTES = 4 * 1024 * 1024; // per-file content cap
const FP_MAX_TOTAL_BYTES = 16 * 1024 * 1024; // summed content cap

function kb(n: number): string {
  return `${Math.round(n / 1024)} KiB`;
}

/** Worktree paths whose CONTENT participates in the digest: every entry whose
 *  worktree column changed (modified/typechange/unmerged/untracked/…).
 *  Deleted-in-worktree entries ('D') have no bytes to hash — deletion itself
 *  is structural and already bound by the raw status bytes. In -z format a
 *  rename/copy entry carries the original path as an EXTRA NUL field, which
 *  is skipped here (the surviving new path is what gets hashed). */
function contentPathsFromStatusZ(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const entry = fields[i];
    if (entry === undefined || entry === "") break;
    i++;
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // skip the orig-path field
    const y = xy[1];
    if (y !== " " && y !== "D") paths.push(path);
  }
  return paths;
}

/** Hash one worktree path (file bytes or symlink target). Returns bytes
 *  hashed. Fails closed on unreadable, special, or oversized entries. */
function hashWorktreePath(h: Hash, root: string, rel: string): number {
  const abs = join(root, rel);
  let st: Stats;
  try {
    st = lstatSync(abs);
  } catch (e) {
    throw new ValidationError(`cannot fingerprint "${rel}": unreadable (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) — refusing to issue an approval token (fail closed)`);
  }
  if (st.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(abs);
    } catch (e) {
      throw new ValidationError(`cannot fingerprint "${rel}": unreadable symlink (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) — refusing (fail closed)`);
    }
    const n = Buffer.byteLength(target);
    if (n > FP_MAX_FILE_BYTES) {
      throw new ValidationError(`cannot fingerprint "${rel}": symlink target exceeds ${kb(FP_MAX_FILE_BYTES)} (fail closed)`);
    }
    h.update(`sym\u0000${rel}\u0000${n}\u0000${target}`);
    return n;
  }
  if (!st.isFile()) {
    // fifo/socket/device/… — reading could block or lie; never silently skip
    throw new ValidationError(`cannot fingerprint "${rel}": unsupported file type (not a regular file or symlink) — refusing (fail closed)`);
  }
  if (st.size > FP_MAX_FILE_BYTES) {
    throw new ValidationError(`cannot fingerprint "${rel}": ${st.size} bytes exceeds the per-file ${kb(FP_MAX_FILE_BYTES)} bound (fail closed)`);
  }
  let fd: number;
  try {
    fd = openSync(abs, "r");
  } catch (e) {
    throw new ValidationError(`cannot fingerprint "${rel}": cannot open (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) — refusing (fail closed)`);
  }
  const buf = Buffer.allocUnsafe(65536);
  let read = 0;
  try {
    h.update(`file\u0000${rel}\u0000${st.size}\u0000`);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      read += n;
      if (read > FP_MAX_FILE_BYTES) {
        throw new ValidationError(`cannot fingerprint "${rel}": grew past ${kb(FP_MAX_FILE_BYTES)} while reading (fail closed)`);
      }
      h.update(buf.subarray(0, n));
    }
    if (read !== st.size) h.update(`\u0000short:${read}\u0000`); // size raced — bind what was seen
  } finally {
    closeSync(fd);
  }
  return read;
}

export async function repoState(root: string): Promise<RepoState> {
  const headR = await git({ cwd: root, args: ["rev-parse", "HEAD"] });
  if (headR.code !== 0) {
    throw new ValidationError(`repository has no commits yet (HEAD unborn) — approval-tier tools need at least one commit: ${root}`);
  }
  const stR = await git({ cwd: root, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], maxOutput: FP_MAX_PLUMBING_BYTES });
  if (stR.code !== 0) {
    throw new ValidationError(`git status failed: ${stR.stderr.trim().split("\n")[0]}`);
  }
  if (stR.truncated) {
    throw new ValidationError(`cannot fingerprint: status output exceeds ${kb(FP_MAX_PLUMBING_BYTES)} — refusing to issue an approval token (fail closed)`);
  }
  const idxR = await git({ cwd: root, args: ["ls-files", "--stage", "-z"], maxOutput: FP_MAX_PLUMBING_BYTES });
  if (idxR.code !== 0) {
    throw new ValidationError(`git ls-files failed: ${idxR.stderr.trim().split("\n")[0]}`);
  }
  if (idxR.truncated) {
    throw new ValidationError(`cannot fingerprint: index listing exceeds ${kb(FP_MAX_PLUMBING_BYTES)} — refusing to issue an approval token (fail closed)`);
  }

  const h = createHash("sha256");
  h.update(`head\u0000${headR.stdout.trim()}\n`);
  h.update(`status\u0000${stR.stdout}\n`);
  h.update(`index\u0000${idxR.stdout}\n`);

  const paths = contentPathsFromStatusZ(stR.stdout);
  if (paths.length > FP_MAX_FILES) {
    throw new ValidationError(`cannot fingerprint: ${paths.length} changed/untracked files exceed the ${FP_MAX_FILES}-file bound — refusing (fail closed)`);
  }
  let total = 0;
  for (const rel of paths) {
    total += hashWorktreePath(h, root, rel);
    if (total > FP_MAX_TOTAL_BYTES) {
      throw new ValidationError(`cannot fingerprint: changed/untracked content exceeds the ${kb(FP_MAX_TOTAL_BYTES)} total bound — refusing (fail closed)`);
    }
  }

  return { head: headR.stdout.trim(), porcelain: stR.stdout, digest: h.digest("hex") };
}
