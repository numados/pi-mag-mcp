/** Discovery — the one owner of filesystem traversal. It reads a documented
 *  set of home-directory roots (never the whole home) with a depth limit and
 *  a per-root time budget, skipping package caches, `Library` (except under
 *  CloudStorage) and `.app` bundles, and reports note-holding directories as
 *  candidates. It writes nothing and spawns nothing.
 *
 *  Rules this module owns:
 *  - a candidate is a vault (`.obsidian` present) or a directory whose subtree
 *    holds at least `minNotes` notes and which is not a mere ancestor of
 *    another candidate — every vault is reported even when nested, and a
 *    directory whose entire content is one nested vault is reported as that
 *    vault's wrapper (`nestedIn`), not as its own candidate;
 *  - copies are detected by the shared-sample rule owned by overlap.ts
 *    (`copyOf`, strictly fewer notes on the duplicate side);
 *  - candidates already present in the loaded config are marked
 *    `registeredAs` — matching is setup's concern, the mark is data. */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { COPY_SAMPLE_LIMIT, copyOf, type NotePair } from "./overlap.js";
import type { ConfigLoadResult } from "./types.js";

/** Documented discovery roots; `*` globs over the parent directory. */
export const DISCOVERY_ROOTS = [
  "~/Obsidian",
  "~/Documents",
  "~/Personal",
  "~/Work",
  "~/Yandex.Disk*",
  "~/Library/CloudStorage/*",
  "~/Dropbox",
  "~/iCloud Drive",
];

export const DEFAULT_MIN_NOTES = 20;
export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_TIME_BUDGET_MS = 10_000;

export interface Candidate {
  path: string;
  name: string;
  notes: number;
  obsidian: boolean;
  newestMtimeDaysAgo: number | null;
  bytes: number;
  /** Wrapper or nearest enclosing candidate this one sits inside. */
  nestedIn?: string;
  /** Candidates nested inside this one (when this one is a candidate). */
  containsNested?: string[];
  /** Earlier candidate this one duplicates (shared-sample rule). */
  copyOf?: string;
  sharedNotes?: number;
  registeredAs?: { source: string; label: string } | null;
}

export interface DiscoveryDeps {
  roots?: string[];
  minNotes?: number;
  maxDepth?: number;
  timeBudgetMs?: number;
  now?: () => number;
  /** Config loader for `registeredAs` marks (default: the central config). */
  load?: () => ConfigLoadResult;
}

const CACHE_NAMES = new Set(["node_modules", "Caches", "Cache", "cache", "__pycache__", "DerivedData"]);

function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** `~/Yandex.Disk*` globs over the home dir, `~/Library/CloudStorage/*` over
 *  that directory; plain roots pass through when they exist. */
export function expandRoots(patterns: string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    const expanded = expandTilde(pattern);
    if (!expanded.includes("*")) {
      try {
        if (statSync(expanded).isDirectory()) out.push(realpathSync(expanded));
      } catch {
        // a documented root that does not exist on this machine is skipped
      }
      continue;
    }
    const base = dirname(expanded);
    const glob = basename(expanded);
    const prefix = glob.slice(0, glob.indexOf("*"));
    const suffix = glob.slice(glob.lastIndexOf("*") + 1);
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
      const full = join(base, entry);
      try {
        if (statSync(full).isDirectory()) out.push(realpathSync(full));
      } catch {
        // unreadable or vanished — not a discovery root
      }
    }
  }
  return [...new Set(out)];
}

interface DirNode {
  path: string;
  parent: DirNode | null;
  /** Non-hidden entries (files + dirs) — the wrapper test needs this. */
  entries: number;
  isVault: boolean;
  notes: number;
  bytes: number;
  newestMtime: number;
  children: DirNode[];
  isCandidate: boolean;
  containsNested: string[];
}

export function createDiscovery(deps: DiscoveryDeps = {}) {
  const roots = deps.roots ?? DISCOVERY_ROOTS;
  const minNotes = deps.minNotes ?? DEFAULT_MIN_NOTES;
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeBudgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const now = deps.now ?? Date.now;
  const load = deps.load ?? loadConfig;

  function skipName(name: string, rootAllowsLibrary: boolean): boolean {
    if (CACHE_NAMES.has(name) && name !== "Library") return true;
    if (name.endsWith(".app")) return true;
    if (name === "Library") return !rootAllowsLibrary;
    return false;
  }

  /** Depth- and budget-bounded DFS. Returns null when the budget ran out
   *  before this directory was walked (the subtree is then not reported). */
  function walk(abs: string, depth: number, parent: DirNode | null, budgetStart: number, rootAllowsLibrary: boolean): DirNode | null {
    if (now() - budgetStart >= timeBudgetMs) return null;
    const node: DirNode = {
      path: abs, parent, entries: 0, isVault: false, notes: 0, bytes: 0,
      newestMtime: 0, children: [], isCandidate: false, containsNested: [],
    };
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return node; // unreadable — what we know is what we report
    }
    for (const entry of dirents) {
      if (entry.name.startsWith(".")) {
        if (entry.name === ".obsidian" && entry.isDirectory()) node.isVault = true;
        continue;
      }
      node.entries++;
      let st;
      try {
        st = statSync(join(abs, entry.name)); // follows symlinks on files, never on dirs below
      } catch {
        continue;
      }
      if (st.isDirectory() && !entry.isSymbolicLink()) {
        if (skipName(entry.name, rootAllowsLibrary)) continue;
        if (depth + 1 <= maxDepth) {
          const child = walk(join(abs, entry.name), depth + 1, node, budgetStart, rootAllowsLibrary);
          if (child !== null) {
            node.children.push(child);
            node.notes += child.notes;
            node.bytes += child.bytes;
            node.newestMtime = Math.max(node.newestMtime, child.newestMtime);
          }
        }
      } else {
        node.bytes += st.size;
        if (entry.name.endsWith(".md")) {
          node.notes++;
          node.newestMtime = Math.max(node.newestMtime, st.mtimeMs);
        }
      }
    }
    return node;
  }

  /** Bottom-up: a directory is a candidate when it is a vault, or holds
   *  enough notes and is not just an ancestor of another candidate. */
  function markCandidates(node: DirNode): boolean {
    let inside = false;
    for (const child of node.children) {
      if (markCandidates(child)) inside = true;
    }
    node.isCandidate = node.isVault || (node.notes >= minNotes && !inside);
    return inside || node.isCandidate;
  }

  function pureWrapper(node: DirNode): boolean {
    return node.entries === 1 && !node.isCandidate && node.children.length === 1;
  }

  async function scan(): Promise<Candidate[]> {
    const nodes: DirNode[] = [];
    for (const root of expandRoots(roots)) {
      const rootAllowsLibrary = root.includes("/Library/CloudStorage");
      const tree = walk(root, 0, null, now(), rootAllowsLibrary);
      if (tree === null) continue; // budget exhausted before this root started
      markCandidates(tree);
      collect(tree, nodes);
    }
    nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // nestedIn / containsNested: a pure wrapper (entire content = one nested
    // candidate) is the closest anchor; otherwise the nearest enclosing candidate
    const wrapperOf = new Map<DirNode, string>();
    for (const node of nodes) {
      if (!node.isCandidate) continue;
      const parent = node.parent;
      if (parent !== null && pureWrapper(parent) && parent.children[0] === node) {
        wrapperOf.set(node, parent.path);
        continue;
      }
      let ancestor = parent;
      while (ancestor !== null) {
        if (ancestor.isCandidate) {
          ancestor.containsNested.push(node.path);
          break;
        }
        ancestor = ancestor.parent;
      }
    }

    const registered = registeredRoots();
    const candidates: Candidate[] = nodes
      .filter((n) => n.isCandidate)
      .map((node) => {
        const nestedIn = wrapperOf.get(node) ?? nearestCandidateAncestor(node);
        const candidate: Candidate = {
          path: node.path,
          name: basename(node.path),
          notes: node.notes,
          obsidian: node.isVault,
          newestMtimeDaysAgo: node.newestMtime > 0 ? Math.max(0, Math.round((now() - node.newestMtime) / 86_400_000)) : null,
          bytes: node.bytes,
          ...(nestedIn !== null ? { nestedIn } : {}),
          ...(node.containsNested.length > 0 ? { containsNested: [...node.containsNested] } : {}),
          registeredAs: registered.get(node.path) ?? null,
        };
        return candidate;
      });

    // copies: every pair is compared once; the strictly smaller side is the
    // duplicate (ties stay unmarked — which side is canonical is the user's
    // call) and the first match wins, so a candidate is marked at most once
    const samples = new Map<string, NotePair[]>();
    for (const candidate of candidates) samples.set(candidate.path, samplePairs(candidate.path));
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i]!;
      if (samples.get(a.path)!.length === 0) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j]!;
        if (samples.get(b.path)!.length === 0) continue;
        const aOfB = copyOf(samples.get(a.path)!, samples.get(b.path)!, a.notes, b.notes);
        if (aOfB !== null) {
          a.copyOf = b.path;
          a.sharedNotes = aOfB;
          break;
        }
        const bOfA = copyOf(samples.get(b.path)!, samples.get(a.path)!, b.notes, a.notes);
        if (bOfA !== null) {
          b.copyOf = a.path;
          b.sharedNotes = bOfA;
          break;
        }
      }
    }
    return candidates;
  }

  function collect(node: DirNode, into: DirNode[]): void {
    into.push(node);
    for (const child of node.children) collect(child, into);
  }

  function nearestCandidateAncestor(node: DirNode): string | null {
    let ancestor = node.parent;
    while (ancestor !== null) {
      if (ancestor.isCandidate) return ancestor.path;
      ancestor = ancestor.parent;
    }
    return null;
  }

  function samplePairs(root: string): NotePair[] {
    const pairs: NotePair[] = [];
    const visit = (dir: string): void => {
      if (pairs.length >= COPY_SAMPLE_LIMIT) return;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of dirents) {
        if (pairs.length >= COPY_SAMPLE_LIMIT) return;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (skipName(entry.name, true)) continue;
          visit(full);
        } else if (entry.name.endsWith(".md")) {
          try {
            pairs.push({ rel: dir === root ? entry.name : join(relKey(root, dir), entry.name), size: statSync(full).size });
          } catch {
            // vanished — skip
          }
        }
      }
    };
    visit(root);
    return pairs;
  }

  function relKey(root: string, dir: string): string {
    return dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
  }

  function registeredRoots(): Map<string, { source: string; label: string }> {
    const map = new Map<string, { source: string; label: string }>();
    try {
      for (const source of load().config.sources) {
        for (const root of source.roots) map.set(root.path, { source: source.name, label: root.label });
      }
    } catch {
      // an unreadable config just means no registeredAs marks
    }
    return map;
  }

  return { scan };
}
