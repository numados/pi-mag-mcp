/**
 * Candidate resolution: which concrete commands may satisfy one binary name.
 *
 * One owner, two consumers: the fd provider spawns the first candidate that
 * answers, and the doctor asks the same list whether any candidate is an
 * executable — without spawning anything, so a readiness report never runs the
 * toolchain it reports on. The rule "fd also resolves the copy Pi vendors under
 * ~/.pi/agent/bin" lives here and nowhere else: not in the provider, not in the
 * server's doctor wiring.
 *
 * The executable check itself is `findOnPath`, so platform behaviour (PATH
 * split, the X_OK check, how a bare name resolves on Windows) stays exactly
 * what that function already did.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "./subprocess.js";

/** Binaries the Pi agent vendors under ~/.pi/agent/bin when PATH lacks them. */
const VENDORED = new Set(["fd"]);

/** The vendored absolute copies for `command` (empty when none are vendored). */
export function vendoredCopies(command: string, home: string = homedir()): string[] {
  return VENDORED.has(command) ? [join(home, ".pi", "agent", "bin", command)] : [];
}

/** Every command that may satisfy `command`, in fallback order: the PATH name first. */
export function candidateCommands(command: string, home: string = homedir()): string[] {
  return [command, ...vendoredCopies(command, home)];
}

export interface CandidateOptions {
  /** Home directory the vendored copies live under (default: the real home). */
  home?: string;
  /** Executable lookup for one concrete command (default: findOnPath). */
  lookup?: (command: string) => string | null;
}

/**
 * The first candidate that exists and is executable, or null. This is the
 * doctor's availability check: candidates.ts owns the list, findOnPath owns the
 * per-command check, and neither spawns the binary.
 */
export function resolveCandidate(command: string, options: CandidateOptions = {}): string | null {
  const home = options.home ?? homedir();
  const lookup = options.lookup ?? findOnPath;
  for (const candidate of candidateCommands(command, home)) {
    const found = lookup(candidate);
    if (found !== null) return found;
  }
  return null;
}
