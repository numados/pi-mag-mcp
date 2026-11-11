/** Shared shapes and the common response envelope (agents-mcp/devwork-mcp
 *  pattern): one loose-but-typed outputSchema every tool validates against.
 *  The envelope schema itself lives in contract.ts (part of the MCP contract);
 *  this module owns the ToolResult shape and its redaction-aware builders. */

import { redact } from "./exec.js";

function safeValue(v: unknown): unknown {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(safeValue);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeValue(x)]));
  return v;
}

export interface ToolResult {
  /** The MCP host may attach its own fields; keep the result assignable to
   *  the SDK's call-tool result union. */
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function text(t: string, isErr = false): ToolResult {
  return { content: [{ type: "text", text: redact(t) }], ...(isErr ? { isError: true } : {}) };
}

export function result(t: string, structured: Record<string, unknown>, isErr = false): ToolResult {
  return {
    content: [{ type: "text", text: redact(t) }],
    structuredContent: safeValue({ ok: !isErr, ...structured }) as Record<string, unknown>,
    ...(isErr ? { isError: true } : {}),
  };
}
