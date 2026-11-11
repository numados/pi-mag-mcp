/** The five read tools. Handlers compute data over the resolved context;
 *  render.ts owns every response text. `knowledge_status` is a thin wrapper
 *  around the doctor (the single owner of readiness) — it restates no rule. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LIMITS, type LinksArgs, type ReadArgs, type SearchArgs, type StructureArgs } from "../contract.js";
import {
  conventions,
  err,
  resolveWikiTargetInSource,
  text,
  type Conventions,
  type SearchContext,
  type ToolContext,
  type ToolDeps,
} from "../context.js";
import { createDoctor } from "../doctor.js";
import { extractWikiLinks, parseNote, section } from "../md.js";
import {
  displayRel,
  renderConventions,
  renderGraph,
  renderHybridSingle,
  renderInventory,
  renderLexicalSingle,
  renderLinks,
  renderReadBody,
  renderReadMeta,
  renderReadOutline,
  renderReadSection,
  renderSearchGrouped,
  type GraphSeed,
  type OutgoingLink,
  type SearchGroup,
  type SkippedEntry,
} from "../render.js";
import { run as defaultRun } from "../subprocess.js";
import { safeResolve, vaultIndex } from "../safety.js";
import type { Root, SearchHit, Source, ToolResult } from "../types.js";

const metaCharsEscaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── knowledge_status ──────────────────────────────────────────────────────

/** The doctor owns every readiness verdict; the tool only renders it. */
export async function knowledgeStatus(deps: ToolDeps = {}): Promise<ToolResult> {
  const doctor = createDoctor({ run: deps.run ?? defaultRun });
  const report = await doctor.report();
  return text(doctor.render(report));
}

// ── knowledge_search ──────────────────────────────────────────────────────

const groupName = (source: Source, root: Root): string =>
  source.roots.length > 1 ? `${source.name} / ${root.label}` : source.name;

export async function knowledgeSearch(a: SearchArgs, ctx: SearchContext): Promise<ToolResult> {
  const mode = a.mode ?? "hybrid";
  const limit = Math.min(a.limit ?? LIMITS.limitDefault, LIMITS.limitMax);
  const multiSource = ctx.sources.length > 1;

  if (mode === "graph") return graphSearch(a.query, a.scope, ctx, multiSource);

  const groups: SearchGroup[] = [];
  const skipped: SkippedEntry[] = [];
  const searchedSources: Source[] = [];
  let anyQmd = false;
  // kept for the single-group byte-compatible formats of the source server
  let singleOutcome: { hits: SearchHit[]; provider: "qmd" | "rg"; skipped?: string } | null = null;
  let singleLexical: SearchHit[] | null = null;

  for (const source of ctx.sources) {
    const present = source.roots.filter((r) => isDir(r.path));
    if (present.length === 0) {
      skipped.push({ name: source.name, reason: "directory missing" });
      continue;
    }
    searchedSources.push(source);
    for (const root of source.roots) {
      const name = groupName(source, root);
      if (!present.includes(root)) {
        if (source.roots.length === 1) skipped.push({ name: source.name, reason: "directory missing" });
        else groups.push({ name, provider: "rg", hits: [], skipped: "directory missing" });
        continue;
      }
      if (mode === "lexical") {
        const hits = await ctx.search.rgContext(root.path, a.query, { ...(a.scope !== undefined ? { scope: a.scope } : {}), limit });
        singleLexical = hits;
        groups.push({ name, provider: "rg", hits });
        continue;
      }
      // hybrid: a root that opted out of qmd is still searched, by rg
      const out = await ctx.search.searchVault(root.path, a.query, {
        ...(a.scope !== undefined ? { scope: a.scope } : {}),
        limit,
        ...(root.qmd === false ? { prefer: "rg" as const } : {}),
      });
      if (out.provider === "qmd") anyQmd = true;
      singleOutcome = out;
      groups.push({ name, provider: out.provider, hits: out.hits });
    }
  }

  // names the caller asked for that are not configured are reported, not fatal
  for (const name of ctx.requested) {
    if (!ctx.sources.some((s) => s.name === name)) skipped.push({ name, reason: "unknown vault" });
  }

  // single source, single root, nothing skipped: the byte-compatible formats
  if (!multiSource && ctx.sources[0]?.roots.length === 1 && groups.length === 1 && skipped.length === 0) {
    return text(
      mode === "lexical" ? renderLexicalSingle(singleLexical ?? []) : renderHybridSingle(singleOutcome!),
    );
  }

  const vaults =
    searchedSources.length > 1
      ? searchedSources.map((s) => (s.roots.length > 1 ? `${s.name} (${s.roots.length} roots)` : s.name))
      : null;
  return text(
    renderSearchGrouped({
      vaults,
      groups,
      skipped,
      degraded: mode === "hybrid" && groups.some((g) => g.skipped === undefined) && !anyQmd,
      mode,
    }),
  );
}

async function graphSearch(
  query: string,
  scope: string | undefined,
  ctx: SearchContext,
  multiSource: boolean,
): Promise<ToolResult> {
  const prefix = (source: Source, root: Root, rel: string): string =>
    `${multiSource ? `${source.name}/` : ""}${displayRel(source, root, rel)}`;

  const seeds: Array<{ source: Source; root: Root; rel: string }> = [];
  for (const source of ctx.sources) {
    for (const root of source.roots) {
      if (!isDir(root.path)) continue;
      const hits = await ctx.search.rgContext(root.path, query, { ...(scope !== undefined ? { scope } : {}), limit: 3 });
      for (const rel of [...new Set(hits.map((h) => h.path))].slice(0, 3)) {
        seeds.push({ source, root, rel });
      }
    }
  }
  if (seeds.length === 0) return text(`no seed note for "${query}" — nothing to expand`);

  const blocks: GraphSeed[] = [];
  for (const seed of seeds) {
    let body = "";
    try {
      body = readFileSync(join(seed.root.path, seed.rel), "utf8");
    } catch {
      continue;
    }
    const outs = extractWikiLinks(body)
      .map((l) => resolveWikiTargetInSource(seed.source, l.target))
      .flatMap((r) => r.paths)
      .map((h) => prefix(seed.source, h.root, h.rel));
    const base = metaCharsEscaped(basename(seed.rel, ".md"));
    const backs: string[] = [];
    for (const root of seed.source.roots) {
      if (!isDir(root.path)) continue;
      const r = await ctx.run("rg", ["-l", "--glob", "*.md", "-e", `\\[\\[${base}`], {
        cwd: root.path,
        timeoutMs: 10_000,
      });
      if (r.code !== 0) continue;
      for (const p of r.stdout.split("\n").filter(Boolean)) {
        if (root === seed.root && p === seed.rel) continue;
        backs.push(prefix(seed.source, root, p));
      }
    }
    blocks.push({
      display: prefix(seed.source, seed.root, seed.rel),
      outgoing: [...new Set(outs)].slice(0, 15),
      backlinks: [...new Set(backs)].slice(0, 15),
    });
  }
  const vaults =
    multiSource && ctx.sources.length > 1
      ? ctx.sources.map((s) => (s.roots.length > 1 ? `${s.name} (${s.roots.length} roots)` : s.name))
      : null;
  return text(renderGraph(blocks, vaults));
}

// ── knowledge_read ────────────────────────────────────────────────────────

export async function knowledgeRead(a: ReadArgs, ctx: ToolContext): Promise<ToolResult> {
  const ref = ctx.resolveNoteRef(a.path, "read");
  const note = parseNote(readFileSync(ref.abs, "utf8"));
  const display = displayRel(ctx.source, ref.root, ref.rel);
  const maxChars = a.maxChars ?? LIMITS.maxCharsDefault;
  const part = a.part ?? "meta";
  if (part === "meta") return text(renderReadMeta(display, note));
  if (part === "outline") return text(renderReadOutline(display, note.body));
  if (part === "section") {
    if (!a.section) return err("part=section requires section=<heading text>");
    const s = section(note.body, a.section);
    return s !== null
      ? text(renderReadSection(display, a.section, s, maxChars))
      : err(`section "${a.section}" not found in ${display} (see part=outline)`);
  }
  return text(renderReadBody(display, note.body, maxChars));
}

// ── knowledge_links ───────────────────────────────────────────────────────

export async function knowledgeLinks(a: LinksArgs, ctx: ToolContext): Promise<ToolResult> {
  const ref = ctx.resolveNoteRef(a.path, "read");
  const display = displayRel(ctx.source, ref.root, ref.rel);
  const dir = a.direction ?? "both";

  let outgoing: OutgoingLink[] | null = null;
  if (dir === "out" || dir === "both") {
    const note = parseNote(readFileSync(ref.abs, "utf8"));
    outgoing = extractWikiLinks(note.body).map((l) => {
      const r = resolveWikiTargetInSource(ctx.source, l.target);
      const status =
        r.paths.length === 0
          ? "UNRESOLVED"
          : r.ambiguous
            ? `AMBIGUOUS (${r.paths.length})`
            : displayRel(ctx.source, r.paths[0]!.root, r.paths[0]!.rel);
      return {
        target: l.target,
        ...(l.section !== undefined ? { section: l.section } : {}),
        ...(l.alias !== undefined ? { alias: l.alias } : {}),
        status,
      };
    });
  }

  let backlinks: string[] | null = null;
  if (dir === "back" || dir === "both") {
    const base = metaCharsEscaped(basename(ref.abs, ".md"));
    backlinks = [];
    for (const root of ctx.source.roots) {
      if (!isDir(root.path)) continue;
      const r = await ctx.run("rg", ["-l", "--glob", "*.md", "-e", `\\[\\[${base}(#|\\]|\\|)`], {
        cwd: root.path,
        timeoutMs: 10_000,
      });
      if (r.code !== 0) continue;
      for (const p of r.stdout.split("\n").filter(Boolean)) {
        if (root === ref.root && p === ref.rel) continue;
        backlinks.push(displayRel(ctx.source, root, p));
      }
    }
  }

  return text(renderLinks({ display, outgoing, backlinks }));
}

// ── knowledge_structure ───────────────────────────────────────────────────

export async function knowledgeStructure(a: StructureArgs, ctx: ToolContext): Promise<ToolResult> {
  const action = a.action ?? "inventory";
  if (action === "conventions") return structureConventions(a, ctx);
  return structureInventory(ctx);
}

function structureConventions(a: StructureArgs, ctx: ToolContext): ToolResult {
  const scope = a.scope ?? ctx.config.knowledgeRoot ?? "";
  // the first root that contains the scope dir wins; roots are ordered
  let root = ctx.source.roots[0]!;
  let dirAbs: string | null = null;
  for (const r of ctx.source.roots) {
    try {
      const abs = safeResolve(r.path, scope, "read");
      if (existsSync(abs)) {
        root = r;
        dirAbs = abs;
        break;
      }
    } catch {
      /* escaping scope — try the next root */
    }
  }
  if (dirAbs === null) dirAbs = safeResolve(root.path, scope, "read"); // may throw, as in the source
  const c: Conventions = conventions(root.path, dirAbs);
  return text(renderConventions(scope, c));
}

async function structureInventory(ctx: ToolContext): Promise<ToolResult> {
  const multi = ctx.source.roots.length > 1;
  let notes = 0;
  let withFm = 0;
  let sampled = 0;
  const byTop = new Map<string, number>();
  for (const root of ctx.source.roots) {
    const idx = vaultIndex(root.path);
    for (const p of idx.all) {
      const rel = p.slice(root.path.length + 1);
      notes++;
      const top = rel.includes("/") ? rel.split("/")[0]! : "(root)";
      const key = multi ? `${root.label}/${top}` : top;
      byTop.set(key, (byTop.get(key) ?? 0) + 1);
      if (sampled < 300) {
        sampled++;
        try {
          const n = parseNote(readFileSync(p, "utf8"));
          if (n.frontmatter && Object.keys(n.frontmatter).length) withFm++;
        } catch {
          /* unreadable note — not counted */
        }
      }
    }
  }
  const qmd = await ctx.search.qmdAvailable();
  return text(
    renderInventory({
      vault: multi
        ? `${ctx.source.name} (${ctx.source.roots.map((r) => r.label).join(", ")})`
        : ctx.source.roots[0]!.path,
      notes,
      coveragePct: sampled ? Math.round((withFm / sampled) * 100) : 0,
      sampled,
      git: ctx.source.roots.some((r) => existsSync(join(r.path, ".git"))),
      qmd,
      folders: [...byTop.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    }),
  );
}
