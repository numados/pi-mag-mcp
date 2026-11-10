/**
 * Machine requirements: what search-mcp needs, per provider, with the exact
 * install command.
 *
 * The table itself lives in `requirements.json` at the package root and is read
 * by two consumers: this module (for `providers {action:"doctor"}`, the
 * `--doctor` CLI and the tests) and `install.sh list` (via jq). Keeping one file
 * means the installer cannot advertise a different command than the doctor.
 * Nothing here installs anything.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

export const requirementSchema = z.object({
  provider: z.string().min(1),
  check: z.string().min(1),
  what: z.string().min(1),
  install: z.string().min(1).optional(),
  /** Package manager the install command needs (`brew`, `go`, `uv`). */
  manager: z.string().min(1).optional(),
  postSetup: z.array(z.string().min(1)).optional(),
  /** Required for the server's basic chains (rg, fd). */
  required: z.boolean().optional(),
  /** True when the binary can exist without a working subscription/login. */
  auth: z.boolean().optional(),
});

export type Requirement = z.infer<typeof requirementSchema>;

const fileSchema = z.object({ binaries: z.array(requirementSchema) });

export const REQUIREMENTS_URL = new URL("../requirements.json", import.meta.url);

export function parseRequirements(raw: unknown): Requirement[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`requirements.json is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  }
  return parsed.data.binaries;
}

export function loadRequirements(): Requirement[] {
  const text = readFileSync(REQUIREMENTS_URL, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`requirements.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRequirements(raw);
}
