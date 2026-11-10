/**
 * serena provider: free, offline semantic fallback through LSP symbols
 * (`uvx --from git+https://github.com/oraios/serena ...`). One child per
 * project root, LRU-capped.
 *
 * The probe only proves that `uvx` exists; serena's real tool contract is
 * verified on the first call. If it differs, `find_symbol` falls back to
 * `search_for_pattern` and then the chain falls through to ast-grep/rg, so a
 * serena change degrades the answer instead of breaking the tool.
 */

import { truncate } from "../scope.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";
import { extractPaths, McpChildClient, resultText } from "./mcpchild.js";

const MAX_CLIENTS = 2;
const clients = new Map<string, McpChildClient>();

interface SerenaSymbol {
  name_path?: string;
  kind?: string;
  relative_path?: string;
  body_location?: { start_line?: number };
}

function clientFor(root: string): McpChildClient {
  const existing = clients.get(root);
  if (existing) {
    // refresh LRU order
    clients.delete(root);
    clients.set(root, existing);
    return existing;
  }

  const created = new McpChildClient(
    "uvx",
    [
      "--from",
      "git+https://github.com/oraios/serena",
      "serena",
      "start-mcp-server",
      "--context",
      "ide-assistant",
      "--project",
      root,
    ],
    root,
    120_000,
  );
  clients.set(root, created);

  while (clients.size > MAX_CLIENTS) {
    const oldest = clients.keys().next();
    if (oldest.done) break;
    clients.get(oldest.value)?.kill();
    clients.delete(oldest.value);
  }
  return created;
}

function hitsFromSymbols(root: string, body: string): SearchHit[] {
  const hits: SearchHit[] = [];
  let symbols: SerenaSymbol[];
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error("not a symbol list");
    symbols = parsed as SerenaSymbol[];
  } catch {
    // Not JSON (the search_for_pattern fallback) — recover paths from the text.
    for (const path of extractPaths(body).slice(0, 20)) hits.push({ path, kind: "symbol" });
    if (body) hits.push({ path: root, snippet: truncate(body, 1_800), kind: "summary" });
    return hits;
  }

  for (const symbol of symbols.slice(0, 20)) {
    if (!symbol.relative_path) continue;
    const line = symbol.body_location?.start_line;
    hits.push({
      path: `${root}/${symbol.relative_path}`,
      ...(typeof line === "number" ? { line } : {}),
      ...(symbol.name_path ? { snippet: symbol.name_path } : {}),
      kind: symbol.kind ? `symbol:${symbol.kind.toLowerCase()}` : "symbol",
    });
  }
  return hits;
}

export const serenaProvider: ProviderDef = {
  name: "serena",
  intents: ["semantic"],
  probe: async () => {
    const result = await run("uvx", ["--version"], { timeoutMs: 8_000 });
    return probeResult(result.code === 0, "uvx not found (brew install uv)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const root = (query.roots ?? [])[0] ?? process.cwd();
    const child = clientFor(root);
    let body = "";
    try {
      const result = await child.callTool("find_symbol", {
        name_path_pattern: query.query,
        substring_matching: true,
        max_matches: 20,
      });
      if (result?.isError) throw new Error(resultText(result).slice(0, 300) || "serena tool error");
      body = resultText(result);
    } catch (error) {
      const message = (error as Error).message;
      if (!/unknown tool|not found.*tool|validation error/i.test(message)) {
        child.kill();
        clients.delete(root);
        throw error;
      }
      // Different serena build: its pattern search still answers the question.
      const fallback = await child.callTool("search_for_pattern", { search_string: query.query }).catch(() => null);
      body = fallback && !fallback?.isError ? resultText(fallback) : "";
    }
    return hitsFromSymbols(root, body);
  },
  timeoutMs: 120_000,
};

export function shutdownSerena(): void {
  for (const [, child] of clients) child.kill();
  clients.clear();
}
