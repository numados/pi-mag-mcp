/**
 * fd provider: fast filename search. The candidate list (PATH fd, then the
 * Pi-vendored `~/.pi/agent/bin/fd` copy — the normal case on a machine
 * bootstrapped by Pi rather than by brew) is owned by ../candidates.ts, which
 * the doctor shares, so the provider and the report cannot drift.
 */

import { candidateCommands } from "../candidates.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

let resolved: string | null = null;

/** Each candidate is verified by running it, in order: a PATH fd that exists
 *  but fails `--version` falls through to the vendored copy, not to failure. */
async function resolveFd(): Promise<string | null> {
  if (resolved) return resolved;
  for (const candidate of candidateCommands("fd")) {
    const result = await run(candidate, ["--version"], { timeoutMs: 5_000 });
    if (result.code === 0) {
      resolved = candidate;
      return candidate;
    }
  }
  return null;
}

export const fdProvider: ProviderDef = {
  name: "fd",
  intents: ["files", "docs"],
  probe: async () => {
    const binary = await resolveFd();
    return probeResult(!!binary, "fd not found (PATH or ~/.pi/agent/bin/fd)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const binary = await resolveFd();
    if (!binary) throw new Error("fd binary unavailable");
    const limit = query.limit ?? 50;
    const result = await run(
      binary,
      [
        "--max-results",
        String(limit),
        ...(query.caseSensitive ? ["--case-sensitive"] : []),
        "--",
        query.query,
        ...(query.roots ?? []),
      ],
      { timeoutMs: 15_000 },
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`fd exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    }
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, limit)
      .map((path) => ({ path, kind: "file" }));
  },
  timeoutMs: 15_000,
};
