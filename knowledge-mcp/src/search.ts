/** Search over one vault root: qmd (BM25 hybrid, TTL-refreshed index) →
 *  ripgrep fallback. Ported from the source's search.ts with the same
 *  qmd→rg behaviour, clip(…, 240) and limit caps.
 *
 *  A factory, not module state: the caller injects the runner, the qmd
 *  settings and the clock, so no call site shells out by accident and tests
 *  run hermetically. One instance owns its update TTL for its lifetime. */

import { isPlainObject } from "./types.js";
import type { QmdSettings, RunResult, SearchHit, SearchOutcome } from "./types.js";

export type Runner = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
) => Promise<RunResult>;

export interface SearchDeps {
  run: Runner;
  qmd?: QmdSettings;
  now?: () => number;
}

export interface SearchVaultOptions {
  scope?: string;
  limit?: number;
  prefer?: "qmd" | "rg";
}

export interface RgContextOptions {
  scope?: string;
  limit?: number;
  context?: number;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function createSearch(deps: SearchDeps) {
  const run = deps.run;
  const qmdEnabled = deps.qmd?.enabled ?? true;
  const updateTtlMin = deps.qmd?.updateTtlMinutes ?? 10;
  const now = deps.now ?? Date.now;
  let lastUpdateAt = 0;

  async function qmdAvailable(): Promise<boolean> {
    if (!qmdEnabled) return false;
    const r = await run("qmd", ["--version"], { timeoutMs: 8000 });
    return r.code === 0;
  }

  async function maybeRefresh(root: string): Promise<void> {
    if (updateTtlMin <= 0 || !qmdEnabled) return;
    if (now() - lastUpdateAt < updateTtlMin * 60_000) return;
    await run("qmd", ["update"], { cwd: root, timeoutMs: 20_000 });
    lastUpdateAt = now();
  }

  async function searchVault(root: string, query: string, opts: SearchVaultOptions = {}): Promise<SearchOutcome> {
    const limit = Math.min(opts.limit ?? 20, 100);
    const scope = opts.scope?.replace(/^\/+/, "");
    if (opts.prefer !== "rg" && (await qmdAvailable())) {
      await maybeRefresh(root);
      const args = ["search", "--json", "--limit", String(limit), query];
      if (scope) args.push(scope);
      const r = await run("qmd", args, { cwd: root, timeoutMs: 30_000 });
      if (r.code === 0) {
        try {
          const parsed: unknown = JSON.parse(r.stdout);
          if (!Array.isArray(parsed)) throw new Error("qmd search result is not an array");
          const hits: SearchHit[] = [];
          for (const row of parsed) {
            if (!isPlainObject(row) || typeof row.file !== "string") {
              // a malformed row discards the whole result — same as the source,
              // which fell through to rg on any unmappeable row
              throw new Error("malformed qmd search row");
            }
            // qmd returns qmd://<collection>/<rest> URIs — rewrite to root-relative
            let f = row.file;
            if (f.startsWith("qmd://")) f = f.replace(/^qmd:\/\/[^/]+\//, "");
            else if (f.startsWith("/")) f = f.slice(root.length + 1);
            if (!f.endsWith(".md")) continue;
            const hit: SearchHit = { path: f };
            if (typeof row.line === "number") hit.line = row.line;
            hit.snippet = clip(
              typeof row.snippet === "string" ? row.snippet : typeof row.title === "string" ? row.title : "",
              240,
            );
            if (typeof row.score === "number") hit.score = Math.round(row.score * 1000) / 1000;
            hits.push(hit);
          }
          return { hits: hits.slice(0, limit), provider: "qmd" };
        } catch {
          // fall through to rg
        }
      }
    }
    // rg fallback: filenames + content
    const hits: SearchHit[] = [];
    const rgArgs = ["-i", "--max-count", "3", "-l"];
    if (scope) rgArgs.push(scope);
    const byName = await run("rg", [...rgArgs, "--glob", "*.md", "-g", "!.obsidian", query], { cwd: root, timeoutMs: 15_000 });
    if (byName.code === 0 && byName.stdout.trim()) {
      for (const p of byName.stdout.split("\n").filter(Boolean).slice(0, limit)) {
        hits.push({ path: p, snippet: "(filename/content match)" });
      }
    }
    if (hits.length === 0) {
      const fuzzy = await run("rg", ["-i", "-l", "--glob", "*.md", "-g", "!.obsidian", query.replace(/\s+/g, "|")], { cwd: root, timeoutMs: 15_000 });
      if (fuzzy.code === 0 && fuzzy.stdout.trim()) {
        for (const p of fuzzy.stdout.split("\n").filter(Boolean).slice(0, limit)) {
          hits.push({ path: p, snippet: "(any-term match)" });
        }
      }
    }
    const skipped = opts.prefer === "rg" ? "qmd bypassed (prefer=rg)" : undefined;
    return { hits, provider: "rg", ...(skipped !== undefined ? { skipped } : {}) };
  }

  /** rg-based content search with line numbers and context — for read paths. */
  async function rgContext(root: string, query: string, opts: RgContextOptions = {}): Promise<SearchHit[]> {
    const limit = Math.min(opts.limit ?? 12, 50);
    const args = ["-i", "--max-count", String(limit), "-n", "-C", String(opts.context ?? 1), "--glob", "*.md", "-g", "!.obsidian"];
    if (opts.scope) args.push(opts.scope.replace(/^\/+/, ""));
    args.push(query);
    const r = await run("rg", args, { cwd: root, timeoutMs: 15_000 });
    if (r.code !== 0) return [];
    const hits: SearchHit[] = [];
    let lastFile = "";
    for (const line of r.stdout.split("\n")) {
      const m = /^(.+?)(?:-(\d+)-|:(\d+):)(.*)$/.exec(line);
      if (!m) continue;
      const file = m[1]!;
      const ln = Number(m[2] ?? m[3] ?? 0);
      if (file !== lastFile) {
        hits.push({ path: file, line: ln, snippet: clip(m[4] ?? "", 240) });
        lastFile = file;
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  return { qmdAvailable, searchVault, rgContext };
}
