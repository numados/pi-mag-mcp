/** Doctor — the single owner of the "what works, what is broken, what to do"
 *  verdicts. One computation, three consumers: `knowledge_status` (P5),
 *  `--doctor` and `--doctor --json`. The report is data; the renderer decides
 *  the text. Nothing here writes, installs or runs `qmd update` — the doctor
 *  only reads (PATH lookups, one `qmd collection list`, one
 *  `qmd collection show` per collection) and stays cheap: no index build for
 *  missing roots, no qmd calls at all when the binary is absent.
 *
 *  Verdict rules (this module owns them, the requirement table owns the
 *  facts): a binary is present/installable/blocked/builtin/disabled; a root
 *  is ok/missing/not a directory/unreadable/not writable; a qmd collection is
 *  ok/missing/stale path/stale index/drifted/disabled/unknown; roots may be
 *  nested in or a copy of another root. Machine evidence these catch: a
 *  collection registered on a dead path, an index that describes a vault that
 *  moved, a wrapper vault around a nested one, a cloud copy of the same
 *  notes. */

import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { collectionName, parseCollectionList, parseCollectionShow } from "./collections.js";
import { loadConfig } from "./config.js";
import { loadRepoContext } from "./repo-config.js";
import type { Requirement } from "./requirements.js";
import { loadRequirements } from "./requirements.js";
import { COPY_SAMPLE_LIMIT, copyOf, type NotePair } from "./overlap.js";
import type { Runner } from "./search.js";
import { safeResolve, vaultIndex } from "./safety.js";
import { taskRootOf, writeRoot } from "./sources.js";
import type { ConfigLoadResult, QmdSettings, RepoContext, Root, Source } from "./types.js";
import { isPlainObject } from "./types.js";
import { findOnPath } from "./subprocess.js";

// ── report shape ──────────────────────────────────────────────────────────

export type BinaryVerdict = "present" | "installable" | "blocked" | "builtin" | "disabled";

export interface BinaryReport extends Requirement {
  verdict: BinaryVerdict;
  /** Resolved binary path when present. */
  path?: string;
  /** The exact command / reason to act on. */
  detail?: string;
}

export type RootState = "ok" | "missing" | "not a directory" | "unreadable" | "not writable";

export type QmdState = "ok" | "missing" | "stale path" | "stale index" | "drifted" | "disabled" | "unknown";

export interface QmdReport {
  state: QmdState;
  /** Expected collection name (`<source>` / `<source>-<label>`); empty when qmd is off. */
  collection: string;
  /** Path the collection is registered on, when it was readable. */
  indexPath?: string;
  files?: number;
  updatedDaysAgo?: number;
  detail?: string;
}

export interface Overlap {
  /** `<source>/<label>` when that source has several roots, else `<source>`. */
  with: string;
  kind: "nested" | "copy";
  /** Shared note count (copy only). */
  shared?: number;
  /** Note count of the other (bigger) root (copy only). */
  otherNotes?: number;
}

export interface RootReport {
  label: string;
  path: string;
  state: RootState;
  /** Count of *.md under the root excluding hidden dirs (0 when not ok). */
  notes: number;
  obsidian: boolean;
  writable: boolean;
  bytes: number;
  qmd: QmdReport;
  overlaps: Overlap[];
}

export interface TaskRootReport {
  /** Vault-relative task workspace root ("" when none resolves). */
  rel: string;
  /** Label of the write root the workspace resolves in. */
  root: string;
  /** Labels of other roots that already contain `rel`. */
  elsewhere: string[];
  /** Problem-level detail that never fails the run, e.g. the resolves-in-root mismatch. */
  detail?: string;
}

export interface SourceReport {
  name: string;
  roots: RootReport[];
  default: boolean;
  taskVault: boolean;
  taskRoot: TaskRootReport | null;
  /** Hard problem owned by this source (e.g. taskVault has no writable root). */
  problem?: string;
}

export interface RepoReport {
  root: string | null;
  configPath: string | null;
  state: "ok" | "absent" | "malformed";
  errors: string[];
  taskRoot: TaskRootReport | null;
  knowledgeRoot: { rel: string; ok: boolean; detail?: string } | null;
}

export interface DoctorReport {
  config: {
    path: string;
    state: "ok" | "missing" | "malformed";
    error?: string;
    errors: string[];
    legacyDefaultVault: boolean;
    unknownKeys: string[];
    allowWrite: boolean;
  };
  binaries: BinaryReport[];
  sources: SourceReport[];
  repo: RepoReport;
  ok: boolean;
  problems: number;
}

export interface DoctorDeps {
  /** Bounded argv runner — used only for `qmd collection list/show`. */
  run: Runner;
  /** Config file to inspect (default: KNOWLEDGE_MCP_CONFIG / the central path). */
  configPath?: string;
  /** Anchor for the repo section (default: process.cwd()). */
  startDir?: string;
  /** Accepted for interface stability; the doctor itself needs no clock —
   *  index ages come from qmd's own "Updated: Xd ago" output. */
  now?: () => number;
  /** PATH lookup for binaries and their managers (default: findOnPath). */
  resolveOnPath?: (cmd: string) => string | null;
  /** Repo-context loader (default: loadRepoContext — spawns git). */
  loadRepo?: (startDir: string) => RepoContext;
  /** Requirement table (default: requirements.json). */
  requirements?: Requirement[];
}

export interface Doctor {
  report(): Promise<DoctorReport>;
  render(report: DoctorReport): string;
  renderJson(report: DoctorReport): string;
}

const KNOWN_CONFIG_KEYS = [
  "vaults", "defaultVaults", "defaultVault", "taskVault", "projects",
  "knowledgeRoot", "defaultTaskRoot", "allowWrite", "qmd",
];

const SETUP_HINT = "node dist/cli.js --setup";

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** Realpath when it exists, else the normalized path — comparing a registered
 *  collection path against a root must not depend on the dir still existing. */
function normPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Sum of file sizes under a directory, skipping hidden entries and symlinked
 *  dirs (no cycles). Only called for roots that are readable directories. */
function treeBytes(root: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const p = join(root, entry);
    try {
      const st = statSync(p);
      if (st.isDirectory()) total += treeBytes(p);
      else total += st.size;
    } catch {
      // unreadable entry — its bytes are simply not counted
    }
  }
  return total;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const overlapTarget = (source: Source, root: Root): string =>
  source.roots.length > 1 ? `${source.name}/${root.label}` : source.name;

interface FlatRoot {
  source: Source;
  root: Root;
  report: RootReport;
}

interface QmdRegistry {
  collections: Map<string, { files?: number; updatedMinutesAgo?: number }>;
  /** First line of the raw output when the list could not be parsed. */
  parseFailed: string | null;
}

// ── doctor ────────────────────────────────────────────────────────────────

export function createDoctor(deps: DoctorDeps): Doctor {
  const run = deps.run;
  const resolveOnPath = deps.resolveOnPath ?? findOnPath;
  const loadRepo = deps.loadRepo ?? loadRepoContext;
  const requirements = deps.requirements ?? loadRequirements().binaries;

  function loadConfigResult(): ConfigLoadResult {
    if (deps.configPath === undefined) return loadConfig();
    // config.ts owns loading; the doctor only chooses which file it loads
    const prev = process.env.KNOWLEDGE_MCP_CONFIG;
    process.env.KNOWLEDGE_MCP_CONFIG = deps.configPath;
    try {
      return loadConfig();
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
      else process.env.KNOWLEDGE_MCP_CONFIG = prev;
    }
  }

  async function report(): Promise<DoctorReport> {
    let problems = 0;

    // 1. config
    const load = loadConfigResult();
    const cfg = load.config;
    const unknownKeys = Object.keys(cfg.raw).filter((k) => !KNOWN_CONFIG_KEYS.includes(k));
    if (load.state !== "ok") problems += 1;
    else if (cfg.sources.length === 0) problems += 1;
    problems += load.errors.length;
    const configSection: DoctorReport["config"] = {
      path: load.path,
      state: load.state,
      ...(load.error !== undefined ? { error: load.error } : {}),
      errors: load.errors,
      legacyDefaultVault: cfg.defaultVault !== null,
      unknownKeys,
      allowWrite: cfg.allowWrite,
    };

    // 2. binaries
    const binaries: BinaryReport[] = [];
    for (const req of requirements) {
      const judged = judgeBinary(req, cfg.qmd.enabled);
      binaries.push(judged.report);
      if (judged.required && judged.verdict !== "present") problems += 1;
    }
    const qmdPresent = binaries.find((b) => b.provider === "qmd")?.verdict === "present";

    // 3. sources and roots
    const sources: SourceReport[] = [];
    const flatRoots: FlatRoot[] = [];
    for (const source of cfg.sources) {
      const sourceReport: SourceReport = {
        name: source.name,
        roots: [],
        default: cfg.defaultVaults.includes(source.name),
        taskVault: cfg.taskVault === source.name,
        taskRoot: null,
      };
      for (const root of source.roots) {
        const rootReport = inspectRoot(root);
        if (rootReport.state !== "ok" && rootReport.state !== "not writable") problems += 1;
        if (rootReport.state === "not writable" && cfg.allowWrite) problems += 1;
        sourceReport.roots.push(rootReport);
        flatRoots.push({ source, root, report: rootReport });
      }
      sources.push(sourceReport);
    }

    // 4. qmd collections — inspected only when the binary is present
    if (qmdPresent) {
      const registry = await listRegistry();
      for (const entry of flatRoots) {
        entry.report.qmd = await qmdVerdict(entry, registry, cfg.qmd);
      }
    } else {
      for (const { report, root } of flatRoots) {
        report.qmd =
          cfg.qmd.enabled === false || root.qmd === false
            ? { state: "disabled", collection: "", detail: disabledReason(root, cfg.qmd.enabled) }
            : { state: "unknown", collection: "", detail: "qmd binary not available" };
      }
    }

    // 5. overlaps: nesting (pure path math, works for missing roots) then copies
    for (const inner of flatRoots) {
      for (const outer of flatRoots) {
        if (inner === outer) continue;
        if (contains(outer.root.path, inner.root.path)) {
          inner.report.overlaps.push({ with: overlapTarget(outer.source, outer.root), kind: "nested" });
        }
      }
    }
    const samples = new Map<RootReport, NotePair[]>();
    for (const entry of flatRoots) {
      if (entry.report.state === "ok") samples.set(entry.report, sampleNotes(entry));
    }
    for (const smaller of flatRoots) {
      const sampleA = samples.get(smaller.report);
      if (sampleA === undefined) continue;
      for (const bigger of flatRoots) {
        if (bigger === smaller) continue;
        const sampleB = samples.get(bigger.report);
        if (sampleB === undefined) continue;
        const shared = copyOf(sampleA, sampleB, smaller.report.notes, bigger.report.notes);
        if (shared !== null) {
          smaller.report.overlaps.push({
            with: overlapTarget(bigger.source, bigger.root),
            kind: "copy",
            shared,
            otherNotes: bigger.report.notes,
          });
        }
      }
    }

    // 6. taskVault source: write root + task workspace
    const repoCtx = loadRepo(deps.startDir ?? process.cwd());
    const taskVaultSource = cfg.taskVault !== null ? cfg.sources.find((s) => s.name === cfg.taskVault) : undefined;
    let taskRootReport: TaskRootReport | null = null;
    if (taskVaultSource !== undefined) {
      const sourceReport = sources.find((s) => s.name === taskVaultSource.name)!;
      try {
        const write = writeRoot(taskVaultSource);
        try {
          const resolved = taskRootOf(taskVaultSource, repoCtx, cfg.defaultTaskRoot ?? undefined);
          taskRootReport = {
            rel: resolved.rel,
            root: write.label,
            elsewhere: resolved.elsewhere.map((r) => r.label),
            ...(resolved.elsewhere.length > 0
              ? {
                  detail:
                    `taskRoot "${resolved.rel}" resolves in root "${resolved.elsewhere[0]!.label}", ` +
                    `write root is "${write.label}"`,
                }
              : {}),
        };
        } catch (error) {
          // no task root resolvable at all — information, never a failure
          taskRootReport = {
            rel: "",
            root: write.label,
            elsewhere: [],
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        sourceReport.taskRoot = taskRootReport;
      } catch (error) {
        // writeRoot threw: every root of the taskVault is read-only
        sourceReport.problem = error instanceof Error ? error.message : String(error);
        problems += 1;
      }
    }

    // 7. repo layer
    const repo = inspectRepo(repoCtx, cfg, taskRootReport);
    if (repo.state === "malformed") problems += 1;

    return { config: configSection, binaries, sources, repo, ok: problems === 0, problems };
  }

  // ── section builders ────────────────────────────────────────────────────

  function judgeBinary(req: Requirement, qmdEnabled: boolean): { report: BinaryReport; verdict: BinaryVerdict; required: boolean } {
    const required = req.required ?? false;
    if (req.provider === "qmd" && !qmdEnabled) {
      return {
        report: { ...req, verdict: "disabled", detail: "disabled by config (qmd.enabled=false); search falls back to rg" },
        verdict: "disabled",
        required,
      };
    }
    const path = resolveOnPath(req.check);
    if (path !== null) return { report: { ...req, verdict: "present", path }, verdict: "present", required };
    if (req.manager !== undefined && resolveOnPath(req.manager) === null) {
      return {
        report: { ...req, verdict: "blocked", detail: `needs ${req.manager}, which is not on PATH` },
        verdict: "blocked",
        required,
      };
    }
    if (req.manager !== undefined) {
      return { report: { ...req, verdict: "installable", detail: `install: ${req.install}` }, verdict: "installable", required };
    }
    return {
      report: { ...req, verdict: "builtin", detail: req.install ?? "no install command for this platform" },
      verdict: "builtin",
      required,
    };
  }

  function inspectRoot(root: Root): RootReport {
    let state: RootState = "ok";
    let notes = 0;
    let bytes = 0;
    let obsidian = false;
    if (!existsSync(root.path)) {
      state = "missing";
    } else {
      try {
        if (!statSync(root.path).isDirectory()) state = "not a directory";
      } catch {
        state = "unreadable";
      }
      if (state === "ok") {
        try {
          readdirSync(root.path);
        } catch {
          state = "unreadable";
        }
      }
      // the write gate (allowWrite) decides later whether this counts as a problem
      if (state === "ok" && root.writable !== false) {
        try {
          accessSync(root.path, constants.W_OK);
        } catch {
          state = "not writable";
        }
      }
      // a not-writable directory is still readable — its facts stay true
      if (state === "ok" || state === "not writable") {
        obsidian = existsSync(join(root.path, ".obsidian"));
        notes = vaultIndex(root.path).all.length; // one index build per root
        bytes = treeBytes(root.path);
      }
    }
    return {
      label: root.label,
      path: root.path,
      state,
      notes,
      obsidian,
      writable: root.writable,
      bytes,
      qmd: { state: "unknown", collection: "" },
      overlaps: [],
    };
  }

  /** One `qmd collection list` for the whole report. Never updates anything. */
  async function listRegistry(): Promise<QmdRegistry> {
    const list = await run("qmd", ["collection", "list"], { timeoutMs: 8000 });
    if (list.code !== 0) {
      return {
        collections: new Map(),
        parseFailed: firstLine(list.stderr || list.stdout) || `qmd collection list exited ${list.code}`,
      };
    }
    const parsed = parseCollectionList(list.stdout);
    if (parsed === null) {
      return { collections: new Map(), parseFailed: firstLine(list.stdout) || "unrecognized qmd collection list output" };
    }
    return { collections: parsed, parseFailed: null };
  }

  function disabledReason(root: Root, qmdEnabled: boolean): string {
    if (root.qmd === false) return "root opts out of qmd (qmd: false)";
    if (!qmdEnabled) return "qmd disabled by config (qmd.enabled=false)";
    return "qmd disabled";
  }

  /** No collection carries the expected name. That splits into two cases worth
   *  telling apart: qmd still indexes these notes under a collection left from
   *  an earlier location (a moved index, so the root is *stale path*), or the
   *  root was never indexed and the fix is one command. A collection that
   *  points at another live directory is not a moved index and is ignored. */
  async function missingVerdict(entry: FlatRoot, registry: QmdRegistry, expected: string): Promise<QmdReport> {
    const { root } = entry;
    const base = { collection: expected };
    const wanted = [basename(root.path).toLowerCase(), root.label.toLowerCase()];
    const candidates = [...registry.collections.keys()]
      .filter((name) => name !== expected && wanted.includes(name.toLowerCase()))
      .slice(0, 3);
    for (const name of candidates) {
      const show = await run("qmd", ["collection", "show", name], { timeoutMs: 8000 });
      if (show.code !== 0) continue;
      const registered = parseCollectionShow(show.stdout);
      if (registered === null || normPath(registered) === normPath(root.path)) continue;
      if (existsSync(registered)) continue;
      return {
        state: "stale path",
        ...base,
        indexPath: registered,
        detail: `collection "${name}" still points at ${registered} (gone); qmd collection remove ${name} && qmd collection add ${expected}`,
      };
    }
    return {
      state: "missing",
      ...base,
      detail: `run: cd ${root.path} && qmd collection add ${expected} && qmd update`,
    };
  }

  async function qmdVerdict(entry: FlatRoot, registry: QmdRegistry, qmd: QmdSettings): Promise<QmdReport> {
    const { source, root, report } = entry;
    const expected = collectionName(source, root);
    const base = { collection: expected };
    if (qmd.enabled === false || root.qmd === false) {
      return { state: "disabled", ...base, detail: disabledReason(root, qmd.enabled) };
    }
    if (registry.parseFailed !== null) {
      return { state: "unknown", ...base, detail: registry.parseFailed };
    }
    const summary = registry.collections.get(expected);
    if (summary === undefined) return await missingVerdict(entry, registry, expected);
    const details = {
      ...(summary.files !== undefined ? { files: summary.files } : {}),
      ...(summary.updatedMinutesAgo !== undefined
        ? { updatedDaysAgo: Math.round(summary.updatedMinutesAgo / 1440) }
        : {}),
    };
    const show = await run("qmd", ["collection", "show", expected], { timeoutMs: 8000 });
    if (show.code !== 0) {
      return {
        state: "unknown",
        ...base,
        ...details,
        detail: firstLine(show.stderr || show.stdout) || `qmd collection show exited ${show.code}`,
      };
    }
    const registeredPath = parseCollectionShow(show.stdout);
    if (registeredPath === null) {
      return { state: "unknown", ...base, ...details, detail: firstLine(show.stdout) || "no Path: line in qmd collection show" };
    }
    if (normPath(registeredPath) !== normPath(root.path)) {
      return {
        state: "stale path",
        ...base,
        indexPath: registeredPath,
        ...details,
        detail: `collection points at ${registeredPath}`,
      };
    }
    const staleAfterMinutes = qmd.updateTtlMinutes * 3;
    if (summary.updatedMinutesAgo !== undefined && summary.updatedMinutesAgo > staleAfterMinutes) {
      return {
        state: "stale index",
        ...base,
        indexPath: registeredPath,
        ...details,
        // the message stops at whole days — an exact age is noise at this granularity
        detail: `stale index: ${Math.max(1, Math.round(summary.updatedMinutesAgo / 1440))} days (refresh after ${staleAfterMinutes} min)`,
      };
    }
    if (summary.files !== undefined && report.state === "ok") {
      const drift = Math.abs(summary.files - report.notes);
      const threshold = Math.max(5, Math.round(report.notes * 0.1));
      if (drift > threshold) {
        return {
          state: "drifted",
          ...base,
          indexPath: registeredPath,
          ...details,
          detail: `drifted: ${summary.files} indexed vs ${report.notes} notes`,
        };
      }
    }
    return { state: "ok", ...base, indexPath: registeredPath, ...details };
  }

  function sampleNotes(entry: FlatRoot): NotePair[] {
    const pairs: NotePair[] = [];
    for (const abs of vaultIndex(entry.root.path).all.slice(0, COPY_SAMPLE_LIMIT)) {
      try {
        pairs.push({ rel: relative(entry.root.path, abs), size: statSync(abs).size });
      } catch {
        // vanished between listing and stat — skip the pair
      }
    }
    return pairs;
  }

  function inspectRepo(
    repoCtx: RepoContext,
    cfg: ConfigLoadResult["config"],
    taskRootReport: TaskRootReport | null,
  ): RepoReport {
    const errors: string[] = [];
    let state: RepoReport["state"] = "absent";
    if (repoCtx.configPath !== null && existsSync(repoCtx.configPath)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(repoCtx.configPath, "utf8"));
        if (isPlainObject(raw)) {
          state = "ok";
          for (const key of Object.keys(raw)) {
            if (!["vault", "taskRoot", "knowledgeRoot", "repo"].includes(key)) {
              errors.push(`unknown key "${key}" (whitelist: vault, taskRoot, knowledgeRoot, repo)`);
            }
          }
        } else {
          state = "malformed";
          errors.push("repo config root must be a JSON object");
        }
      } catch (error) {
        state = "malformed";
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // knowledgeRoot: the repo value wins over the central default; containment
    // is checked against the primary source's first root
    const knowledgeRel = repoCtx.config.knowledgeRoot ?? cfg.knowledgeRoot;
    let knowledgeRoot: RepoReport["knowledgeRoot"] = null;
    if (knowledgeRel !== null) {
      const primary =
        cfg.defaultVaults.length > 0
          ? cfg.sources.find((s) => s.name === cfg.defaultVaults[0])
          : (cfg.sources.find((s) => s.name === cfg.defaultVault) ?? cfg.sources[0]);
      if (primary === undefined) {
        knowledgeRoot = { rel: knowledgeRel, ok: false, detail: "no source to resolve against" };
      } else {
        const root = primary.roots[0]!;
        try {
          const abs = safeResolve(root.path, knowledgeRel, "read");
          knowledgeRoot = {
            rel: knowledgeRel,
            ok: true,
            ...(existsSync(abs) ? {} : { detail: `does not exist yet in ${primary.name}/${root.label}` }),
          };
        } catch (error) {
          knowledgeRoot = { rel: knowledgeRel, ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      }
    }

    return {
      root: repoCtx.repoRoot,
      configPath: repoCtx.configPath,
      state,
      errors,
      taskRoot: taskRootReport,
      knowledgeRoot,
    };
  }

  return {
    report,
    render: (r) => renderReport(r),
    renderJson: (r) => `${JSON.stringify(r, null, 2)}\n`,
  };
}

// ── renderer (plain ASCII lines) ──────────────────────────────────────────

const MARK: Record<BinaryVerdict, string> = {
  present: "[ok]     ",
  installable: "[install]",
  blocked: "[blocked]",
  builtin: "[builtin]",
  disabled: "[off]    ",
};

function renderReport(r: DoctorReport): string {
  const lines: string[] = [`knowledge-mcp doctor (node ${process.version})`, ""];

  // config
  const c = r.config;
  if (c.state === "ok") {
    lines.push(`config: ${c.path} - ok`);
  } else if (c.state === "missing") {
    lines.push(`config: ${c.path} - missing (no config file)`, `  create one: ${SETUP_HINT}`);
  } else {
    lines.push(`config: ${c.path} - malformed: ${c.error ?? "unparsable"}`, `  fix the file, or replace it: ${SETUP_HINT} --force --confirm`);
  }
  lines.push(`  allowWrite: ${c.allowWrite}`);
  if (c.unknownKeys.length > 0) lines.push(`  unknown keys: ${c.unknownKeys.join(", ")} (kept as-is; setup preserves them)`);
  if (c.legacyDefaultVault) lines.push("  legacy defaultVault is set - migrate to defaultVaults: [...] (the array wins when both exist)");
  for (const error of c.errors) lines.push(`  config error: ${error}`);
  lines.push("");

  // binaries
  lines.push("binaries:");
  for (const b of r.binaries) {
    const weight = b.required ? "required" : "optional";
    const what = b.path ?? b.detail ?? b.note ?? "";
    lines.push(`  ${MARK[b.verdict]} ${b.provider} (${weight}) - ${what}`);
  }
  lines.push("");

  // sources
  lines.push("sources:");
  if (r.sources.length === 0) {
    lines.push(`  none configured - run ${SETUP_HINT}`);
  }
  for (const s of r.sources) {
    const roles = [s.default ? "default" : null, s.taskVault ? "taskVault" : null].filter(Boolean).join(", ");
    lines.push(`  ${s.name} - ${s.roots.length} root${s.roots.length > 1 ? "s" : ""}${roles ? ` (${roles})` : ""}`);
    for (const root of s.roots) {
      const facts: string[] = [];
      if (root.state === "ok" || root.state === "not writable") {
        facts.push(`${root.notes} notes`, fmtBytes(root.bytes));
        if (root.obsidian) facts.push("obsidian");
        facts.push(root.state === "not writable" ? "writable per config, not on disk" : root.writable ? "writable" : "read-only");
      }
      lines.push(`    ${root.label}: ${root.state} - ${root.path}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`);
      lines.push(`      qmd: ${root.qmd.state}${qmdDetail(root.qmd)}`);
      for (const overlap of root.overlaps) {
        if (overlap.kind === "nested") lines.push(`      nested in ${overlap.with}`);
        else lines.push(`      copy of ${overlap.with}: ${overlap.shared}/${overlap.otherNotes} notes`);
      }
    }
    if (s.taskRoot !== null) {
      const elsewhere = s.taskRoot.elsewhere.length > 0 ? `; also exists in: ${s.taskRoot.elsewhere.join(", ")}` : "";
      lines.push(`    taskRoot: ${s.taskRoot.rel === "" ? "(unresolved)" : s.taskRoot.rel} in root "${s.taskRoot.root}"${elsewhere}`);
    }
    if (s.taskRoot?.detail !== undefined) lines.push(`    ! ${s.taskRoot.detail}`);
    if (s.problem !== undefined) lines.push(`    ! ${s.problem}`);
  }
  lines.push("");

  // repo
  const repo = r.repo;
  if (repo.state === "absent") {
    lines.push(`repo: no .knowledge-mcp.json${repo.root ? ` (git root: ${repo.root})` : ""} - absent (central config rules)`);
  } else {
    lines.push(`repo: ${repo.root} - ${repo.state} (${repo.configPath})`);
  }
  for (const error of repo.errors) lines.push(`  repo error: ${error}`);
  if (repo.taskRoot !== null && repo.taskRoot.rel !== "") {
    const elsewhere = repo.taskRoot.elsewhere.join(", ") || "none";
    lines.push(`  taskRoot: ${repo.taskRoot.rel} (root: ${repo.taskRoot.root}; elsewhere: ${elsewhere})`);
  }
  if (repo.knowledgeRoot !== null) {
    lines.push(
      `  knowledgeRoot: ${repo.knowledgeRoot.rel} - ${repo.knowledgeRoot.ok ? "ok" : "problem"}` +
        (repo.knowledgeRoot.detail ? ` (${repo.knowledgeRoot.detail})` : ""),
    );
  }
  lines.push("");

  // verdict
  if (r.problems === 0) lines.push("ok: no problems");
  else lines.push(`problems: ${r.problems}`);
  if (r.config.state !== "ok") lines.push(`next: ${SETUP_HINT}`);
  return lines.join("\n");
}

function qmdDetail(q: QmdReport): string {
  const parts: string[] = [];
  if (q.collection !== "") parts.push(q.collection);
  if (q.files !== undefined) parts.push(`${q.files} files`);
  if (q.updatedDaysAgo !== undefined) parts.push(`${q.updatedDaysAgo} days ago`);
  if (q.indexPath !== undefined && q.state === "ok") parts.push(q.indexPath);
  if (q.detail !== undefined) parts.push(q.detail);
  return parts.length > 0 ? ` - ${parts.join(", ")}` : "";
}
