/**
 * ast-grep provider: structural (syntax-aware) code search over tree-sitter
 * grammars, JSON output. The probe requires an explicit self-identification, so
 * a different `sg` binary on PATH is never mistaken for ast-grep.
 */

import { truncate } from "../scope.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

export const astgrepProvider: ProviderDef = {
  name: "ast-grep",
  intents: ["structure", "semantic"],
  probe: async () => {
    const result = await run("ast-grep", ["--version"], { timeoutMs: 5_000 });
    const ok = result.code === 0 && /ast-grep/i.test(result.stdout);
    return probeResult(ok, "ast-grep not installed or not identifiable (brew install ast-grep)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    if (!query.lang) throw new Error("structure search requires lang (e.g. ts, tsx, py, rust, go)");
    const limit = query.limit ?? 50;
    const maxSnippet = query.maxSnippet ?? 240;
    const result = await run(
      "ast-grep",
      ["--json", "-p", query.query, "-l", query.lang, ...(query.roots ?? [])],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`ast-grep exited ${result.code}: ${result.stderr.slice(0, 300)}`);
    }

    let parsed: any[] = [];
    try {
      const json = JSON.parse(result.stdout);
      parsed = Array.isArray(json) ? json : (json?.matches ?? []);
    } catch {
      throw new Error(`ast-grep output not parseable: ${result.stdout.slice(0, 200)}`);
    }

    return parsed.slice(0, limit).map((match) => {
      const line = match?.range?.start?.line;
      return {
        path: String(match?.file ?? match?.path ?? ""),
        ...(typeof line === "number" ? { line: line + 1 } : {}),
        snippet: truncate(String(match?.text ?? match?.lines ?? ""), maxSnippet),
        kind: "structure",
      } satisfies SearchHit;
    });
  },
  timeoutMs: 30_000,
};
