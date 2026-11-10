/**
 * auggie provider: semantic codebase retrieval through the auggie MCP CLI
 * (`auggie --mcp`), tool `codebase-retrieval`. Paid: when the subscription
 * lapses the probe fails and every semantic query falls through to
 * serena -> ast-grep -> rg.
 */

import { truncate } from "../scope.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";
import { extractPaths, McpChildClient, resultText } from "./mcpchild.js";

let client: McpChildClient | null = null;

function getClient(cwd?: string): McpChildClient {
  if (!client) client = new McpChildClient("auggie", ["--mcp", "--mcp-auto-workspace"], cwd, 180_000);
  return client;
}

export const auggieProvider: ProviderDef = {
  name: "auggie",
  intents: ["semantic"],
  probe: async () => {
    const result = await run("auggie", ["--version"], { timeoutMs: 8_000 });
    return probeResult(result.code === 0, "auggie not found or not authenticated (paid subscription)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const roots = query.roots ?? [];
    const targets = roots.length > 0 ? roots.slice(0, 3) : [process.cwd()];
    const hits: SearchHit[] = [];
    for (const root of targets) {
      try {
        const result = await getClient(root).callTool("codebase-retrieval", {
          information_request: query.query,
          directory_path: root,
        });
        if (result?.isError) throw new Error(resultText(result).slice(0, 300) || "auggie tool error");
        const body = resultText(result);
        if (!body) continue;
        for (const path of extractPaths(body).slice(0, 20)) hits.push({ path, kind: "semantic" });
        hits.push({ path: root, snippet: truncate(body, 1_800), kind: "summary" });
      } catch (error) {
        client?.kill();
        client = null;
        throw error;
      }
    }
    return hits;
  },
  timeoutMs: 120_000,
};

export function shutdownAuggie(): void {
  client?.kill();
  client = null;
}
