/**
 * zoekt provider: cross-repo trigram-index search (Sourcegraph's engine) over
 * the zoekt-webserver HTTP API. Disabled by default; enable it after
 * `go install .../zoekt`, indexing your roots and starting the webserver.
 *
 * The URL is read through a getter, so a config reload takes effect without
 * rebuilding the provider table (no module-level mutable state).
 */

import { truncate } from "../scope.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

const DEFAULT_URL = "http://localhost:6070";

export function createZoektProvider(getUrl: () => string | undefined): ProviderDef {
  const baseUrl = (): string => (getUrl() ?? DEFAULT_URL).replace(/\/+$/, "");

  return {
    name: "zoekt",
    intents: ["crossrepo"],
    probe: async () => {
      const url = baseUrl();
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
        // Any HTTP response means the webserver is up; 6xx is not a real answer.
        return probeResult(response.status < 600, `zoekt webserver unreachable at ${url}`);
      } catch {
        return probeResult(false, `zoekt webserver unreachable at ${url}`);
      }
    },
    search: async (query: SearchQuery): Promise<SearchHit[]> => {
      const limit = query.limit ?? 50;
      const maxSnippet = query.maxSnippet ?? 240;
      const url = `${baseUrl()}/api/search?q=${encodeURIComponent(query.query)}&num=${limit}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`zoekt HTTP ${response.status}`);
      const data: any = await response.json();

      const hits: SearchHit[] = [];
      for (const file of data?.Files ?? []) {
        const path = String(file?.FileName ?? file?.Repository ?? "");
        const lines: any[] = Array.isArray(file?.LineMatches) ? file.LineMatches : [];
        if (lines.length === 0) {
          hits.push({ path, kind: "crossrepo" });
        } else {
          for (const lineMatch of lines.slice(0, 3)) {
            hits.push({
              path,
              ...(lineMatch?.LineNumber ? { line: lineMatch.LineNumber } : {}),
              snippet: truncate(String(lineMatch?.Line ?? ""), maxSnippet),
              kind: "crossrepo",
            });
          }
        }
        if (hits.length >= limit) break;
      }
      return hits;
    },
    timeoutMs: 6_000,
  };
}
