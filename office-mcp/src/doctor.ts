/**
 * Doctor — readiness for office-mcp: which tools of the local PDF toolchain
 * are present, which operations those tools support, and what to install when
 * something is missing.
 *
 * This module owns the verdict and exit rules; the facts come from
 * requirements.json (through ./requirements.ts) and ./toolchain.ts, which the
 * PDF runtime shares. Discovery runs version flags only — the doctor never
 * executes a PDF mutation — and installs nothing.
 *
 * Exit rule (the installer `list` convention): exit 1 exactly when a required
 * tool is missing. Optional tools only limit which operations are available,
 * and the report says which: "partial readiness" is a valid state, not a
 * failure to gate a bootstrap on.
 */

import { installCommandFor, loadRequirements, toolchainInstallHint } from "./requirements.js";
import { missingToolsFor, OPERATIONS, resolveTool, TOOL_NAMES, type Operation, type ToolName, type ToolPaths } from "./toolchain.js";

export type ToolVerdict = "present" | "missing";
export type OperationReadiness = "ready" | "blocked";

export interface ToolReport {
  tool: ToolName;
  what: string;
  required: boolean;
  verdict: ToolVerdict;
  /** Resolved command when present. */
  command?: string;
  /** The exact install command for this one tool. */
  install: string;
}

export interface OperationReport {
  operation: Operation;
  readiness: OperationReadiness;
  /** Tools this operation still needs. */
  missing: ToolName[];
}

export interface DoctorReport {
  tools: ToolReport[];
  operations: OperationReport[];
  /** False when a required tool is missing — the `--doctor` exit rule. */
  ok: boolean;
  nodeVersion: string;
}

export interface DoctorDeps {
  /** Resolve one tool to a working command, or null (default: version-flag probe). */
  resolveTool?: (tool: ToolName) => Promise<string | null>;
}

export async function buildDoctorReport(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const resolve = deps.resolveTool ?? ((tool: ToolName) => resolveTool(tool));
  const entries = loadRequirements();

  const resolved = await Promise.all(TOOL_NAMES.map((tool) => resolve(tool)));
  const paths = Object.fromEntries(TOOL_NAMES.map((tool, index) => [tool, resolved[index] ?? null])) as ToolPaths;

  const tools: ToolReport[] = TOOL_NAMES.map((tool) => {
    const command = paths[tool];
    const entry = entries.find((candidate) => candidate.tool === tool);
    return {
      tool,
      what: entry?.what ?? tool,
      required: entry?.required ?? false,
      verdict: command === null ? "missing" : "present",
      ...(command !== null ? { command } : {}),
      install: entry === undefined ? tool : installCommandFor(entry),
    };
  });

  const operations: OperationReport[] = OPERATIONS.map((operation) => {
    const missing = missingToolsFor(operation, paths);
    return { operation, readiness: missing.length === 0 ? "ready" : "blocked", missing };
  });

  const ok = tools.every((tool) => tool.verdict === "present" || !tool.required);
  return { tools, operations, ok, nodeVersion: process.version };
}

const mark = (ready: boolean): string => (ready ? "✓" : "✗");

/** The report as text; `--doctor` prints exactly this. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`office doctor (node ${report.nodeVersion})`, "", "tools:"];
  for (const tool of report.tools) {
    const detail = tool.verdict === "present" ? tool.command ?? "" : `install: ${tool.install}`;
    lines.push(`  ${mark(tool.verdict === "present")} ${tool.tool} (${tool.required ? "required" : "optional"}) — ${tool.what} [${detail}]`);
  }
  lines.push("", "operations:");
  for (const operation of report.operations) {
    const detail =
      operation.readiness === "ready"
        ? "ready"
        : `blocked — missing ${operation.missing.join(", ")}`;
    lines.push(`  ${mark(operation.readiness === "ready")} ${operation.operation} ${detail}`);
  }

  const present = report.tools.filter((tool) => tool.verdict === "present").length;
  const total = report.tools.length;
  const blocked = report.operations.filter((operation) => operation.readiness === "blocked");
  lines.push("");
  if (blocked.length === 0) {
    lines.push(`readiness: ok — ${present}/${total} tools present, every operation can run`);
  } else if (present > 0) {
    lines.push(`readiness: partial — ${present}/${total} tools present; blocked: ${blocked.map((entry) => entry.operation).join(", ")}`);
  } else {
    lines.push(`readiness: not ready — ${present}/${total} tools present; install the toolchain: ${toolchainInstallHint()}`);
  }
  if (!report.ok) lines.push("exit 1: a required tool is missing");
  return lines.join("\n");
}
