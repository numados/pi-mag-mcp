/**
 * Readiness report. Owns the requirement table (requirements.json) and the
 * verdict rules, so `devwork_status`, `--doctor` and `../install.sh list` all
 * read the same knowledge instead of restating it in bash.
 *
 * The report never contains a secret: it names the credential *source* and, in
 * ambient mode, the authenticated principal.
 */
import { readFileSync } from "node:fs";
import { allowedWriteOperations, type Installation } from "./installation.js";
import { buildContext, type Context, type ContextOptions } from "./context.js";
import { describeScope } from "./scope.js";
import type { ResolverDeps } from "./credentials.js";

interface Requirement {
  provider: string;
  check: string;
  what?: string;
  install?: string;
  manager?: string;
  required?: boolean;
}

interface RequirementsFile {
  binaries: Requirement[];
}

const requirementsUrl = new URL("../requirements.json", import.meta.url);

export function loadRequirements(): Requirement[] {
  try {
    const parsed = JSON.parse(readFileSync(requirementsUrl, "utf8")) as RequirementsFile;
    return Array.isArray(parsed.binaries) ? parsed.binaries : [];
  } catch {
    return [];
  }
}

export interface BinaryVerdict {
  check: string;
  present: boolean;
  what?: string;
  install?: string;
  required: boolean;
}

const defaultRun: ResolverDeps["run"] = async (command, args, timeoutMs) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(command, args, { timeout: timeoutMs });
  return stdout;
};

export async function probeBinaries(
  requirements: Requirement[] = loadRequirements(),
  run: ResolverDeps["run"] = defaultRun,
): Promise<BinaryVerdict[]> {
  const verdicts: BinaryVerdict[] = [];
  for (const requirement of requirements) {
    let present = false;
    try {
      await run(requirement.check, ["--version"], 5_000);
      present = true;
    } catch {
      present = false;
    }
    verdicts.push({
      check: requirement.check,
      present,
      ...(requirement.what !== undefined ? { what: requirement.what } : {}),
      ...(requirement.install !== undefined ? { install: requirement.install } : {}),
      required: requirement.required === true,
    });
  }
  return verdicts;
}

export interface DoctorReport {
  text: string;
  structured: Record<string, unknown>;
}

export async function doctorReport(options: ContextOptions = {}): Promise<DoctorReport> {
  const built = buildContext(options);
  if (!built.ok) {
    const text = [
      "devwork: NO INSTALLATION",
      "",
      built.error,
      "",
      `sources: ${built.sources.join(" > ") || "(none)"}`,
      ...(built.notes.length > 0 ? ["", ...built.notes] : []),
    ].join("\n");
    return { text, structured: { ok: false, status: "no-installation", error: built.error, sources: built.sources, notes: built.notes } };
  }
  return reportForContext(built.ctx, options);
}

export async function reportForContext(ctx: Context, options: ContextOptions = {}): Promise<DoctorReport> {
  const installation = ctx.installation;
  const [github, ado] = [await ctx.resolver.github(), await ctx.resolver.ado()];
  const jira = ctx.resolver.jira();
  const binaries = await probeBinaries(undefined, options.deps?.run);

  const identity: string[] = [];
  if (github.mode === "ambient") {
    const login = await ctx.github.whoami();
    identity.push(`github identity: ${login ?? "(unresolved — the token may be invalid)"}`);
  }
  if (ado.mode === "ambient") {
    const who = await ctx.ado.whoami();
    identity.push(`ado identity: ${who ?? "(unresolved — the az login may be missing)"}`);
  }

  const write = installation.write;
  const allowed = allowedWriteOperations(write);
  const writable = [...allowed];

  const lines = [
    `installation: ${installation.id}`,
    `profile:      ${installation.source}`,
    `repository:   ${installation.repositoryRoots.join(", ") || "(not pinned)"}`,
    `sources:      ${ctx.sources.join(" > ")}`,
    "",
    `default backend: ${installation.defaultBackend} · cache ${installation.cacheTtlSeconds}s · top ${installation.top}`,
    ...describeScope(installation),
    "",
    `github: ${github.mode === "token" ? "✓" : github.mode === "ambient" ? "✓ ambient" : "✗"} · ${github.source}`,
    `jira:   ${jira.mode === "token" ? "✓" : "✗"} · ${jira.source}`,
    `ado:    ${ado.mode === "token" ? "✓ PAT" : ado.mode === "ambient" ? "✓ ambient" : "✗"} · ${ado.source}`,
    ...(identity.length > 0 ? ["", ...identity] : []),
    "",
    write.policy === "read-only"
      ? "writes: DISABLED (write.policy is readonly)"
      : `writes: ${writable.length > 0 ? writable.join(", ") : "(none — write.allow is empty)"} · preview ${write.requirePreview ? "required" : "optional"}`,
  ];

  const notes = [...ctx.notes, ...github.notes, ...jira.notes, ...ado.notes];
  if (notes.length > 0) lines.push("", "notes:", ...notes.map((note) => `  - ${note}`));

  // Only requirements this installation can actually use are reported: the
  // CLIs exist for ambient auth, nothing else.
  const relevant = binaries.filter((binary) => {
    if (binary.check === "gh") return installation.github.auth === "ambient";
    if (binary.check === "az") return installation.ado.auth === "ambient";
    return true;
  });
  const missing = relevant.filter((binary) => !binary.present);
  if (missing.length > 0) {
    lines.push("", "machine:");
    for (const binary of missing) {
      lines.push(`  ✗ ${binary.check} — ${binary.what ?? ""}`.trimEnd());
      if (binary.install) lines.push(`      install: ${binary.install}`);
    }
  }

  return {
    text: lines.join("\n"),
    structured: {
      ok: true,
      status: "ready",
      installation: installation.id,
      profile: installation.source,
      repositoryRoots: installation.repositoryRoots,
      sources: ctx.sources,
      notes,
      defaultBackend: installation.defaultBackend,
      scope: {
        github: installation.github.auth === "off" ? "off" : installation.github.repositories,
        jira: installation.jira.auth === "off" ? "off" : { domain: installation.jira.domain ?? null, projects: installation.jira.projects },
        ado: installation.ado.auth === "off" ? "off" : { org: installation.ado.org ?? null, projects: installation.ado.projects },
      },
      credentials: {
        github: { mode: github.mode, source: github.source },
        jira: { mode: jira.mode, source: jira.source },
        ado: { mode: ado.mode, source: ado.source },
      },
      write: { policy: write.policy, allow: writable, requirePreview: write.requirePreview },
      requirements: binaries,
    },
  };
}

/** Short readiness line for the stderr banner; no secrets, no network. */
export function bannerLine(installation: Installation, sources: string[]): string {
  const enabled = [
    installation.github.auth === "off" ? null : `github(${installation.github.auth})`,
    installation.jira.auth === "off" ? null : `jira(${installation.jira.auth})`,
    installation.ado.auth === "off" ? null : `ado(${installation.ado.auth})`,
  ].filter((entry): entry is string => entry !== null);
  return (
    `[devwork] installation=${installation.id} · backends=${enabled.join(",") || "none"} · ` +
    `writes=${installation.write.policy} · profile=${sources[0] ?? installation.source}`
  );
}
