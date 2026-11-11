/**
 * grafana-logs-mcp tool surface. One owner of the contract: tool names,
 * titles, descriptions and the zod input/output schemas live here; the
 * server entry only registers and dispatches.
 */

import { z } from "zod";

export const QUERY_TOOL = "grafana_logs_query";
export const RAW_TOOL = "grafana_logs_raw";

export const queryInputSchema = z.object({
  query: z
    .string()
    .describe('Quickwit query string, e.g. serviceName:"my-service" or severity:error, * for all'),
  timeRange: z
    .string()
    .optional()
    .describe("Time range in Grafana notation (e.g. now-1h, now-30m, now-5m, now-15m). Default: now-1h"),
  limit: z.number().optional().describe("Maximum log entries (1-1000). Default: 50"),
  datasourceUid: z.string().optional().describe("Override Grafana datasource UID (default from config)"),
});

export const queryOutputSchema = z.object({
  rowCount: z.number().describe("Number of log rows the query returned"),
});

export const rawInputSchema = z.object({
  method: z.string().optional().describe("HTTP method (default: POST)"),
  endpoint: z.string().describe("API path, e.g. /api/ds/query, /api/datasources"),
  body: z.string().optional().describe("JSON body"),
});

export const rawOutputSchema = z.object({
  status: z.number().describe("HTTP status code the Grafana API answered with"),
});

export const QUERY_DESCRIPTION =
  "Query logs from Grafana via the Quickwit datasource. " +
  "Returns formatted log entries with timestamps, severity, and message body. " +
  'Supports Quickwit query syntax (e.g. serviceName:"my-service" AND severity:error).';

export const RAW_DESCRIPTION =
  "Send a raw HTTP request to the Grafana API. Useful for debugging or hitting " +
  "endpoints not covered by grafana_logs_query. Only /api paths on the configured " +
  "Grafana origin are accepted and redirects are refused.";
