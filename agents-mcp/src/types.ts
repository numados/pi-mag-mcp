/** Shared response shape for both tools: text for the model, structured for
 *  the machine. The envelope schema lives in contract.ts (part of the MCP
 *  contract); this module owns the ToolResult type and its builders. */

export interface ToolResult {
  /** Keep the result assignable to the SDK's call-tool result union. */
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function text(t: string, isErr = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isErr ? { isError: true } : {}) };
}

export function result(t: string, structured: Record<string, unknown>, isErr = false): ToolResult {
  return {
    content: [{ type: "text", text: t }],
    structuredContent: { ok: !isErr, ...structured },
    ...(isErr ? { isError: true } : {}),
  };
}
