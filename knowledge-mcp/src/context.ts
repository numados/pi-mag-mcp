/** Tool context — the one place that turns tool arguments into a working
 *  context. Every call goes through `loadConfig()` again (fresh config, no
 *  module state), resolves the source that serves it and exposes the shared
 *  helpers several handlers need: note-reference resolution, neighbour
 *  conventions, the wikilink report, `today()`/`clip()` and the `text`/`err`
 *  response constructors.
 *
 *  Three context kinds mirror the three routing rules of the plan:
 *  - `forCall` — exactly one source: explicit vault → repo → longest projects
 *    prefix → defaultVaults[0] → legacy defaultVault (sources.ts owns it);
 *  - `forSearch` — one or more sources: explicit name/array → defaultVaults
 *    → legacy defaultVault (only knowledge_search is multi-source);
 *  - `forTask` — task workspaces: explicit vault → taskVault → the forCall
 *    chain, plus the task root resolved inside the write root.
 *
 *  Dependencies (runner, clock, anchor directory) are injectable so tests run
 *  hermetically; the defaults are the real argv runner and the process cwd. */

import { existsSync, readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { loadConfig } from "./config.js";
import { extractWikiLinks, parseNote } from "./md.js";
import { loadRepoContext } from "./repo-config.js";
import { run as defaultRun } from "./subprocess.js";
import { createSearch, type Runner } from "./search.js";
import { resolveRef, resolveSource, taskRootOf, type ResolvedRef, type TaskRootResolution } from "./sources.js";
import { safeResolve, vaultIndex } from "./safety.js";
import type {
  ConfigLoadResult,
  KnowledgeConfig,
  RepoContext,
  Root,
  Source,
  ToolResult,
} from "./types.js";

// ── shared helpers (single copies of the source tools.ts helpers) ─────────

export const today = (): string => new Date().toISOString().slice(0, 10);

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function err(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

// ── conventions / wikilinks ───────────────────────────────────────────────

export interface Conventions {
  frontmatterShare: number;
  sample: number;
  commonKeys: string[];
  wikilinks: number;
  mdLinks: number;
  naming: string;
}

/** Detect writing conventions from the neighbours of a target dir — sampled
 *  inside ONE root (the root the note lives in), not across the source. */
export function conventions(root: string, dirAbs: string): Conventions {
  const idx = vaultIndex(root);
  const dirPrefix = dirAbs.endsWith("/") ? dirAbs : `${dirAbs}/`;
  const siblings = idx.all.filter((p) => p.startsWith(dirPrefix)).slice(0, 40);
  let withFm = 0;
  const keyCount = new Map<string, number>();
  let wikilinks = 0;
  let mdLinks = 0;
  const naming = { spaces: 0, kebab: 0, snake: 0, other: 0 };
  for (const p of siblings) {
    const base = basename(p, ".md");
    if (/ /.test(base)) naming.spaces++;
    else if (/-/.test(base)) naming.kebab++;
    else if (/_/.test(base)) naming.snake++;
    else naming.other++;
    try {
      const note = parseNote(readFileSync(p, "utf8"));
      if (note.frontmatter && Object.keys(note.frontmatter).length) {
        withFm++;
        for (const k of Object.keys(note.frontmatter)) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
      }
      wikilinks += (note.body.match(/\[\[/g) ?? []).length;
      mdLinks += (note.body.match(/\]\([^)]+\.md\)/g) ?? []).length;
    } catch {
      /* unreadable sibling — skip */
    }
  }
  const n = siblings.length || 1;
  const namingStyle = Object.entries(naming).sort((a, b) => b[1] - a[1])[0]![0];
  return {
    frontmatterShare: withFm / n,
    sample: siblings.length,
    commonKeys: [...keyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k),
    wikilinks,
    mdLinks,
    naming: namingStyle,
  };
}

/** A wikilink target resolved across ALL roots of a source — the roots of one
 *  source are one namespace, so a basename unique in any root resolves and a
 *  collision anywhere is ambiguous (Obsidian semantics, source behaviour). */
export interface WikiHit {
  root: Root;
  /** Root-relative path of the target note. */
  rel: string;
}

export interface WikiResolution {
  paths: WikiHit[];
  ambiguous: boolean;
}

export function resolveWikiTargetInSource(source: Source, target: string): WikiResolution {
  const t = target.replace(/\.md$/i, "");
  for (const root of source.roots) {
    const asPath = safeResolve(root.path, t, "read");
    if (existsSync(`${asPath}.md`)) {
      return { paths: [{ root, rel: relative(root.path, `${asPath}.md`) }], ambiguous: false };
    }
  }
  const hits: WikiHit[] = [];
  const base = t.toLowerCase();
  for (const root of source.roots) {
    for (const abs of vaultIndex(root.path).byBasename.get(base) ?? []) {
      hits.push({ root, rel: relative(root.path, abs) });
    }
  }
  return { paths: hits, ambiguous: hits.length > 1 };
}

export interface LinkReport {
  unresolved: string[];
  ambiguous: string[];
}

/** Unresolved/ambiguous wikilinks of a draft, across all roots of the source. */
export function linkReport(source: Source, content: string): LinkReport {
  const unresolved: string[] = [];
  const ambiguous: string[] = [];
  for (const l of extractWikiLinks(content)) {
    const r = resolveWikiTargetInSource(source, l.target);
    if (r.paths.length === 0) unresolved.push(l.target);
    else if (r.ambiguous) ambiguous.push(l.target);
  }
  return { unresolved: [...new Set(unresolved)], ambiguous: [...new Set(ambiguous)] };
}

// ── contexts ──────────────────────────────────────────────────────────────

export type Search = ReturnType<typeof createSearch>;

export interface ToolDeps {
  /** Bounded argv runner (default: subprocess.run — never a shell). */
  run?: Runner;
  /** Clock for the qmd update TTL (default: Date.now). */
  now?: () => number;
  /** Anchor for repo/projects routing (default: process.cwd()). */
  startDir?: string;
}

/** One resolved source plus the per-call machinery. */
export interface ToolContext {
  config: KnowledgeConfig;
  source: Source;
  repoCtx: RepoContext;
  run: Runner;
  search: Search;
  /** Resolve a note reference inside the source (read defaults; write mode
   *  targets the first writable root unless the ref is `<label>:<rel>`). */
  resolveNoteRef(ref: string, mode?: "read" | "write"): ResolvedRef;
}

/** One or more sources for a multi-source search. */
export interface SearchContext {
  config: KnowledgeConfig;
  /** Names this call asked for — unknown ones become `skipped:` lines. */
  requested: string[];
  sources: Source[];
  run: Runner;
  search: Search;
}

/** A task workspace context: the taskVault-preferring source plus the
 *  task root resolved inside the write root. */
export interface TaskContext extends ToolContext {
  taskRoot: TaskRootResolution;
}

export function createContext(deps: ToolDeps = {}) {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;
  const startDir = deps.startDir ?? process.cwd();

  const searchOf = (load: ConfigLoadResult): Search =>
    createSearch({ run, qmd: load.config.qmd, now });

  const withSource = (load: ConfigLoadResult, source: Source, repoCtx: RepoContext): ToolContext => ({
    config: load.config,
    source,
    repoCtx,
    run,
    search: searchOf(load),
    resolveNoteRef: (ref, mode = "read") => resolveRef(source, ref, mode),
  });

  return {
    /** Read/write tools other than task: exactly one source. */
    forCall(args: { vault?: string | undefined }): ToolContext {
      const load = loadConfig();
      const source = resolveSource(load, args.vault, startDir);
      return withSource(load, source, loadRepoContext(startDir));
    },

    /** knowledge_search: `vault: string | string[]`; unknown names in an
     *  array are dropped here and reported by the caller. A single explicit
     *  name keeps the canonical unknown-vault error. */
    forSearch(vaultArg: string | string[] | undefined): SearchContext {
      const load = loadConfig();
      const cfg = load.config;
      const byName = (name: string): Source | undefined => cfg.sources.find((s) => s.name === name);
      let requested: string[];
      if (vaultArg === undefined) {
        if (cfg.defaultVaults.length > 0) requested = cfg.defaultVaults;
        else if (cfg.defaultVault !== null) requested = [cfg.defaultVault];
        else {
          resolveSource(load, undefined, startDir); // throws the canonical "no vault resolved"
          requested = [];
        }
      } else {
        requested = Array.isArray(vaultArg) ? vaultArg : [vaultArg];
        if (requested.length === 1) resolveSource(load, requested[0], startDir); // canonical error for one name
      }
      const sources = requested
        .map(byName)
        .filter((s): s is Source => s !== undefined);
      // nothing asked for and nothing resolved — the canonical no-vault error;
      // an array of unknown names is reported per name as skipped lines instead
      if (sources.length === 0 && requested.length <= 1) {
        resolveSource(load, undefined, startDir);
      }
      return { config: cfg, requested, sources, run, search: searchOf(load) };
    },

    /** knowledge_task: explicit vault → taskVault → the forCall chain. */
    forTask(args: { vault?: string | undefined; taskRoot?: string | undefined }): TaskContext {
      const load = loadConfig();
      const cfg = load.config;
      const repoCtx = loadRepoContext(startDir);
      const source = resolveSource(load, args.vault ?? cfg.taskVault ?? undefined, startDir);
      const taskRoot = taskRootOf(source, repoCtx, cfg.defaultTaskRoot ?? undefined, args.taskRoot);
      return { ...withSource(load, source, repoCtx), taskRoot };
    },
  };
}
