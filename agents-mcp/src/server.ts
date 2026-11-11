/**
 * agents-mcp server entry (stdio).
 *
 * stdout is the protocol channel: nothing but MCP frames may be written
 * there; diagnostics go to stderr. `node dist/server.js --doctor` prints the
 * agents_status report and exits (exit 1 when the report failed, e.g. a
 * malformed config), then only a normal start falls through to stdio.
 *
 * The two tools are registered through McpServer.registerTool so tools/list
 * advertises their exact zod schemas and the shared output envelope. Handler
 * failures become normal results with `isError`, so the model sees the reason
 * instead of a transport error.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TOOLS, envelopeSchema } from "./contract.js";
import { dispatch } from "./tools.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function log(message: string): void {
  process.stderr.write(`[agents] ${message}\n`);
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "agents", version },
    {
      instructions:
        "Inter-agent channel: agent_call drives claude/codex/agy CLIs (research/opinion/review) with subscription aliases; agent:'auto' lets Jev pick the cheapest suitable executor. " +
        "Tasks run in fresh isolated processes — include ALL context in `task`. agents_status is the doctor.",
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: envelopeSchema,
      },
      (args: unknown, ctx: ServerContext) => dispatch(tool.name, (args ?? {}) as Record<string, unknown>, ctx.mcpReq.signal),
    );
  }
  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    try {
      const report = await dispatch("agents_status", {});
      process.stdout.write(`${String(report.content[0]?.text ?? "")}\n`);
      process.exit(report.isError ? 1 : 0);
    } catch (e) {
      process.stdout.write(`agents-mcp doctor failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  }

  const handle = serveStdio(() => createServer(), {
    onerror: (error) => log(`transport error: ${error.message}`),
  });
  process.on("SIGTERM", () => {
    void handle.close();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    void handle.close();
    process.exit(0);
  });
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
