/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * Connects over stdio to the built server, lists tools and exercises the
 * configuration-error path (env unset): the call must answer a normal,
 * named error result instead of a transport failure. No network: the
 * Grafana URL is never configured in this test.
 *
 * The client is resolved from the installed Pi package; when it is absent
 * the test skips instead of failing, the same convention the other
 * packages in this repository use.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

/**
 * Locate the Pi MCP client package.
 *
 * Pi is not a dependency of this server, so it is resolved from the installed
 * harness. `PI_MCP_ROOT` overrides the probe list for non-standard layouts.
 */
function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    // Homebrew and Linux global layouts derived from the running Node binary.
    path.resolve(process.execPath, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-mcp"),
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "dist", "client.js")));
}

async function loadPiClient() {
  const root = findPiMcpRoot();
  if (!root) return null;
  const client = await import(path.join(root, "dist", "client.js"));
  const stdio = await import(path.join(root, "dist", "transports", "stdio.js"));
  return { McpClient: client.McpClient, StdioTransport: stdio.StdioTransport };
}

test("pi client lists both tools and the unconfigured query answers a named error", async (t) => {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }

test("--doctor prints the readiness report over plain stdio and exits by env state", () => {
  const withEnv = spawnSync(process.execPath, [serverEntry, "--doctor"], {
    env: { PATH: process.env.PATH ?? "", GRAFANA_URL: "https://grafana.example.net", GRAFANA_DATASOURCE_UID: "uid-1" },
    encoding: "utf8",
  });
  assert.equal(withEnv.status, 0, withEnv.stderr);
  assert.match(withEnv.stdout, /grafana-logs status/);
  assert.match(withEnv.stdout, /GRAFANA_URL: set/);
  assert.match(withEnv.stdout, /GRAFANA_DATASOURCE_UID: set/);

  const withoutEnv = spawnSync(process.execPath, [serverEntry, "--doctor"], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  assert.equal(withoutEnv.status, 1, withoutEnv.stderr);
  assert.match(withoutEnv.stdout, /GRAFANA_URL: missing/);
  assert.match(withoutEnv.stdout, /GRAFANA_DATASOURCE_UID: missing/);
});

const serverEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/tmp",
};

  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env: serverEnv,
    stderr: "pipe",
  });
  const client = new McpClient({ name: "grafana-logs-smoke", version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const names = listed.map((x) => x.name).sort();
  assert.deepEqual(names, ["grafana_logs_query", "grafana_logs_raw"]);
  for (const tool of listed) {
    assert.ok(tool.outputSchema, `outputSchema must be declared for ${tool.name}`);
  }
  // The advertised hints must match reality: query reads, raw can mutate.
  const query = listed.find((x) => x.name === "grafana_logs_query");
  const raw = listed.find((x) => x.name === "grafana_logs_raw");
  assert.equal(query?.annotations?.readOnlyHint, true);
  assert.equal(raw?.annotations?.readOnlyHint, false);
  assert.equal(raw?.annotations?.destructiveHint, true);

  const call = await client.callTool("grafana_logs_query", { query: "*" });
  assert.equal(call.isError, true);
  const text = call.content?.[0]?.text ?? "";
  assert.match(text, /GRAFANA_URL \/ GRAFANA_DATASOURCE_UID are not set/);
});
