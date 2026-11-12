/**
 * Machine requirements: the local PDF toolchain office-mcp drives.
 *
 * The table itself lives in `requirements.json` at the package root and is the
 * single owner of the tool names, their install commands and which of them the
 * core operations need. Two consumers read it through this module: the doctor
 * (the `--doctor` report) and the PDF runtime (the missing-tools notes name the
 * exact install command instead of failing mid-run); `install.sh list` reads
 * the same file with jq. Keeping one file means the installer cannot advertise
 * a different command than the doctor or the tool errors. Nothing here installs
 * anything.
 *
 * The operation -> tools mapping is behaviour, not metadata; it lives in
 * `toolchain.ts`, shared by the runtime and the doctor.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const toolRequirementSchema = z.object({
  /** Binary the server runs; also the name looked up on PATH. */
  tool: z.string().min(1),
  what: z.string().min(1),
  /** Package name for the install command (`imagemagick`, `poppler`, …). */
  package: z.string().min(1),
  /** Package manager the install command needs (`brew`). */
  manager: z.string().min(1),
  required: z.boolean().optional(),
});

export type ToolRequirement = z.infer<typeof toolRequirementSchema>;

const fileSchema = z.object({ binaries: z.array(toolRequirementSchema) });

export const REQUIREMENTS_URL = new URL("../requirements.json", import.meta.url);

export function parseRequirements(raw: unknown): ToolRequirement[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `requirements.json is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`,
    );
  }
  return parsed.data.binaries;
}

export function loadRequirements(): ToolRequirement[] {
  const text = readFileSync(REQUIREMENTS_URL, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`requirements.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRequirements(raw);
}

export function requirementFor(entries: ToolRequirement[], tool: string): ToolRequirement | undefined {
  return entries.find((entry) => entry.tool === tool);
}

/** The exact install command for one tool. */
export function installCommandFor(entry: ToolRequirement): string {
  return `${entry.manager} install ${entry.package}`;
}

/**
 * One neutral command that installs the whole declared toolchain — the hint the
 * tools quote in their missing-tools notes. Derived from the table (unique
 * packages, table order) so it can never list a package the table does not.
 * The table declares a single manager today; a mixed table would need one
 * command per tool instead.
 */
export function toolchainInstallHint(entries: ToolRequirement[] = loadRequirements()): string {
  const manager = entries[0]?.manager ?? "brew";
  const packages = [...new Set(entries.map((entry) => entry.package))];
  return `${manager} install ${packages.join(" ")}`;
}
