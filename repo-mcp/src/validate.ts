/** Input validation — the injection firewall between caller-supplied values
 *  and the fixed argv templates in the tools/ handler modules.
 *
 *  Principles:
 *    - callers never supply commands, flags, or options — only values that
 *      land in fixed positions of a template we own;
 *    - refs/remotes reject a leading '-' (option injection) and ASCII control
 *      characters (argv smuggling);
 *    - paths are resolved against the caller's repo dir, then verified to stay
 *      inside the repository toplevel, then passed as repo-relative pathspecs
 *      after a literal "--" separator;
 *    - shq() renders argv elements for PREVIEW display only — nothing shown
 *      to the user is ever executed.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export class ValidationError extends Error {}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

function noControlChars(s: string, what: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) throw new ValidationError(`${what} must not contain control characters`);
}

/** Ref-ish value (commit-ish, branch, tag, remote name component). Fixed argv
 *  position, but still reject leading '-' and control chars defensively. */
export function validateRef(v: unknown, what = "ref"): string {
  if (!isString(v) || v.length === 0) throw new ValidationError(`${what} must be a non-empty string`);
  if (v.startsWith("-")) throw new ValidationError(`${what} must not start with '-' (option-like values are rejected)`);
  noControlChars(v, what);
  if (v !== v.trim()) throw new ValidationError(`${what} must not have leading/trailing whitespace`);
  return v;
}

/** Remote name — stricter: no URL chars or whitespace (we only accept a name
 *  from the configured remotes, never a URL with embedded credentials). */
export function validateRemote(v: unknown): string {
  const name = validateRef(v, "remote");
  if (/[:@\/\s]/.test(name)) {
    throw new ValidationError("remote must be a plain configured remote name; URLs are not accepted here");
  }
  return name;
}

/** Branch name that WE will create/move/delete — strict subset of
 *  git-check-ref-format so git itself can never be handed a glob, an option,
 *  or a ref outside refs/heads. */
export function validateBranchName(v: unknown): string {
  const name = validateRef(v, "branch name");
  if (name === "HEAD" || name.includes("refs/") || /[:@*?[\\\s]/.test(name)) {
    throw new ValidationError(`branch name must be a plain refs/heads name, not "${name}"`);
  }
  if (name.includes("..") || name.includes("//")) throw new ValidationError(`branch name "${name}" contains '..' or '//'`);
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) throw new ValidationError(`branch name "${name}" is not a valid ref (trailing '/', '.', or '.lock')`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_\/.-]*$/.test(name)) throw new ValidationError(`branch name "${name}" has unsupported characters`);
  for (const part of name.split("/")) {
    if (part === "" || part.startsWith(".")) throw new ValidationError(`branch name "${name}" has an empty or dot-prefixed path component`);
  }
  return name;
}

/** Commit message — the only place newlines are legitimately allowed. */
export function validateMessage(v: unknown): string {
  if (!isString(v)) throw new ValidationError("message must be a string");
  if (v.includes("\x00")) throw new ValidationError("message must not contain NUL");
  if (v.trim().length === 0) throw new ValidationError("message must not be empty");
  if (/co-authored-by\s*:|generated[- ](?:with|by)|🤖|\b(?:written|authored|created) by (?:AI|Claude|ChatGPT|GPT|Codex|Gemini|an? (?:AI )?agent)\b/i.test(v)) {
    throw new ValidationError("message must not contain AI/model/agent attribution or co-author metadata");
  }
  if (/\bas requested\b|\bfollowing review feedback\b/i.test(v)) {
    throw new ValidationError("message must describe durable outcomes, not request or review history");
  }
  if (/https?:\/\/\S*(?:\/issues?\/|\/pull\/|\/pulls\/|\/browse\/|\/_workitems\/|\/reviews?\/|\/prd(?:[\/.?#]|$))/i.test(v)) {
    throw new ValidationError("message must not contain issue, PRD, task or review URLs");
  }
  return v;
}

/** Resolve a caller path against the dir the caller named (or the server cwd),
 *  prove it stays inside the repo toplevel, and return the repo-relative
 *  POSIX pathspec that goes after the literal "--" separator. */
export function validatePathArg(repoRoot: string, fromDir: string, v: unknown, what = "path"): string {
  if (!isString(v) || v.length === 0) throw new ValidationError(`${what} must be a non-empty string`);
  noControlChars(v, what);
  const abs = isAbsolute(v) ? resolve(v) : resolve(fromDir, v);
  const rel = relative(repoRoot, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ValidationError(`${what} "${v}" resolves outside the repository (${repoRoot})`);
  }
  // '--' ends options, not Git pathspec magic or wildcard expansion.
  return `:(literal)${rel.split(sep).join("/")}`;
}

/** POSIX single-quoting for PREVIEW rendering only. */
export function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Render `git arg arg` exactly as it would be typed — display only. */
export function previewCommand(args: string[]): string {
  return `git ${args.map(shq).join(" ")}`;
}
