/** repo-mcp server entry (stdio). Git wrapper enforcing repo-mcp-policy.md
 *  server-side: fixed-argv tools only, approval tokens for local mutations,
 *  no push/send-pack tool exists at all.
 *
 *  stdout is the protocol channel: nothing but MCP frames may be written
 *  there. Diagnostics go to stderr. `node dist/server.js --doctor` prints the
 *  repo_status report and exits (exit 1 when git is missing).
 *
 *  The 21 tools are registered through McpServer.registerTool so `tools/list`
 *  advertises their exact schemas and annotations. The built-in tools/call
 *  handler answers an unregistered name with a bare "Tool X not found"
 *  JSON-RPC error, which would hide the structural refusal for push-shaped
 *  names — so it is replaced with a handler that keeps the refusal text (and
 *  the "unknown tool" text) and otherwise dispatches to the same handlers.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { envelopeSchema, FORBIDDEN_SHAPE, TOOLS, toolByName } from "./contract.js";
import { repoStatusReport, toolDefs, type ToolDef } from "./tools.js";
import { result } from "./types.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function log(message: string): void {
  process.stderr.write(`[repo] ${message}\n`);
}

const defs = new Map<string, ToolDef>(toolDefs().map((t) => [t.name, t]));
const names = TOOLS.map((t) => t.name);

async function dispatch(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
  const def = defs.get(name);
  if (!def) {
    // Structural refusal for the forbidden tier: there is no push/send-pack
    // tool and no generic exec — say so instead of hinting at one.
    if (FORBIDDEN_SHAPE.test(name)) {
      return {
        content: [{ type: "text", text: `${name}: refused — repo-mcp has no push/send-pack or generic-exec tool at any confirmation level (repo-mcp-policy.md §1 FORBIDDEN). Available: ${names.join(", ")}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `unknown tool: ${name} (available: ${names.join(", ")})` }],
      isError: true,
    };
  }

  // The replaced tools/call handler no longer benefits from the SDK's own
  // input-schema validation, so the declared contract is enforced here before
  // a handler sees the arguments. Only rejection is taken from this parse:
  // handlers receive the caller's original arguments, so unknown keys keep
  // behaving exactly as they did in the source server.
  const contract = toolByName(name);
  const parsed = contract?.inputSchema.safeParse(args);
  if (parsed && !parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return result(`${name}: invalid arguments — ${detail}`, { ok: false, error: `invalid arguments: ${detail}` }, true);
  }

  const outcome = await def.handler(args, signal);
  if (outcome.structuredContent) {
    const validated = envelopeSchema.safeParse(outcome.structuredContent);
    if (!validated.success) {
      log(`${name} produced output that failed its own schema: ${validated.error.message}`);
      return result("Internal error: the tool produced structured output that failed validation.", { ok: false, error: "output validation" }, true);
    }
    return { ...outcome, structuredContent: validated.data as Record<string, unknown> };
  }
  return outcome;
}

/** Replaces the SDK's tools/call handler so unregistered push-shaped names get
 *  the structural refusal instead of a bare "Tool not found" JSON-RPC error. */
function installToolCallRefusal(server: McpServer): void {
  server.server.removeRequestHandler("tools/call");
  server.server.setRequestHandler("tools/call", async (request: unknown, ctx: ServerContext) => {
    const params = (request as { params?: { name?: unknown; arguments?: unknown } })?.params;
    const name = typeof params?.name === "string" ? params.name : "";
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    return dispatch(name, args, ctx.mcpReq.signal);
  });
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "repo", version },
    {
      instructions:
        "repo-mcp is the git wrapper for this machine: reads are free, fetch/pull (--ff-only) and staged-only commit " +
        "are allowed directly, and every local mutation (branch_create, merge, rebase, reset, restore, switch, " +
        "destructive_local) is approval-gated — call it once without confirm:true to get a preview plus a single-use " +
        "token, show that preview to the user, then re-call with confirm:true and the token. push/send-pack have no " +
        "tool at all. Git hooks and repository config run exactly as on the user's machine: this server does not bypass " +
        "or sandbox them.",
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
        annotations: tool.annotations,
      },
      (args: unknown, ctx) => dispatch(tool.name, (args ?? {}) as Record<string, unknown>, ctx.mcpReq.signal),
    );
  }

  installToolCallRefusal(server);
  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    const report = await repoStatusReport();
    process.stdout.write(`${report.text}\n`);
    process.exit(report.gitPresent ? 0 : 1);
  }

  serveStdio(() => createServer(), {
    onerror: (error) => log(`transport error: ${error.message}`),
  });
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
