/** Setup — the one owner of the config proposal and of the only write this
 *  package ever performs. Discovery finds candidates (its concern); setup
 *  decides what a config line for each of them looks like, merges that into
 *  the existing file without losing keys it does not own, and writes only
 *  under --confirm: backup beside the file, temp file + atomic rename, mode
 *  600. It never installs binaries, never touches `~/.pi/agent/mcp.json` and
 *  never writes `.knowledge-mcp.json` (that one is printed as a snippet —
 *  repo routing belongs to the repo). `qmd embed` is likewise only ever a
 *  printed suggestion.
 *
 *  Merge rules (owned here): existing sources stay untouched, new candidates
 *  are added (a copy as `writable:false`), `defaultVaults`/`taskVault` are
 *  composed only when the file does not already carry them, unknown keys and
 *  every other setting pass through verbatim, and a second run over the
 *  written file proposes nothing and writes nothing. */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { centralConfigPath, loadConfig } from "./config.js";
import { collectionName } from "./collections.js";
import type { Candidate } from "./discover.js";
import type { Runner } from "./search.js";
import { run as defaultRun } from "./subprocess.js";
import type { ConfigLoadResult, Source } from "./types.js";
import { isPlainObject } from "./types.js";

export interface SetupGroup {
  name: string;
  paths: string[];
}

export interface SetupProject {
  prefix: string;
  source: string;
}

export interface SetupDeps {
  discovery: { scan(): Promise<Candidate[]> };
  /** Config file to merge into (default: the central config path). */
  configPath?: string;
  /** Config loader (default: loadConfig — honours KNOWLEDGE_MCP_CONFIG). */
  load?: () => ConfigLoadResult;
  confirm: boolean;
  force: boolean;
  qmd: boolean;
  json: boolean;
  groups?: SetupGroup[];
  taskVault?: string;
  projects?: SetupProject[];
  /** Bounded argv runner for the --qmd steps (default: subprocess run). */
  run?: Runner;
  now?: () => number;
}

export interface QmdStep {
  source: string;
  label: string;
  root: string;
  collection: string;
}

export interface SetupPlan {
  /** The proposed config file content (data; apply() serializes it). */
  config: Record<string, unknown>;
  text: string;
  /** Executable argv forms (qmd collection add / qmd update); embed is never here. */
  commands: string[][];
  /** False when the proposal equals the existing file (apply writes nothing). */
  changed: boolean;
  qmdSteps: QmdStep[];
  toJson(): string;
}

export interface ApplyResult {
  written: boolean;
  backup: string | null;
  /** stderr lines: what happened, per-root qmd failures included. */
  notes: string[];
  /** Number of failed qmd steps. */
  failed: number;
  /** Refusal reason (malformed config without --force and the like). */
  error: string | null;
}

interface NewSource {
  name: string;
  /** String form for one root, `{paths:[...]}` for several, `{path, writable:false}` for a copy. */
  value: string | { paths: string[] } | { path: string; writable: false };
  roots: Array<{ path: string; label: string }>;
  copy: boolean;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  return false;
}

/** Labels from basenames, deduplicated with -2, -3… — the same convention
 *  config.ts applies to defaulted labels, so the names setup proposes are the
 *  names the loaded config (and the collection naming) will use. */
export function dedupeLabels(paths: string[]): string[] {
  const taken = new Set<string>();
  return paths.map((p) => {
    const base = basename(p);
    let label = base;
    let n = 2;
    while (taken.has(label)) label = `${base}-${n++}`;
    taken.add(label);
    return label;
  });
}

function dedupeName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  taken.add(name);
  return name;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** An existing source definition counts as a copy when it opts out of writes. */
function isCopyDefinition(def: unknown): boolean {
  return isPlainObject(def) && def.writable === false;
}

export function createSetup(deps: SetupDeps) {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;

  function configPathOf(): string {
    return deps.configPath ?? centralConfigPath();
  }

  function loadResult(): ConfigLoadResult {
    const path = configPathOf();
    if (deps.load !== undefined) return deps.load();
    if (path === centralConfigPath()) return loadConfig();
    // same file choice the doctor uses: config.ts owns the loading rules
    const prev = process.env.KNOWLEDGE_MCP_CONFIG;
    process.env.KNOWLEDGE_MCP_CONFIG = path;
    try {
      return loadConfig();
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_MCP_CONFIG;
      else process.env.KNOWLEDGE_MCP_CONFIG = prev;
    }
  }

  /** The user's file as written, not the defaults-merged view — setup must
   *  not add keys the user never had. Malformed → null (refused at apply). */
  function readBaseFile(path: string): { base: Record<string, unknown> | null; malformedError: string | null } {
    if (!existsSync(path)) return { base: {}, malformedError: null };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isPlainObject(parsed)) return { base: null, malformedError: "config root must be a JSON object" };
      return { base: parsed, malformedError: null };
    } catch (error) {
      return { base: null, malformedError: error instanceof Error ? error.message : String(error) };
    }
  }

  async function plan(): Promise<SetupPlan> {
    const path = configPathOf();
    const load = loadResult();
    const { base, malformedError } = readBaseFile(path);
    const configFile = base ?? {};
    const warnings: string[] = [];
    if (malformedError !== null) {
      warnings.push(`existing config is malformed (${malformedError}) — re-run with --force to replace it`);
    }

    const candidates = await deps.discovery.scan();

    // ── selection ──────────────────────────────────────────────────────────
    const registered = new Map<string, { source: string; label: string }>();
    for (const source of load.config.sources) {
      for (const root of source.roots) registered.set(root.path, { source: source.name, label: root.label });
    }
    const takenNames = new Set<string>([
      ...Object.keys(isPlainObject(configFile.vaults) ? configFile.vaults : {}),
      ...load.config.sources.map((s) => s.name),
    ]);
    const newSources: NewSource[] = [];
    const notes: string[] = [];
    const consumed = new Set<string>(); // paths claimed by --group

    for (const group of deps.groups ?? []) {
      const paths = group.paths; // kept verbatim; the config normalizes roots on load
      for (const p of paths) consumed.add(p);
      const labels = dedupeLabels(paths);
      const name = dedupeName(group.name, takenNames);
      newSources.push({
        name,
        value: paths.length === 1 ? paths[0]! : { paths },
        roots: paths.map((p, i) => ({ path: p, label: labels[i]! })),
        copy: false,
      });
      notes.push(`group ${name}: ${paths.length} root${paths.length > 1 ? "s" : ""} (${labels.join(", ")})`);
    }

    for (const candidate of candidates) {
      const registeredAs = registered.get(candidate.path);
      if (registeredAs !== undefined) {
        notes.push(`skip ${candidate.path}: already registered as ${registeredAs.source}/${registeredAs.label}`);
        continue;
      }
      if (consumed.has(candidate.path)) continue;
      const insideRegistered = [...registered.keys()].find((rootPath) => candidate.path.startsWith(rootPath + "/"));
      if (insideRegistered !== undefined) {
        const owner = registered.get(insideRegistered)!;
        notes.push(`skip ${candidate.path}: inside registered root ${owner.source}/${owner.label}`);
        continue;
      }
      // a candidate whose whole note set lives in a nested candidate is a
      // wrapper — the nested one is the real source (this includes a wrapper
      // vault: indexing both would double-count every note)
      const wrapperOf = candidates.find(
        (other) => other !== candidate && other.path.startsWith(candidate.path + "/") && other.notes === candidate.notes,
      );
      if (wrapperOf !== undefined) {
        notes.push(`skip ${candidate.path}: wrapper — all ${candidate.notes} notes live in ${wrapperOf.path}`);
        continue;
      }
      const name = dedupeName(candidate.name, takenNames);
      newSources.push({
        name,
        value: candidate.copyOf !== undefined ? { path: candidate.path, writable: false } : candidate.path,
        roots: [{ path: candidate.path, label: name }],
        copy: candidate.copyOf !== undefined,
      });
      if (candidate.copyOf !== undefined) {
        notes.push(`copy ${candidate.path}: duplicate of ${candidate.copyOf} (${candidate.sharedNotes} shared notes) — proposed read-only`);
      }
    }

    // ── merge ──────────────────────────────────────────────────────────────
    const proposed: Record<string, unknown> = { ...configFile };
    const existingVaults = isPlainObject(configFile.vaults) ? configFile.vaults : {};
    const vaults: Record<string, unknown> = { ...existingVaults };
    for (const source of newSources) vaults[source.name] = source.value;
    proposed.vaults = vaults;

    const nonCopySources = [
      ...Object.entries(existingVaults).filter(([, def]) => !isCopyDefinition(def)).map(([name]) => name),
      ...newSources.filter((s) => !s.copy).map((s) => s.name),
    ];
    let composedDefaultVaults: string[] | null = null;
    if (!("defaultVaults" in configFile)) {
      if (nonCopySources.length > 0) {
        composedDefaultVaults = nonCopySources;
        proposed.defaultVaults = nonCopySources;
      }
    }

    if (!("taskVault" in configFile)) {
      let taskVault: string | undefined = deps.taskVault;
      if (taskVault !== undefined && !(taskVault in vaults)) {
        warnings.push(`--task-vault "${taskVault}" names no proposed source — ignored`);
        taskVault = undefined;
      }
      if (taskVault === undefined) {
        const defaults = "defaultVaults" in configFile && Array.isArray(configFile.defaultVaults)
          ? (configFile.defaultVaults as unknown[])
          : composedDefaultVaults;
        const first = defaults?.find((x): x is string => typeof x === "string" && x in vaults);
        if (first !== undefined) taskVault = first;
      }
      if (taskVault !== undefined) proposed.taskVault = taskVault;
    }

    if ((deps.projects ?? []).length > 0) {
      const projects: Record<string, string> = {
        ...(isPlainObject(configFile.projects) ? (configFile.projects as Record<string, string>) : {}),
      };
      for (const project of deps.projects ?? []) {
        if (!(project.source in vaults)) {
          warnings.push(`--project ${project.prefix}=${project.source}: unknown source "${project.source}" — skipped`);
          continue;
        }
        projects[project.prefix] = project.source;
      }
      proposed.projects = projects;
    }

    // ── qmd steps and commands ─────────────────────────────────────────────
    const qmdSteps: QmdStep[] = [];
    for (const source of newSources) {
      const asSource: Source = { name: source.name, roots: source.roots.map((r) => ({ ...r, writable: true, qmd: null })) };
      for (const root of asSource.roots) {
        qmdSteps.push({
          source: source.name,
          label: root.label,
          root: root.path,
          collection: collectionName(asSource, root),
        });
      }
    }
    const commands: string[][] = [];
    for (const step of qmdSteps) {
      commands.push(["qmd", "collection", "add", step.collection]);
      commands.push(["qmd", "update"]);
    }

    const changed = !deepEqual(proposed, configFile);
    const text = renderPlan({ path, proposed, configFile, newSources, candidates, notes, warnings, qmdSteps, changed, confirm: deps.confirm, qmd: deps.qmd, composedDefaultVaults, taskVault: typeof proposed.taskVault === "string" ? proposed.taskVault : null, defaultTaskRoot: load.config.defaultTaskRoot });

    return {
      config: proposed,
      text,
      commands,
      changed,
      qmdSteps,
      toJson: () => `${JSON.stringify({ changed, config: proposed, commands }, null, 2)}\n`,
    };
  }

  async function apply(planResult: SetupPlan): Promise<ApplyResult> {
    if (!deps.confirm) {
      return {
        written: false,
        backup: null,
        notes: ["preview only - nothing written; re-run with --confirm"],
        failed: 0,
        error: null,
      };
    }
    const path = configPathOf();
    const load = loadResult();
    if (load.state === "malformed" && !deps.force) {
      return {
        written: false,
        backup: null,
        notes: [],
        failed: 0,
        error: `config at ${path} is malformed (${load.error ?? "unparsable"}) — refusing to overwrite without --force`,
      };
    }

    const notes: string[] = [];
    let written = false;
    let backup: string | null = null;
    if (!planResult.changed) {
      notes.push("nothing to change - the config already matches the proposal");
    } else {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        backup = `${path}.bak.${stamp(now())}`;
        copyFileSync(path, backup);
        chmodSync(backup, 0o600);
        notes.push(`backup: ${backup}`);
      }
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(planResult.config, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      written = true;
      notes.push(`config written: ${path}`);
    }

    let failed = 0;
    if (deps.qmd) {
      if (planResult.qmdSteps.length === 0) {
        notes.push("qmd: no new sources - nothing to index");
      }
      for (const step of planResult.qmdSteps) {
        const add = await run("qmd", ["collection", "add", step.collection], { cwd: step.root, timeoutMs: 60_000 });
        if (add.code !== 0) {
          failed++;
          notes.push(`qmd collection add failed for ${step.source}/${step.label}: ${firstLine(add.stderr || add.stdout) || `exit ${add.code}`}`);
          continue; // this root is reported and skipped; the rest still run
        }
        notes.push(`qmd: collection ${step.collection} registered (${step.source}/${step.label})`);
        const update = await run("qmd", ["update"], { cwd: step.root, timeoutMs: 120_000 });
        if (update.code !== 0) {
          failed++;
          notes.push(`qmd update failed for ${step.source}/${step.label}: ${firstLine(update.stderr || update.stdout) || `exit ${update.code}`}`);
          continue;
        }
        notes.push(`qmd: index updated for ${step.source}/${step.label}`);
      }
      if (planResult.qmdSteps.length > 0) {
        // embed pulls a ~300MB model — it is a printed suggestion, never a step
        notes.push(`suggestion only (never run automatically): qmd embed -c <collection>`);
      }
    }

    return { written, backup, notes, failed, error: null };
  }

  return { plan, apply };
}

// ── plan text ─────────────────────────────────────────────────────────────

interface PlanTextInput {
  path: string;
  proposed: Record<string, unknown>;
  configFile: Record<string, unknown>;
  newSources: NewSource[];
  candidates: Candidate[];
  notes: string[];
  warnings: string[];
  qmdSteps: QmdStep[];
  changed: boolean;
  confirm: boolean;
  qmd: boolean;
  composedDefaultVaults: string[] | null;
  taskVault: string | null;
  defaultTaskRoot: string | null;
}

function renderPlan(input: PlanTextInput): string {
  const lines: string[] = [];
  const mode = input.confirm ? "apply" : "preview (nothing is written without --confirm)";
  lines.push(`knowledge-mcp setup - ${mode}`, "");

  if (input.candidates.length === 0 && input.newSources.length === 0) {
    lines.push("discovered: nothing (try --roots, or lower --min-notes)");
  } else {
    lines.push("discovered:");
    for (const candidate of input.candidates) {
      const facts = [
        `${candidate.notes} notes`,
        candidate.obsidian ? "obsidian vault" : "note directory",
        candidate.newestMtimeDaysAgo === null ? "no notes yet" : `newest note ${candidate.newestMtimeDaysAgo} days ago`,
      ];
      const marks = [
        candidate.registeredAs !== null && candidate.registeredAs !== undefined
          ? `registered as ${candidate.registeredAs.source}/${candidate.registeredAs.label}`
          : null,
        candidate.nestedIn !== undefined ? `nested in ${candidate.nestedIn}` : null,
        candidate.copyOf !== undefined ? `copy of ${candidate.copyOf}` : null,
      ].filter(Boolean);
      lines.push(`  ${candidate.path} ("${candidate.name}") - ${facts.join(", ")}${marks.length > 0 ? ` [${marks.join("; ")}]` : ""}`);
    }
  }
  lines.push("");

  lines.push(`proposal (config: ${input.path}):`);
  if (input.newSources.length === 0) {
    lines.push("  no new sources");
  }
  for (const source of input.newSources) {
    const value = typeof source.value === "string" ? `"${source.value}"` : JSON.stringify(source.value);
    lines.push(`  + ${source.name}: ${value}${source.copy ? "  (copy - read-only)" : ""}`);
  }
  if (input.composedDefaultVaults !== null) {
    lines.push(`  defaultVaults: ${JSON.stringify(input.composedDefaultVaults)} (new)`);
  } else if ("defaultVaults" in input.configFile) {
    lines.push("  defaultVaults: kept as configured");
  }
  if (input.taskVault !== null) {
    lines.push(`  taskVault: "${input.taskVault}"${"taskVault" in input.configFile ? " (kept as configured)" : " (new)"}`);
  }
  lines.push("  every other key passes through unchanged");
  lines.push("");

  for (const note of input.notes) lines.push(`  note: ${note}`);
  for (const warning of input.warnings) lines.push(`  warning: ${warning}`);
  if (input.notes.length > 0 || input.warnings.length > 0) lines.push("");

  if (input.qmdSteps.length > 0) {
    lines.push("qmd collections (run with --setup --confirm --qmd; embed is never executed):");
    for (const step of input.qmdSteps) {
      lines.push(`  cd ${step.root} && qmd collection add ${step.collection}`);
      lines.push(`  cd ${step.root} && qmd update`);
    }
    lines.push(`  suggestion only: qmd embed -c <collection> (never run automatically)`);
    lines.push("");
  }

  const taskRoot = input.defaultTaskRoot ?? "tasks";
  const suggestedVault = input.taskVault ?? input.composedDefaultVaults?.[0] ?? "<source>";
  lines.push("repo routing (.knowledge-mcp.json is yours; it is never written here):", `  { "vault": "${suggestedVault}", "taskRoot": "${taskRoot}" }`, "");
  lines.push("registration of the server itself is separate: ../install.sh knowledge (~/.pi/agent/mcp.json is never touched)", "");

  if (!input.changed) lines.push("nothing to change - the config already matches this proposal");
  else if (!input.confirm) lines.push("apply with: node dist/cli.js --setup --confirm");
  else lines.push("writing the config now (backup + atomic rename)");
  return lines.join("\n");
}
