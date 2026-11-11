/**
 * grafana-logs-mcp server entry (stdio). Two tools:
 *   grafana_logs_query — Quickwit query via the Grafana /api/ds/query API,
 *                        formatted log entries with timestamps/severity/body.
 *   grafana_logs_raw   — raw Grafana API request for debugging, pinned to
 *                        /api paths on the configured origin.
 *
 * stdout is the protocol channel: nothing but MCP frames may be written
 * there; diagnostics go to stderr with a `[grafana-logs]` prefix.
 *
 * Without GRAFANA_URL / GRAFANA_DATASOURCE_UID the server stays up so
 * tools/list works, and every call answers a clear configuration error
 * instead of guessing a target.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  QUERY_DESCRIPTION,
  QUERY_TOOL,
  RAW_DESCRIPTION,
  RAW_TOOL,
  queryInputSchema,
  queryOutputSchema,
  rawInputSchema,
  rawOutputSchema,
} from "./contract.js";
import { loadConfig, type GrafanaConfig } from "./config.js";
import { doctorReport } from "./doctor.js";
import { countResults, extractRawFrameInfo, formatResults, tryFormatJson } from "./format.js";
import { buildQueryPayload, grafanaApiUrl, grafanaFetch } from "./grafana.js";

const CONFIG_ERROR =
  "❌ GRAFANA_URL / GRAFANA_DATASOURCE_UID are not set.";

function log(message: string): void {
  process.stderr.write(`[grafana-logs] ${message}\n`);
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
  return { ...textResult(text), isError: true };
}

/** Validate a structured payload against its advertised schema before sending. */
function withStructured<T>(result: CallToolResult, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: T): CallToolResult {
  const validated = schema.safeParse(value);
  if (!validated.success) {
    log(`structured output failed its own schema: ${validated.error.message}`);
    return errorResult("Internal error: the result failed its own output schema.");
  }
  return { ...result, structuredContent: validated.data };
}

async function runQuery(params: Record<string, unknown>, config: GrafanaConfig, signal?: AbortSignal): Promise<CallToolResult> {
  if (!config.url) return errorResult(CONFIG_ERROR);
  const uid = typeof params.datasourceUid === "string" && params.datasourceUid ? params.datasourceUid : config.datasourceUid;
  const timeRange = typeof params.timeRange === "string" && params.timeRange ? params.timeRange : "now-1h";
  const rawLimit = typeof params.limit === "number" ? params.limit : 50;
  const limit = Math.min(Math.max(1, rawLimit), 1000);
  const payload = buildQueryPayload(
    String(params.query ?? ""),
    config.datasourceType,
    uid,
    timeRange,
    limit,
  );
  try {
    const response = await grafanaFetch(
      grafanaApiUrl(config.url, "/api/ds/query"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        ...(config.authHeader ? { authHeader: config.authHeader } : {}),
      },
      signal,
    );
    if (response.ok) {
      const data: unknown = await response.json();
      const rawFrameInfo = extractRawFrameInfo(data);
      const text = `${formatResults(data)}\n\n${rawFrameInfo}`.substring(0, 32_000);
      return withStructured(textResult(text), queryOutputSchema, { rowCount: countResults(data) });
    }
    const status = response.status;
    const responseText = await response.text().catch(() => "no body");
    if (status === 400) {
      return errorResult(
        `❌ Bad request (400). The Quickwit query syntax may be incorrect.\n\nTry:\n` +
          `  serviceName:"my-service"\n  serviceName:"my-service" AND severity:error\n  *\n\n` +
          `Response:\n${responseText.substring(0, 500)}`,
      );
    }
    if (status === 401 || status === 403) {
      return errorResult(
        `❌ HTTP ${status} — not authorized. The Grafana API may require ` +
          `authentication from outside the corporate network. Check VPN/network access.`,
      );
    }
    if (status === 404) {
      return errorResult(
        `❌ Endpoint not found at ${config.url}/api/ds/query. URL or datasource type wrong?`,
      );
    }
    return errorResult(`❌ HTTP ${status}:\n${responseText.substring(0, 500)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(
      `❌ Request failed: ${msg}\n\nCheck:\n` +
        `  1. Are you on the network/VPN that hosts Grafana?\n` +
        `  2. Is the Grafana URL correct? (${config.url})\n  3. Try grafana_logs_raw GET /api/datasources`,
    );
  }
}

async function runRaw(params: Record<string, unknown>, config: GrafanaConfig, signal?: AbortSignal): Promise<CallToolResult> {
  if (!config.url) return errorResult(CONFIG_ERROR);
  try {
    const method = String(params.method || "POST").toUpperCase();
    const response = await grafanaFetch(
      grafanaApiUrl(config.url, String(params.endpoint ?? "")),
      {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(typeof params.body === "string" ? { body: params.body } : {}),
        ...(config.authHeader ? { authHeader: config.authHeader } : {}),
      },
      signal,
    );
    const text = await response.text().catch(() => "no body");
    const body = `HTTP ${response.status} ${response.statusText}\n\n${tryFormatJson(text).substring(0, 8000)}`;
    return withStructured(textResult(body), rawOutputSchema, { status: response.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`❌ Request failed: ${msg}`);
  }
}

function createServer(config: GrafanaConfig): McpServer {
  const server = new McpServer(
    { name: "grafana-logs", version: "0.1.0" },
    {
      instructions:
        "Grafana/Quickwit logs: grafana_logs_query runs Quickwit queries (QQL) through the configured " +
        "datasource and returns formatted entries; it is read-only. grafana_logs_raw is a debugging " +
        "passthrough that forwards arbitrary HTTP methods to /api paths on the configured origin — it can " +
        "mutate the Grafana instance, so treat it as privileged. Redirects and cross-origin targets are refused.",
    },
  );

  server.registerTool(
    QUERY_TOOL,
    {
      title: "Grafana/Quickwit Logs",
      description: QUERY_DESCRIPTION,
      inputSchema: queryInputSchema,
      outputSchema: queryOutputSchema,
      annotations: { title: "Grafana/Quickwit Logs", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx): Promise<CallToolResult> => runQuery(args, config, ctx.mcpReq.signal),
  );

  server.registerTool(
    RAW_TOOL,
    {
      title: "Grafana Raw Query",
      description: RAW_DESCRIPTION,
      inputSchema: rawInputSchema,
      outputSchema: rawOutputSchema,
      // A raw passthrough can issue mutating requests (DELETE /api/...), so it
      // must not advertise read-only.
      annotations: { title: "Grafana Raw Query", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx): Promise<CallToolResult> => runRaw(args, config, ctx.mcpReq.signal),
  );

  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    // The installer's `list` runs this against requirements.json and prints
    // the report; exit 1 means a required environment value is missing.
    const report = doctorReport();
    process.stdout.write(report.text);
    process.exit(report.ok ? 0 : 1);
  }

  let config: GrafanaConfig;
  try {
    config = loadConfig();
  } catch (e) {
    // Stay up so tools/list works and the error explains what to configure.
    log(String(e instanceof Error ? e.message : e));
    config = { url: "", datasourceUid: "", datasourceType: "quickwit-quickwit-datasource", authHeader: undefined };
  }

  const handle = serveStdio(
    () => createServer(config),
    { onerror: (error) => log(`transport error: ${error.message}`) },
  );
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
