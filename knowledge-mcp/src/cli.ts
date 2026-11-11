/** CLI surface of the server binary: `--doctor`, `--setup` and `--help`.
 *  stdout carries the report (or the proposal); diagnostics go to stderr;
 *  exit codes are contract: 0 = clean, 1 = report has problems (or a setup
 *  step failed), 2 = usage error. `runCli` returns null when no CLI mode was
 *  requested — the server entry (P6) uses that to start stdio instead. */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createDoctor } from "./doctor.js";
import { createDiscovery } from "./discover.js";
import { createSetup, type SetupGroup, type SetupProject } from "./setup.js";
import { run as defaultRun } from "./subprocess.js";

export type GroupOption = SetupGroup;
export type ProjectOption = SetupProject;

export interface CliOptions {
  doctor: boolean;
  setup: boolean;
  json: boolean;
  confirm: boolean;
  force: boolean;
  qmd: boolean;
  help: boolean;
  roots: string[];
  minNotes?: number;
  groups: GroupOption[];
  taskVault?: string;
  projects: ProjectOption[];
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `Usage: node dist/cli.js --doctor [--json]
       node dist/cli.js --setup [--confirm] [--force] [--qmd] [--json]
                          [--roots a,b] [--min-notes N]
                          [--group name=/p1,/p2] [--task-vault name]
                          [--project <dir-prefix>=<source>]

  --doctor            check binaries, config, sources and qmd collections;
                      exit 1 when anything required fails (writes nothing)
  --json              machine-readable output (with --doctor or --setup)
  --setup             discover knowledge directories and propose a config;
                      writes nothing without --confirm
  --confirm           with --setup: write the config (backup + atomic rename)
  --force             with --setup: replace a malformed config
  --qmd               with --setup: also run qmd collection add + qmd update
                      per new root (never qmd embed); without --confirm the
                      commands are only printed
  --roots a,b         discovery roots instead of the documented defaults
  --min-notes N       minimum .md count for a plain directory to qualify
                      (default 20)
  --group n=/p1,/p2   build one source from several directories with labels
                      from basenames (repeatable)
  --task-vault name   name the source that owns task workspaces
  --project pfx=src   add one projects entry (repeatable; never invented)
  --help              this text`;

const VALUE_FLAGS = new Set(["--roots", "--min-notes", "--group", "--task-vault", "--project"]);
const BOOL_FLAGS = new Set(["--doctor", "--setup", "--json", "--confirm", "--force", "--qmd", "--help"]);

function splitPair(value: string): [string, string] | null {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) return null;
  return [value.slice(0, eq), value.slice(eq + 1)];
}

/** Never throws: a usage problem is returned as errors and printed by runCli. */
export function parseArgs(argv: string[]): { options: CliOptions; errors: string[] } {
  const options: CliOptions = {
    doctor: false, setup: false, json: false, confirm: false, force: false, qmd: false, help: false,
    roots: [], groups: [], projects: [],
  };
  const errors: string[] = [];
  const takeValue = (args: string[], index: number, flag: string): { value: string; next: number } | null => {
    const inline = flag.includes("=");
    if (inline) return { value: flag.slice(flag.indexOf("=") + 1), next: index + 1 };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    return { value, next: index + 2 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const base = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!BOOL_FLAGS.has(base) && !VALUE_FLAGS.has(base)) {
      errors.push(`unknown argument "${arg}"`);
      continue;
    }
    if (BOOL_FLAGS.has(base)) {
      switch (base) {
        case "--doctor": options.doctor = true; break;
        case "--setup": options.setup = true; break;
        case "--json": options.json = true; break;
        case "--confirm": options.confirm = true; break;
        case "--force": options.force = true; break;
        case "--qmd": options.qmd = true; break;
        case "--help": options.help = true; break;
        default: errors.push(`unknown argument "${arg}"`);
      }
      continue;
    }
    const taken = takeValue(argv, i, arg);
    if (taken === null) {
      errors.push(`${base} needs a value`);
      continue;
    }
    i = taken.next - 1;
    switch (base) {
      case "--roots":
        options.roots.push(...taken.value.split(",").map((s) => s.trim()).filter(Boolean));
        break;
      case "--min-notes": {
        const n = Number(taken.value);
        if (!Number.isInteger(n) || n < 0) errors.push(`--min-notes needs a non-negative integer, got "${taken.value}"`);
        else options.minNotes = n;
        break;
      }
      case "--group": {
        const pair = splitPair(taken.value);
        const paths = pair?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        if (pair === null || paths.length === 0) errors.push(`--group needs name=/p1,/p2, got "${taken.value}"`);
        else options.groups.push({ name: pair[0], paths });
        break;
      }
      case "--task-vault":
        options.taskVault = taken.value;
        break;
      case "--project": {
        const pair = splitPair(taken.value);
        if (pair === null) errors.push(`--project needs <dir-prefix>=<source>, got "${taken.value}"`);
        else options.projects.push({ prefix: pair[0], source: pair[1] });
        break;
      }
      default: errors.push(`unknown argument "${arg}"`);
    }
  }
  return { options, errors };
}

/** Runs a CLI mode. Returns the exit code, or null when no CLI flag was given
 *  (the caller starts the server instead). */
export async function runCli(argv: string[], io: CliIo = { out: (l) => process.stdout.write(l), err: (l) => process.stderr.write(l) }): Promise<number | null> {
  const { options, errors } = parseArgs(argv);
  if (errors.length > 0) {
    for (const error of errors) io.err(`error: ${error}\n`);
    io.err(`${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (options.doctor) {
    const doctor = createDoctor({ run: defaultRun });
    const report = await doctor.report();
    io.out(options.json ? doctor.renderJson(report) : `${doctor.render(report)}\n`);
    return report.ok ? 0 : 1;
  }
  if (options.setup) {
    const discovery = createDiscovery({
      ...(options.roots.length > 0 ? { roots: options.roots } : {}),
      ...(options.minNotes !== undefined ? { minNotes: options.minNotes } : {}),
    });
    const setup = createSetup({
      discovery,
      confirm: options.confirm,
      force: options.force,
      qmd: options.qmd,
      json: options.json,
      ...(options.groups.length > 0 ? { groups: options.groups } : {}),
      ...(options.taskVault !== undefined ? { taskVault: options.taskVault } : {}),
      ...(options.projects.length > 0 ? { projects: options.projects } : {}),
    });
    const plan = await setup.plan();
    if (options.json) {
      io.out(plan.toJson());
    } else {
      io.out(`${plan.text}\n`);
    }
    if (!options.confirm) return 0;
    const result = await setup.apply(plan);
    for (const note of result.notes) io.err(`${note}\n`);
    if (result.error !== null) {
      io.err(`error: ${result.error}\n`);
      return 1;
    }
    return result.failed > 0 ? 1 : 0;
  }
  return null;
}

// direct execution: `node dist/cli.js --doctor` etc. (the server entry calls
// runCli itself and falls through to stdio on null)
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code === null) {
        process.stderr.write(`${USAGE}\n`);
        process.exit(2);
      }
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
