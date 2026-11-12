/**
 * The local PDF toolchain: discovery, and which tools an operation needs.
 *
 * One owner for three kinds of knowledge, shared by the PDF runtime (`pdf.ts`)
 * and the doctor so neither restates it:
 * - the tool names and the version flag each answers — discovery runs a version
 *   flag and nothing else, so a readiness check can never mutate a PDF;
 * - where a tool may live when PATH lacks it (the Homebrew default prefixes,
 *   because Pi can start the server with a PATH that skips them);
 * - the operation -> tools mapping the runtime enforces and the doctor reports.
 *
 * Install hints, human labels and the `required` flags live in
 * requirements.json (loaded through ./requirements.ts); the tool names there
 * must match TOOL_NAMES, which the doctor test asserts.
 */

import { join } from "node:path";
import { PDF_OPERATIONS } from "./contract.js";
import { loadRequirements, requirementFor, toolchainInstallHint } from "./requirements.js";
import { runCommand, sanitizedEnv, SubprocessError } from "./subprocess.js";

export const TOOL_NAMES = ["magick", "gs", "ocrmypdf", "pdfinfo", "pdffonts"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Resolved command per tool, null when it could not be found. */
export type ToolPaths = Record<ToolName, string | null>;

/** The flag each binary answers without touching a document. */
export const VERSION_FLAG: Record<ToolName, string> = {
  magick: "-version",
  gs: "-version",
  ocrmypdf: "--version",
  pdfinfo: "-v",
  pdffonts: "-v",
};

/** Extra absolute locations probed when PATH lacks the binary. */
export const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/** Every command that may satisfy `tool`, in probe order: the PATH name first. */
export function candidateCommands(tool: ToolName, dirs: readonly string[] = FALLBACK_DIRS): string[] {
  return [tool, ...dirs.map((dir) => join(dir, tool))];
}

/** Asks one concrete command whether it works. Injectable for the tests. */
export type ToolProbe = (command: string, flag: string) => Promise<boolean>;

/**
 * Default probe: the binary's version flag, bounded, in the sanitized child
 * environment. A candidate that cannot be spawned is "not here"; any other
 * outcome means the binary exists but its version probe exited oddly, so it is
 * still usable.
 */
export const defaultProbe: ToolProbe = async (command, flag) => {
  try {
    await runCommand(command, [flag], { timeoutMs: 5_000, env: sanitizedEnv(), maxOutputBytes: 65_536 });
    return true;
  } catch (error) {
    if (error instanceof SubprocessError && error.kind === "not-found") return false;
    return true;
  }
};

/** The first candidate that answers its version flag, or null. */
export async function resolveTool(
  tool: ToolName,
  probe: ToolProbe = defaultProbe,
  dirs: readonly string[] = FALLBACK_DIRS,
): Promise<string | null> {
  for (const candidate of candidateCommands(tool, dirs)) {
    if (await probe(candidate, VERSION_FLAG[tool])) return candidate;
  }
  return null;
}

let cachedPaths: ToolPaths | null = null;

/** Resolve every tool once per process; the PDF runtime reuses the result. */
export async function toolPaths(): Promise<ToolPaths> {
  if (cachedPaths) return cachedPaths;
  const resolved = await Promise.all(TOOL_NAMES.map((tool) => resolveTool(tool)));
  cachedPaths = Object.fromEntries(TOOL_NAMES.map((tool, index) => [tool, resolved[index] ?? null])) as ToolPaths;
  return cachedPaths;
}

// ------------------------------------------------------ operation mapping

/** Every operation the server exposes: the pdf_clean vocabulary from
 *  contract.ts plus create_pdf, which shares the same tool table. */
export const OPERATIONS = ["create_pdf", ...PDF_OPERATIONS] as const;
export type Operation = (typeof OPERATIONS)[number];

/**
 * The tools each operation needs. `auto` needs the inspection pair to pick a
 * route; the operation it resolves to is then checked through the same table.
 */
export const OPERATION_TOOLS: Record<Operation, readonly ToolName[]> = {
  create_pdf: ["magick"],
  grayscale: ["gs"],
  optimize: ["gs"],
  bw: ["magick", "gs"],
  "clean-scan": ["ocrmypdf"],
  ocr: ["ocrmypdf"],
  info: ["pdfinfo", "pdffonts"],
  auto: ["pdfinfo", "pdffonts"],
};

/** The tools `operation` cannot run without, given the resolved paths. */
export function missingToolsFor(operation: Operation, paths: ToolPaths): ToolName[] {
  return OPERATION_TOOLS[operation].filter((tool) => paths[tool] === null);
}

/**
 * The missing-tools note the PDF runtime returns: package names from the
 * requirements table (deduplicated, so both poppler tools read as one
 * "poppler"), plus the one install command for the whole toolchain.
 */
export function missingToolsNote(operation: Operation, missing: readonly ToolName[]): string {
  const entries = loadRequirements();
  const labels = [...new Set(missing.map((tool) => requirementFor(entries, tool)?.package ?? tool))];
  return `Missing ${labels.join(", ")} for '${operation}'. Install with: ${toolchainInstallHint(entries)}.`;
}
