/**
 * Server-side scope enforcement and output bounds.
 *
 * Forbidden roots (/, home, system directories) are rejected, hidden paths are
 * allowed only under configured roots, and result counts and snippets are
 * capped server-side so a single call cannot flood the host. The rejection
 * messages are part of the tool contract: skills and agent instructions quote
 * the "too broad" wording.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { ScopeError } from "./types.js";

const BLOCKED_ROOTS = new Set(
  [
    "/",
    "/Users",
    "/private",
    "/private/tmp",
    "/tmp",
    "/Volumes",
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/etc",
    "/var",
    "/opt",
  ].map((path) => resolve(path)),
);

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const DEFAULT_SNIPPET = 240;
export const MAX_SNIPPET = 2_000;

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function under(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(prefix + sep);
}

function hasHiddenSegment(path: string): boolean {
  return path.split(sep).some((segment) => segment.startsWith("."));
}

/** Validate one root; returns the resolved absolute path or throws ScopeError. */
export function assertRoot(config: ServerConfig, root: string): string {
  const resolved = resolve(expandTilde(String(root)));
  const home = homedir();
  if (resolved === home || BLOCKED_ROOTS.has(resolved)) {
    throw new ScopeError(`root too broad, rejected: ${resolved} (pass a project/vault subdirectory)`);
  }
  const allowed = (config.roots ?? []).map((entry) => resolve(expandTilde(entry)));
  if (allowed.length > 0 && !allowed.some((entry) => under(entry, resolved))) {
    throw new ScopeError(`root outside configured allowed roots (${config.roots.join(", ")}): ${resolved}`);
  }
  const underAllowed = allowed.some((entry) => under(entry, resolved));
  if (hasHiddenSegment(resolved) && !underAllowed) {
    throw new ScopeError(`hidden path rejected (only allowed under configured roots): ${resolved}`);
  }
  if (!existsSync(resolved)) {
    throw new ScopeError(`root not found: ${resolved}`);
  }
  return resolved;
}

/** Validate a roots array; throws ScopeError naming the offending root. */
export function assertRoots(config: ServerConfig, roots: string[] | undefined): string[] {
  if (!roots || roots.length === 0) {
    throw new ScopeError("no roots given and no default for this intent — pass roots explicitly");
  }
  return roots.map((root) => assertRoot(config, root));
}

export function clipLimit(limit: number | undefined): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(value), MAX_LIMIT);
}

export function clipSnippet(max: number | undefined): number {
  const value = Number(max);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SNIPPET;
  return Math.min(Math.trunc(value), MAX_SNIPPET);
}

export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
