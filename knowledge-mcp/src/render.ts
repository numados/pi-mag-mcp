/** Text rendering — the one owner of every human-readable answer the tools
 *  return. Handlers compute data; this module decides the wording, so a text
 *  change cannot drift from tool to tool.
 *
 *  Compatibility rule (plan «Формат вывода»): a single source with a single
 *  root renders byte-identically to the source server — that output is quoted
 *  by the knowledge-vault skill. Grouping appears only where multiplicity
 *  does: several roots per source (`<source> / <label>` groups, root-relative
 *  paths inside) or several sources (`vaults:` header, `skipped:` lines,
 *  `note: degraded: lexical only` when qmd served no group). */

import { clip } from "./context.js";
import { outline, serializeYaml } from "./md.js";
import type { Heading, Note, SearchHit, Source, Root } from "./types.js";

// ── shared path display ───────────────────────────────────────────────────

/** `<label>/<rel>` when the source has several roots (the label is the
 *  addressing form), plain `<rel>` when it has one — byte-compatible. */
export function displayRel(source: Source, root: Root, rel: string): string {
  return source.roots.length > 1 ? `${root.label}/${rel}` : rel;
}

// ── search ────────────────────────────────────────────────────────────────

export interface SkippedEntry {
  name: string;
  reason: string;
}

function hybridHitLine(h: SearchHit, index: number): string {
  return `${index + 1}) ${h.path}${h.line ? ":" + h.line : ""}  ${h.snippet ?? ""}${h.score !== undefined ? `  [${h.score}]` : ""}`;
}

function lexicalHitLine(h: SearchHit, index: number): string {
  return `${index + 1}) ${h.path}:${h.line ?? "?"}  ${h.snippet ?? ""}`;
}

/** Single source, single root, hybrid — byte-identical to the source. */
export function renderHybridSingle(outcome: { hits: SearchHit[]; provider: "qmd" | "rg"; skipped?: string }): string {
  const head = `${outcome.provider}${outcome.skipped ? ` (skipped: ${outcome.skipped})` : ""}`;
  const body = outcome.hits.map(hybridHitLine).join("\n");
  return body ? `${head}\n${body}` : `${head}\nno matches (try other terms, or mode=graph)`;
}

/** Single source, single root, lexical — byte-identical to the source. */
export function renderLexicalSingle(hits: SearchHit[]): string {
  return (
    hits.map(lexicalHitLine).join("\n") ||
    "no matches (a failed search is not proof of absence — try other terms/scopes)"
  );
}

export interface SearchGroup {
  /** Group header: `<source>` or `<source> / <label>` (already decided). */
  name: string;
  provider: "qmd" | "rg";
  /** Root-relative hits. */
  hits: SearchHit[];
  /** Reason this root was not searched (directory missing). */
  skipped?: string;
}

export interface GroupedSearch {
  /** `vaults:` header entries; null when only one source was searched. */
  vaults: string[] | null;
  groups: SearchGroup[];
  skipped: SkippedEntry[];
  /** hybrid mode and no group was served by qmd. */
  degraded: boolean;
  /** per-hit line format follows the mode */
  mode: "hybrid" | "lexical";
}

const plural = (n: number): string => (n === 1 ? "hit" : "hits");

export function renderSearchGrouped(report: GroupedSearch): string {
  const lines: string[] = [];
  if (report.vaults !== null) lines.push(`vaults: ${report.vaults.join(", ")}`);
  const hitLine = report.mode === "lexical" ? lexicalHitLine : hybridHitLine;
  for (const g of report.groups) {
    if (g.skipped !== undefined) {
      lines.push(`${g.name} (skipped: ${g.skipped})`);
      continue;
    }
    lines.push(`${g.name} (${g.hits.length} ${plural(g.hits.length)}, ${g.provider})`);
    lines.push(...g.hits.map((h, index) => `  ${hitLine(h, index)}`));
  }
  for (const s of report.skipped) lines.push(`skipped: ${s.name} (${s.reason})`);
  if (report.degraded) lines.push("note: degraded: lexical only");
  return lines.join("\n");
}

export interface GraphSeed {
  /** Already display-prefixed seed path. */
  display: string;
  outgoing: string[];
  backlinks: string[];
}

export function renderGraph(seeds: GraphSeed[], vaults: string[] | null): string {
  const out: string[] = [];
  if (vaults !== null) out.push(`vaults: ${vaults.join(", ")}`);
  for (const s of seeds) {
    out.push(`# ${s.display}`);
    out.push(`outgoing: ${s.outgoing.join(", ") || "(none)"}`);
    out.push(`backlinks: ${s.backlinks.join(", ") || "(none)"}`);
    out.push("");
  }
  return out.join("\n");
}

// ── read ──────────────────────────────────────────────────────────────────

const headingLine = (h: Heading): string => `${"  ".repeat(h.level - 1)}- ${h.text} (:${h.line})`;

function summaryOf(body: string): string {
  const firstPara = body.split(/\n\s*\n/).find((p) => p.trim() && !p.startsWith("#")) ?? "";
  return clip(firstPara.trim(), 600);
}

export function renderReadMeta(display: string, note: Note): string {
  const fm =
    note.frontmatter && Object.keys(note.frontmatter).length
      ? serializeYaml(note.frontmatter)
      : "(no frontmatter)";
  const heads = outline(note.body);
  return [
    display,
    "",
    "--- frontmatter ---",
    fm,
    "--- outline ---",
    heads.map(headingLine).join("\n") || "(no headings)",
    "--- summary ---",
    summaryOf(note.body),
  ].join("\n");
}

export function renderReadOutline(display: string, body: string): string {
  return `${display}\n${outline(body).map(headingLine).join("\n")}`;
}

export function renderReadSection(display: string, name: string, body: string, maxChars: number): string {
  return `${display} § ${name}\n\n${clip(body, maxChars)}`;
}

export function renderReadBody(display: string, body: string, maxChars: number): string {
  return `${display}\n\n${clip(body, maxChars)}`;
}

// ── links ─────────────────────────────────────────────────────────────────

export interface OutgoingLink {
  target: string;
  section?: string;
  alias?: string;
  /** Resolved display path, `UNRESOLVED` or `AMBIGUOUS (n)`. */
  status: string;
}

export interface LinksView {
  display: string;
  /** null when direction=back. */
  outgoing: OutgoingLink[] | null;
  /** null when direction=out. */
  backlinks: string[] | null;
}

export function renderLinks(view: LinksView): string {
  const out: string[] = [view.display];
  if (view.outgoing !== null) {
    if (view.outgoing.length === 0) out.push("outgoing: (none)");
    else {
      out.push("outgoing:");
      for (const l of view.outgoing) {
        out.push(`  [[${l.target}${l.section ? "#" + l.section : ""}${l.alias ? "|" + l.alias : ""}]] → ${l.status}`);
      }
    }
  }
  if (view.backlinks !== null) {
    out.push(`backlinks (${view.backlinks.length}): ${view.backlinks.join(", ") || "(none)"}`);
  }
  return out.join("\n");
}

// ── structure ─────────────────────────────────────────────────────────────

export interface InventoryView {
  /** Root path (single root, source-compatible) or `name (labels)`. */
  vault: string;
  notes: number;
  coveragePct: number;
  sampled: number;
  git: boolean;
  qmd: boolean;
  folders: Array<{ count: number; name: string }>;
}

export function renderInventory(v: InventoryView): string {
  return [
    `vault: ${v.vault}`,
    `notes: ${v.notes}   frontmatter coverage: ${v.coveragePct}% (sampled ${v.sampled})`,
    `git: ${v.git ? "yes (history recoverable)" : "NO (no version history — retire/supersede markers are the only undo)"}   qmd: ${v.qmd ? "✓" : "–"}`,
    "",
    ...v.folders.map((f) => `  ${String(f.count).padStart(4)}  ${f.name}/`),
  ].join("\n");
}

export function renderConventions(
  scope: string,
  c: { frontmatterShare: number; sample: number; commonKeys: string[]; wikilinks: number; mdLinks: number; naming: string },
): string {
  const namingHint =
    c.naming === "spaces" ? "Title Case with spaces" : c.naming === "kebab" ? "kebab-case" : c.naming === "snake" ? "snake_case" : "plain words";
  return [
    `scope: ${scope || "(vault root)"}  (sampled ${c.sample} notes)`,
    `naming: ${namingHint}`,
    `frontmatter: ${Math.round(c.frontmatterShare * 100)}% of neighbours${c.commonKeys.length ? `; common keys: ${c.commonKeys.join(", ")}` : ""}`,
    `links: ${c.wikilinks} wikilinks vs ${c.mdLinks} md-links → write ${c.wikilinks >= c.mdLinks ? "[[wikilinks]]" : "[markdown links]"}`,
    `guidance: new notes here → ${namingHint} filename, ${c.frontmatterShare >= 0.5 ? `frontmatter with ${c.commonKeys.slice(0, 3).join("/") || "title"} keys` : "no frontmatter needed (match neighbours)"}, ${c.wikilinks >= c.mdLinks ? "[[wikilinks]]" : "md links"}.`,
  ].join("\n");
}

// ── write ─────────────────────────────────────────────────────────────────

export interface WritePreview {
  op: string;
  targetRel: string;
  vault: string;
  /** Present only when the source has several roots. */
  root?: string;
  format: string;
  warnings: string[];
  diff?: string[];
  newRaw?: string;
}

export function renderWritePreview(p: WritePreview): string {
  const head = [
    `op: ${p.op}   target: ${p.targetRel}`,
    `vault: ${p.vault}`,
    ...(p.root !== undefined ? [`root: ${p.root}`] : []),
    `format: ${p.format}`,
    ...(p.warnings.length ? p.warnings.map((w) => `⚠ ${w}`) : ["no warnings"]),
    "",
  ];
  const body =
    p.diff !== undefined
      ? `--- diff ---\n${p.diff.join("\n") || "(no changes?)"}`
      : `--- new note ---\n${clip(p.newRaw ?? "", 4000)}`;
  return [...head, body, "", "re-call with confirm:true to execute"].join("\n");
}

export interface WriteDone {
  op: string;
  targetRel: string;
  fmParses: boolean;
  rediscovered: boolean;
  warnings: string[];
}

export function renderWriteDone(d: WriteDone): string {
  return [
    `${d.op} OK: ${d.targetRel}`,
    `verification: re-read ${d.fmParses ? "frontmatter parses" : "(no frontmatter)"}; ${d.rediscovered ? "rediscovered by search" : "search did not rediscover yet (qmd TTL) — rg path checked"}`,
    ...(d.warnings.length ? d.warnings.map((w) => `⚠ ${w}`) : []),
  ].join("\n");
}

// ── move ──────────────────────────────────────────────────────────────────

export interface MovePreview {
  from: string;
  to: string;
  vault: string;
  fromRoot?: string;
  toRoot?: string;
  updateLinks: boolean;
  referencedBy: number;
  oldBase: string;
  /** Display-prefixed referencing paths. */
  affected: string[];
}

export function renderMovePreview(p: MovePreview): string {
  const lines = [
    `move: ${p.from} → ${p.to}`,
    `vault: ${p.vault}`,
    ...(p.fromRoot !== undefined ? [`from root: ${p.fromRoot}`] : []),
    ...(p.toRoot !== undefined ? [`to root: ${p.toRoot}`] : []),
    `link rewrite: ${p.updateLinks ? `${p.referencedBy} files reference [[${p.oldBase}]]` : "DISABLED — links will break"}`,
  ];
  if (p.affected.length) {
    lines.push("", "affected:", ...p.affected.slice(0, 30).map((a) => `  ${a}`));
    if (p.affected.length > 30) lines.push(`  … +${p.affected.length - 30} more`);
  }
  lines.push("", "re-call with confirm:true to execute");
  return lines.join("\n");
}

export interface MoveDone {
  from: string;
  to: string;
  rewritten: number;
  affected: number;
  chars: number;
}

export function renderMoveDone(d: MoveDone): string {
  return `moved: ${d.from} → ${d.to}\nlinks rewritten in ${d.rewritten}/${d.affected} files\nverification: destination re-read ${d.chars} chars OK`;
}

// ── task ──────────────────────────────────────────────────────────────────

export interface TaskStatusView {
  indexRel: string;
  taskId: string;
  status: string;
  updated: string;
  repository: string;
  currentPhase: string;
  title: string;
  repos: unknown;
  iterations: string[];
  latest: {
    link: string;
    stage: string;
    status: string;
    iteration: string;
    headings: Heading[];
    missing: boolean;
  } | null;
  wsRel: string;
  workspaceList: string;
}

export function renderTaskStatus(v: TaskStatusView): string {
  let latestHead = "(no latest_iteration link — legacy index)";
  if (v.latest !== null) {
    latestHead = v.latest.missing
      ? `${v.latest.link} (MISSING)`
      : `${v.latest.link}\n  stage: ${v.latest.stage}  status: ${v.latest.status}  iteration: ${v.latest.iteration}\n  ${v.latest.headings
          .slice(0, 6)
          .map((h) => `${"  ".repeat(h.level - 1)}- ${h.text}`)
          .join("\n  ")}`;
  }
  return [
    v.indexRel,
    `task_id: ${v.taskId}   status: ${v.status}   updated: ${v.updated}`,
    `repository: ${v.repository}   current_phase: ${v.currentPhase}`,
    `title: ${v.title}`,
    `repos: ${JSON.stringify(v.repos)}`,
    `iterations: ${v.iterations.length}${v.iterations.length ? ` (last: ${v.iterations[v.iterations.length - 1]})` : ""}`,
    "",
    `latest: ${latestHead}`,
    "",
    `workspace: ${v.wsRel}/${v.workspaceList}`,
  ].join("\n");
}

export interface TaskInitPreview {
  indexRel: string;
  vault: string;
  root?: string;
  raw: string;
}

export function renderTaskInitPreview(p: TaskInitPreview): string {
  return [
    `op: task-init   target: ${p.indexRel}`,
    `vault: ${p.vault}`,
    ...(p.root !== undefined ? [`root: ${p.root}`] : []),
    "",
    "--- new index ---",
    clip(p.raw, 2500),
    "",
    "re-call with confirm:true to execute",
  ].join("\n");
}

export interface TaskIterationPreview {
  rel: string;
  vault: string;
  root?: string;
  num: string;
  previous: string;
  prevStatus: string;
  indexProjection: string;
  raw: string;
}

export function renderTaskIterationPreview(p: TaskIterationPreview): string {
  return [
    `op: task-iteration   target: ${p.rel}`,
    `vault: ${p.vault}`,
    ...(p.root !== undefined ? [`root: ${p.root}`] : []),
    `sequence: ${p.num}   previous: ${p.previous}   prev status: ${p.prevStatus}`,
    p.indexProjection,
    "",
    "--- new event ---",
    clip(p.raw, 3000),
    "",
    "re-call with confirm:true to execute",
  ].join("\n");
}

export interface TaskUpdatePreview {
  indexRel: string;
  vault: string;
  root?: string;
  diff: string[];
}

export function renderTaskUpdatePreview(p: TaskUpdatePreview): string {
  return [
    `op: task-update   target: ${p.indexRel}`,
    `vault: ${p.vault}`,
    ...(p.root !== undefined ? [`root: ${p.root}`] : []),
    "",
    "--- diff ---",
    p.diff.join("\n") || "(no changes)",
    "",
    "re-call with confirm:true to execute",
  ].join("\n");
}

// ── repo map ──────────────────────────────────────────────────────────────

export interface RepoTaskLine {
  updated: string;
  status: string;
  id: string;
  title: string;
}

export interface RepoView {
  repo: string;
  /** Root path (single root) or source name (several roots). */
  vault: string;
  tasks: RepoTaskLine[];
  notes: string[];
  catalog: { entries: number } | null;
}

export function renderRepoMap(v: RepoView): string {
  const out = [`repo: ${v.repo}   (vault: ${v.vault})`, "", `task workspaces (${v.tasks.length}):`];
  for (const t of v.tasks) {
    out.push(`  ${t.updated}  ${t.status.padEnd(10)} ${t.id} — ${t.title}`);
  }
  out.push("");
  out.push(`concept notes mentioning it (${v.notes.length}):`);
  for (const p of v.notes.slice(0, 20)) out.push(`  ${p}`);
  if (v.catalog !== null) {
    out.push("");
    out.push(`repo-index catalog: ${v.catalog.entries ? `${v.catalog.entries} entr${v.catalog.entries === 1 ? "y" : "ies"}` : "no entry"}`);
  }
  return out.join("\n");
}
