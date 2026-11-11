/** Path safety + vault file index (basename resolution, Obsidian-style).
 *
 *  Containment is computed with `path.relative` against the root (roots are
 *  normalized at load time by config.ts, but this module stays correct even
 *  for a raw trailing-slash root) and, second, by comparing the realpath of
 *  the deepest existing ancestor of the target with the root's — so a
 *  symlink inside the root cannot point outside it, while a not-yet-existing
 *  write target still resolves. */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const FORBIDDEN_DIRS = [".obsidian", ".git", ".trash"];
const FORBIDDEN_WRITE_DIRS = [...FORBIDDEN_DIRS, "attachments"];

function deepestExisting(p: string): string {
  let cur = normalize(p);
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // races are retried by the caller's own fs call anyway
  }
}

/** Lexically inside-or-equal (no fs access): rejects `..` escapes and
 *  absolute results of `relative`. */
function within(prefix: string, path: string): boolean {
  const r = relative(prefix, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Resolve a root-relative (or absolute-inside-root) path; reject escapes
 *  and protected dirs. Returns an absolute path inside the root. */
export function safeResolve(root: string, rel: string, mode: "read" | "write"): string {
  const abs = normalize(resolve(root, rel));
  if (!within(root, abs) || !within(realPath(deepestExisting(root)), realPath(deepestExisting(abs)))) {
    throw new Error(`path escapes the vault: ${rel}`);
  }
  const inside = relative(root, abs);
  const parts = inside === "" ? [] : inside.split(sep);
  const forbidden = mode === "write" ? FORBIDDEN_WRITE_DIRS : FORBIDDEN_DIRS;
  if (parts.some((p) => forbidden.includes(p))) {
    throw new Error(`protected location (${forbidden.includes("attachments") && mode === "write" ? "attachments are binary drops; notes go beside them" : "internal vault dir"}): ${rel}`);
  }
  return abs;
}

/** Normalize a note path: ensure .md, reject non-md writes. */
export function notePath(abs: string, mustExist = false): string {
  if (!abs.endsWith(".md")) abs += ".md";
  if (mustExist && !existsSync(abs)) throw new Error(`note not found: ${abs}`);
  return abs;
}

// ── vault index (cache, 30s, keyed by root path) ──────────────────────────

export interface VaultIndex {
  /** basename (no ext, lowercased) → absolute paths */
  byBasename: Map<string, string[]>;
  /** all md paths (absolute) */
  all: string[];
  builtAt: number;
}

const indexCache = new Map<string, VaultIndex>();
const TTL_MS = 30_000;

export function vaultIndex(root: string): VaultIndex {
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.builtAt < TTL_MS) {
    return cached;
  }
  const all: string[] = [];
  const byBasename = new Map<string, string[]>();
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.endsWith(".md")) {
        all.push(p);
        const base = e.slice(0, -3).toLowerCase();
        const arr = byBasename.get(base) ?? [];
        arr.push(p);
        byBasename.set(base, arr);
      }
    }
  };
  walk(root, 0);
  const index: VaultIndex = { byBasename, all, builtAt: Date.now() };
  indexCache.set(root, index);
  return index;
}

/** Resolve a wikilink target to absolute path(s), Obsidian-style:
 *  exact root-relative path → unique basename → ambiguity. */
export function resolveWikiTarget(
  root: string,
  target: string,
): { paths: string[]; ambiguous: boolean } {
  const idx = vaultIndex(root);
  const t = target.replace(/\.md$/i, "");
  const asPath = linkResolve(root, t);
  if (existsSync(asPath + ".md")) return { paths: [asPath + ".md"], ambiguous: false };
  const hits = idx.byBasename.get(t.toLowerCase()) ?? [];
  if (hits.length > 0) return { paths: hits, ambiguous: hits.length > 1 };
  return { paths: [], ambiguous: false };
}

function linkResolve(root: string, rel: string): string {
  const abs = normalize(resolve(root, rel));
  if (!within(root, abs) || !within(realPath(deepestExisting(root)), realPath(deepestExisting(abs)))) {
    throw new Error(`link escapes the vault: ${rel}`);
  }
  return abs;
}

// ── naive secret scan (write guard) ───────────────────────────────────────

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["generic secret assignment", /\b(secret|password|api[_-]?key|token)\b\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i],
];

export function scanSecrets(text: string): string[] {
  const found: string[] = [];
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return found;
}
