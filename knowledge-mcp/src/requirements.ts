/** Machine requirements: what knowledge-mcp needs on PATH, per binary, with
 *  the exact install command. The table itself lives in `requirements.json`
 *  next to `dist/` (resolved from the module URL, so any cwd works) and is
 *  read by two consumers: this module (the doctor, the tests) and
 *  `../install.sh list` via jq. One file means the installer can never
 *  advertise a different command than the doctor. Nothing here installs
 *  anything.
 *
 *  The table is the single owner of the requirement facts: which binary is
 *  checked (`check`), whether the server can work without it (`required`),
 *  what installs it (`install`) and which package manager that needs
 *  (`manager`). An entry with an `install` string but no `manager` (git)
 *  names no manager and needs nothing — the doctor reports it as `builtin`. */

import { readFileSync } from "node:fs";
import { z } from "zod";

const binarySchema = z.object({
  provider: z.string().min(1),
  check: z.string().min(1),
  install: z.string().min(1).optional(),
  /** Package manager the install command needs (`brew`, `npm`). */
  manager: z.string().min(1).optional(),
  /** True when the server cannot work without this binary (rg). */
  required: z.boolean().optional(),
  note: z.string().min(1).optional(),
});

const fileSchema = z.object({
  binaries: z.array(binarySchema),
  setup: z.object({ command: z.string().min(1), reason: z.string().min(1) }).optional(),
});

export type Requirement = z.infer<typeof binarySchema>;
export type SetupHint = z.infer<typeof fileSchema.shape.setup>;

export interface RequirementsFile {
  binaries: Requirement[];
  setup?: SetupHint;
}

/** requirements.json sits at the package root, i.e. next to `dist/`. */
export const REQUIREMENTS_URL = new URL("../requirements.json", import.meta.url);

export function parseRequirements(raw: unknown): RequirementsFile {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `requirements.json is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export function loadRequirements(url: URL = REQUIREMENTS_URL): RequirementsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    throw new Error(`requirements.json cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseRequirements(raw);
}
