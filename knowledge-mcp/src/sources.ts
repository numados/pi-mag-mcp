/** Source and path resolution — the single owner of "which source serves this
 *  call" and "which root inside it holds this note". One source may span
 *  several ordered roots; a note is addressed root-relative, explicitly as
 *  `<label>:<rel>`, or by a basename unique across the whole source. */

import { existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { expandHome } from "./config.js";
import { loadRepoContext, resolveTaskRoot } from "./repo-config.js";
import { notePath, safeResolve, vaultIndex } from "./safety.js";
import type { ConfigLoadResult, RepoContext, Root, Source } from "./types.js";

export interface ResolvedRef {
  root: Root;
  /** Root-relative path of the note (`.md` ensured in write mode). */
  rel: string;
  abs: string;
}

export interface TaskRootResolution {
  /** Vault-relative task workspace root (leading slashes stripped). */
  rel: string;
  /** Task workspaces always resolve inside the write root. */
  root: Root;
  /** Other roots that already contain `rel` — doctor data, not an error. */
  elsewhere: Root[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── source resolution ─────────────────────────────────────────────────────

/** Resolve the source: explicit vault argument → repo `.knowledge-mcp.json`
 *  → longest `projects` prefix (directory-boundary match) → defaultVaults[0]
 *  → legacy defaultVault. */
export function resolveSource(
  load: ConfigLoadResult,
  explicitVault?: string,
  startDir: string = process.cwd(),
): Source {
  const cfg = load.config;
  let name: string | null = explicitVault ?? loadRepoContext(startDir).config.vault ?? null;
  if (!name) {
    let best = "";
    const cwd = resolve(startDir);
    for (const [prefix, target] of Object.entries(cfg.projects ?? {})) {
      const root = resolve(expandHome(prefix));
      if ((cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep)) && root.length >= best.length) {
        best = root;
        name = target;
      }
    }
  }
  if (!name) name = cfg.defaultVaults[0] ?? cfg.defaultVault ?? null;
  if (!name) {
    throw new Error(
      `no vault resolved: pass vault=<name>, or set defaultVault/projects in ${cfg.configPath} ` +
        `(known vaults: ${cfg.sources.map((s) => s.name).join(", ") || "none — add one to vaults"}) ` +
        `— run with --setup to create the config`,
    );
  }
  const source = cfg.sources.find((s) => s.name === name);
  if (!source) {
    throw new Error(`unknown vault "${name}" (known: ${cfg.sources.map((s) => s.name).join(", ") || "none"})`);
  }
  if (!source.roots.some((r) => isDir(r.path))) {
    throw new Error(
      `vault "${name}" path does not exist or is not a directory: ${source.roots.map((r) => r.path).join(", ")}`,
    );
  }
  return source;
}

// ── path resolution inside a source ───────────────────────────────────────

/** Resolve a note reference inside the source.
 *
 *  `<label>:<rel>` addresses one root explicitly (any other ref containing a
 *  colon is treated the same way, so an unknown label is reported as such
 *  instead of as a missing file). Otherwise every root is searched in
 *  declaration order: the exact relative path, then `rel + ".md"`, then —
 *  read mode only — a basename unique across all roots of the source. */
export function resolveRef(source: Source, ref: string, mode: "read" | "write"): ResolvedRef {
  const colon = ref.indexOf(":");
  if (colon > 0) {
    const label = ref.slice(0, colon);
    const root = source.roots.find((r) => r.label === label);
    if (root === undefined) {
      throw new Error(
        `unknown root "${label}" in source "${source.name}" (roots: ${source.roots.map((r) => r.label).join(", ")})`,
      );
    }
    return mode === "write"
      ? writeRef(root, ref.slice(colon + 1))
      : readRef(source, [root], ref, ref.slice(colon + 1));
  }
  return mode === "write" ? writeRef(writeRoot(source), ref) : readRef(source, source.roots, ref, ref);
}

function readRef(source: Source, roots: Root[], fullRef: string, rel: string): ResolvedRef {
  const candidates: Array<{ root: Root; abs: string }> = [];
  const blocked: Error[] = [];
  let notMarkdown = false;

  const tryExact = (root: Root, r: string): void => {
    try {
      const abs = safeResolve(root.path, r, "read");
      if (existsSync(abs)) {
        if (abs.endsWith(".md")) candidates.push({ root, abs });
        else notMarkdown = true;
      }
    } catch (e) {
      blocked.push(e instanceof Error ? e : new Error(String(e)));
    }
  };

  for (const root of roots) tryExact(root, rel);
  if (candidates.length === 0) for (const root of roots) tryExact(root, rel + ".md");
  if (candidates.length === 1) return toResolved(candidates[0]!);
  if (candidates.length > 1) throw ambiguousError(source, candidates);
  // safety rejections outrank the "missing" verdicts below, as in the source
  if (blocked.length > 0) throw blocked[0]!;
  if (notMarkdown) throw new Error(`not a Markdown note: ${fullRef}`);

  const base = rel.replace(/\.md$/i, "").toLowerCase();
  for (const root of roots) {
    for (const abs of vaultIndex(root.path).byBasename.get(base) ?? []) {
      candidates.push({ root, abs });
    }
  }
  if (candidates.length === 1) return toResolved(candidates[0]!);
  if (candidates.length > 1) throw ambiguousError(source, candidates);
  throw new Error(`note not found: ${fullRef}`);
}

function ambiguousError(source: Source, candidates: Array<{ root: Root; abs: string }>): Error {
  const listed = candidates.map((c) => `${c.root.label}:${relative(c.root.path, c.abs)}`);
  return new Error(`ambiguous path in source "${source.name}": ${listed.join(", ")} — address as "${listed[0]!}"`);
}

function writeRef(root: Root, rel: string): ResolvedRef {
  if (root.writable === false) throw new Error(`source root "${root.label}" is read-only by config`);
  const abs = notePath(safeResolve(root.path, rel, "write"));
  return { root, rel: relative(root.path, abs), abs };
}

function toResolved(c: { root: Root; abs: string }): ResolvedRef {
  return { root: c.root, rel: relative(c.root.path, c.abs), abs: c.abs };
}

/** First writable root — the write target when a ref carries no label. */
export function writeRoot(source: Source): Root {
  const root = source.roots.find((r) => r.writable !== false);
  if (root === undefined) {
    throw new Error(`no writable root in source "${source.name}" (roots: ${source.roots.map((r) => r.label).join(", ")})`);
  }
  return root;
}

// ── task workspaces ───────────────────────────────────────────────────────

/** The task workspace root resolves inside the write root; when the directory
 *  already exists only in another root, that fact is exposed as data for the
 *  doctor instead of an error. The explicit `knowledge_task` argument wins
 *  over the repo config, which wins over the central default. */
export function taskRootOf(
  source: Source,
  repoCtx: RepoContext,
  centralDefault: string | undefined,
  explicit?: string,
): TaskRootResolution {
  const rel = resolveTaskRoot(explicit, repoCtx, centralDefault);
  const root = writeRoot(source);
  const elsewhere = source.roots.filter((r) => r !== root && isDir(join(r.path, rel)));
  return { rel, root, elsewhere };
}
