/**
 * mdfind provider: machine-wide filename search through the macOS Spotlight
 * index. Probed by resolving the binary rather than spawning it, so a machine
 * without Spotlight simply reports the provider as unavailable.
 */

import { findOnPath, run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

const MDFIND = "/usr/bin/mdfind";

function mdfindBinary(): string | null {
  return findOnPath(MDFIND) ?? findOnPath("mdfind");
}

export const mdfindProvider: ProviderDef = {
  name: "mdfind",
  intents: ["files", "machine"],
  probe: async () => probeResult(mdfindBinary() !== null, "mdfind (macOS Spotlight) not present"),
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const binary = mdfindBinary();
    if (!binary) throw new Error("mdfind not available");
    const limit = query.limit ?? 50;
    // mdfind accepts a single -onlyin per call, so roots become separate calls.
    const targets = (query.roots ?? []).slice(0, 3);
    const hits: SearchHit[] = [];
    for (const root of targets.length > 0 ? targets : [undefined]) {
      const args = [...(root ? ["-onlyin", root] : []), "-name", query.query];
      const result = await run(binary, args, { timeoutMs: 15_000 });
      if (result.code !== 0) throw new Error(`mdfind exited ${result.code}: ${result.stderr.slice(0, 200)}`);
      for (const path of result.stdout.split("\n")) {
        if (!path) continue;
        hits.push({ path, kind: "name" });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },
  timeoutMs: 15_000,
};
