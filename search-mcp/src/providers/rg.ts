/**
 * rg provider: bounded regex/line search in JSON mode. It is the lexical floor
 * of every chain, so `search` keeps working when nothing else is installed.
 * `rgfiles` (`rg --files` + a name filter) backs the files intent when fd is
 * missing.
 */

import { truncate } from "../scope.js";
import { run } from "../subprocess.js";
import { probeResult, type ProviderDef, type SearchHit, type SearchQuery } from "../types.js";

async function rgJson(query: SearchQuery): Promise<SearchHit[]> {
  const limit = query.limit ?? 50;
  const args = [
    "--json",
    "--no-messages",
    ...(query.caseSensitive ? ["-s"] : ["-S"]),
    ...(query.pathGlob ? ["-g", query.pathGlob] : []),
    `--max-count=${limit}`,
    "--",
    query.query,
    ...(query.roots ?? []),
  ];
  const result = await run("rg", args, { timeoutMs: 15_000 });
  if (result.code === 2) throw new Error(`rg error: ${result.stderr.slice(0, 300)}`);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`rg exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  }

  const maxSnippet = query.maxSnippet ?? 240;
  const hits: SearchHit[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message?.type !== "match") continue;
    const path = message.data?.path?.text;
    if (typeof path !== "string") continue;
    hits.push({
      path,
      ...(typeof message.data?.line_number === "number" ? { line: message.data.line_number } : {}),
      snippet: truncate(String(message.data?.lines?.text ?? ""), maxSnippet),
      kind: "text",
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export const rgProvider: ProviderDef = {
  name: "rg",
  intents: ["text", "structure", "semantic", "crossrepo"],
  probe: async () => {
    const result = await run("rg", ["--version"], { timeoutMs: 5_000 });
    return probeResult(result.code === 0, "rg not found (brew install ripgrep)");
  },
  search: rgJson,
  timeoutMs: 15_000,
};

export const rgfilesProvider: ProviderDef = {
  name: "rgfiles",
  intents: ["files"],
  probe: async () => {
    const result = await run("rg", ["--version"], { timeoutMs: 5_000 });
    return probeResult(result.code === 0, "rg not found (brew install ripgrep)");
  },
  search: async (query: SearchQuery): Promise<SearchHit[]> => {
    const limit = query.limit ?? 50;
    const listing = await run("rg", ["--files", "--no-messages", ...(query.roots ?? [])], { timeoutMs: 15_000 });
    if (listing.code !== 0 && listing.code !== 1) throw new Error(`rg --files exited ${listing.code}`);

    const pattern = new RegExp(query.query, query.caseSensitive ? "" : "i");
    const hits: SearchHit[] = [];
    for (const path of listing.stdout.split("\n")) {
      if (!path) continue;
      if (!pattern.test(path)) continue;
      hits.push({ path, kind: "file" });
      if (hits.length >= limit) break;
    }
    return hits;
  },
  timeoutMs: 20_000,
};
