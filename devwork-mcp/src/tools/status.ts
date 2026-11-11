import type { StatusArgs } from "../contract.js";
import type { Context } from "../context.js";
import { reportForContext } from "../doctor.js";
import { result, type ToolResult } from "../types.js";

export async function devworkStatus(_args: StatusArgs, ctx: Context): Promise<ToolResult> {
  const report = await reportForContext(ctx);
  const failed = report.structured.ok !== true;
  return result(report.text, report.structured, failed);
}
