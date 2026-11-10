/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * The child gets an allowlisted environment and a temporary HOME, so no real
 * Teams token or Azure CLI login on this machine is read.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

async function withServer(t, run) {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }
  const home = mkdtempSync(path.join(tmpdir(), "teams-mcp-smoke-home-"));
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "teams-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

test("Pi client negotiates and reaches the teams server", async (t) => {
  await withServer(t, async ({ client }) => {
    assert.equal(client.protocolVersion, "2025-11-25", "Pi's revision is still served");
    assert.equal(client.serverInfo?.name, "teams");
    assert.ok(client.instructions && client.instructions.length > 0, "server instructions survive the handshake");
  });
});

test("tools/list advertises one read-only tool with an output schema", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["teams_message"]);
    const tool = tools[0];
    assert.equal(tool.outputSchema?.type, "object");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
    assert.ok(tool.description.includes("TEAMS_ACCESS_TOKEN"), "credential guidance is in the description");
  });
});

test("invalid arguments are rejected before any token is read", async (t) => {
  await withServer(t, async ({ client }) => {
    const cases = [
      [{}, "missing url"],
      [{ url: "  " }, "whitespace url"],
      [{ url: "https://x", channel: "General" }, "unknown argument"],
      [{ url: 42 }, "non-string url"],
    ];
    for (const [args, why] of cases) {
      let failed = false;
      try {
        const result = await client.callTool("teams_message", args);
        failed = result.isError === true;
      } catch {
        failed = true;
      }
      assert.equal(failed, true, `${why} must be rejected`);
    }
  });
});

test("an unknown tool is a protocol-level failure", async (t) => {
  await withServer(t, async ({ client }) => {
    await assert.rejects(
      () => client.callTool("not_a_tool", {}),
      (error) => {
        assert.match(String(error.message ?? error), /not_a_tool|not found|Method not found/i);
        return true;
      },
    );
  });
});

test("a malformed share URL fails before any token or CLI work", async (t) => {
  await withServer(t, async ({ client }) => {
    for (const url of [
      "https://teams.microsoft.com/l/message/only-one?groupId=g",
      "https://evil.example/l/message/a/1?groupId=g",
      "https://teams.microsoft.com/l/message/a/1",
    ]) {
      const result = await client.callTool("teams_message", { url });
      assert.equal(result.isError, true, `${url} must fail`);
      assert.equal(result.structuredContent?.status, "unavailable");
      assert.equal(result.structuredContent?.reason, "unsupported");
      assert.ok(result.structuredContent?.notes.length > 0);
    }
  });
});

test("a valid URL without credentials reports auth, not a crash", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("teams_message", {
      url: "https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1729012345678?groupId=g1&channelName=General",
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.reason, "auth");
    assert.match(result.structuredContent?.notes.join(" ") ?? "", /TEAMS_ACCESS_TOKEN/);
  });
});
