/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * It connects over stdio, lists tools, calls them and checks the structured
 * result, so "works with Pi" is verified by the real client rather than by
 * reading documentation.
 *
 * The child gets an allowlisted environment and a temporary HOME; this server
 * reads no remote service, so no credential on the machine is involved.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const TOOL_NAMES = ["create_pdf", "pdf_clean"];

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
  const home = mkdtempSync(path.join(tmpdir(), "office-mcp-smoke-home-"));
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "office-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

test("Pi client negotiates and reaches the office server", async (t) => {
  await withServer(t, async ({ client }) => {
    assert.equal(client.protocolVersion, "2025-11-25", "Pi's revision is still served");
    assert.equal(client.serverInfo?.name, "office");
    assert.ok(client.instructions && client.instructions.length > 0, "server instructions survive the handshake");
  });
});

test("tools/list advertises the two PDF tools with output schemas", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} advertises an output schema`);
      assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `${tool.name} advertises an input schema`);
    }

    const create = tools.find((tool) => tool.name === "create_pdf");
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.equal(create.annotations?.openWorldHint, false, "no remote service is involved");
    const clean = tools.find((tool) => tool.name === "pdf_clean");
    assert.equal(clean.annotations?.destructiveHint, true);
    assert.ok(clean.description.includes("overwrite=true"), "the overwrite rule is in the description, not only in a manual");
  });
});

test("invalid arguments are rejected before any side effect", async (t) => {
  await withServer(t, async ({ client }) => {
    const cases = [
      ["create_pdf", { images: ["/tmp/a.png"] }, "missing output"],
      ["create_pdf", { images: [], output: "/tmp/a.pdf" }, "empty image list"],
      ["create_pdf", { images: ["/tmp/a.png"], output: "/tmp/a.pdf", quality: 0 }, "quality out of range"],
      ["create_pdf", { images: ["/tmp/a.png"], output: "/tmp/a.pdf", dpi: 300 }, "argument owned by the other tool"],
      ["pdf_clean", { input: "/tmp/a.pdf", operation: "shred" }, "unknown operation"],
      ["pdf_clean", { input: "/tmp/a.pdf", operation: "bw", dpi: 10 }, "dpi out of range"],
      ["pdf_clean", { operation: "bw" }, "missing input"],
    ];
    for (const [tool, args, why] of cases) {
      let failed = false;
      try {
        const result = await client.callTool(tool, args);
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

test("a missing input PDF is a structured failure, not a crash", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("pdf_clean", { input: "/nonexistent/office-mcp-smoke.pdf", operation: "info" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.status, "unavailable");
    assert.equal(result.structuredContent?.reason, "not-found");
    assert.ok(result.structuredContent?.notes.length > 0);
  });
});

test("an existing PDF output is refused through the real protocol", async (t) => {
  await withServer(t, async ({ client }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "office-mcp-smoke-"));
    try {
      const png = path.join(dir, "page1.png");
      writeFileSync(
        png,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const output = path.join(dir, "out.pdf");
      writeFileSync(output, "existing");

      const result = await client.callTool("create_pdf", { images: [png], output });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.reason, "conflict");
      assert.equal(result.structuredContent?.output, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
