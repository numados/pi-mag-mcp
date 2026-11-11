/** Compatibility smoke test against the installed Pi MCP client: spawn the
 *  built server through Pi's own client (connect → tools/list → tools/call)
 *  with a fake CLI alias injected via config — no real subscriptions, no
 *  network, no live configuration (HOME and the config pin point at the
 *  fixture; the cooldown cache is redirected into it).
 *
 *  Port of the source stdio smoke test (agent-toolkit/mcp/agents-mcp at
 *  7cdf230), re-targeted from the SDK client to Pi's own client per the
 *  repository acceptance pattern.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    path.resolve(
      process.execPath,
      "..",
      "..",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-mcp",
    ),
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

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agents-mcp-pi-client-"));
process.on("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const fakeHome = path.join(fixtureRoot, "home");
mkdirSync(fakeHome, { recursive: true });

/** Fake CLI: echoes stdin back inside OUT[...] — proves the task reached the
 *  child process over stdin and the envelope round-trips the answer. */
const FAKE = `const c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>process.stdout.write("OUT["+c.join("")+"]"))`;
const fakeConfigPath = path.join(fixtureRoot, "agents-config.json");
writeFileSync(fakeConfigPath, JSON.stringify({
  aliases: { fake: { command: process.execPath, args: ["-e", FAKE, "--"] } },
  defaults: { claude: { alias: "fake", model: "fake-model", effort: "low" } },
}));

const serverEnv = {
  PATH: process.env.PATH ?? "",
  HOME: fakeHome,
  XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
  AGENTS_MCP_CONFIG: fakeConfigPath,
  AGENTS_MCP_COOLDOWNS: path.join(fixtureRoot, "cooldowns.json"),
};

test("--doctor prints the status report over plain stdio and exits 0", () => {
  const r = spawnSync(process.execPath, [serverEntry, "--doctor"], {
    cwd: fixtureRoot,
    env: serverEnv,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agents-mcp status/);
  assert.match(r.stdout, /claude|codex|agy/);
});

test("stdio server over the Pi client: list, fake agent_call, doctor, contract errors", async (t) => {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }

  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env: serverEnv,
    cwd: fixtureRoot,
    stderr: "pipe",
  });
  const client = new McpClient({ name: "agents-mcp-smoke", version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const names = listed.map((x) => x.name);
  assert.deepEqual([...names].sort(), ["agent_call", "agents_status"]);
  for (const tool of listed) {
    assert.ok(tool.outputSchema, `outputSchema must be declared for ${tool.name}`);
  }

  // real delegation over the wire — the fake alias executes, the envelope
  // carries the answer back with its identity
  const call = await client.callTool("agent_call", { mode: "opinion", agent: "claude", task: "smoke task" });
  assert.equal(call.isError, undefined, call.content?.[0]?.text);
  assert.equal(call.structuredContent.ok, true);
  assert.equal(call.structuredContent.alias, "fake");
  assert.equal(call.structuredContent.model, "fake-model");
  assert.match(call.structuredContent.result, /^OUT\[/);
  assert.match(call.structuredContent.result, /smoke task/);

  // the doctor is callable over the protocol too
  const status = await client.callTool("agents_status", {});
  assert.equal(status.isError, undefined, status.content?.[0]?.text);
  assert.equal(status.structuredContent.ok, true);
  assert.ok(status.structuredContent.aliases.some((a) => a.name === "fake"));
  assert.ok(status.structuredContent.sources.includes("built-in defaults"));

  // contract errors stay structured: unknown alias is an isError result with
  // the reason in text, not a transport failure
  const bad = await client.callTool("agent_call", { mode: "opinion", agent: "claude", alias: "does-not-exist", task: "x" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown claude alias "does-not-exist"/);

  // input validation runs before the handler
  const mistyped = await client.callTool("agent_call", { mode: "banana", agent: "claude", task: "x" });
  assert.equal(mistyped.isError, true);
  assert.match(mistyped.content[0].text, /invalid arguments|mode/);
});
