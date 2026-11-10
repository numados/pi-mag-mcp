/**
 * rga provider: document search (PDF/Office/ebook/archives) through
 * ripgrep-all. Plain output mode: rga's adapters do not reliably stream rg
 * JSON, so lines are parsed in the "path[:line]:match" shape.
 */

import { truncate } from "../scope.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

export const rgaProvider: ProviderDef = {
  name: "rga",
  intents: ["docs"],
  probe: async () => {
    const result = await run("rga", ["--version"], { timeoutMs: 8_000 });
    return probeResult(result.code === 0, "rga not installed (brew install ripgrep-all)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const limit = query.limit ?? 50;
    const maxSnippet = query.maxSnippet ?? 240;
    const result = await run(
      "rga",
      [
        "--no-messages",
        ...(query.caseSensitive ? ["-s"] : ["-S"]),
        ...(query.pathGlob ? ["-g", query.pathGlob] : []),
        "--",
        query.query,
        ...(query.roots ?? []),
      ],
      { timeoutMs: 45_000 },
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`rga exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    }

    const hits: SearchHit[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const match = /^(.+?):(\d+)?:?(.*)$/.exec(line);
      const path = match?.[1];
      if (!path) continue;
      const lineNumber = match?.[2];
      hits.push({
        path,
        ...(lineNumber ? { line: Number(lineNumber) } : {}),
        snippet: truncate(match?.[3] ?? "", maxSnippet),
        kind: "doc",
      });
      if (hits.length >= limit) break;
    }
    return hits;
  },
  timeoutMs: 45_000,
};
