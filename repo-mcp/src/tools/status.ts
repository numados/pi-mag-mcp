/** Doctor-tier handler and the shared repo status report (used by both
 *  repo_status and server.ts --doctor). Owns the git/gh presence probe and the
 *  enforced-policy summary text. Handler is RAW — src/tools.ts applies the
 *  shared cancellation/error wrapper exactly once per handler.
 */

import { GH_INSTALL_HINT, GIT_INSTALL_HINT, git, lookupCommand } from "../exec.js";
import { result } from "../types.js";
import { TRUST_BOUNDARY, type ToolHandler } from "./common.js";

export interface RepoStatusReport {
  text: string;
  gitPresent: boolean;
  structured: Record<string, unknown>;
}

export async function repoStatusReport(): Promise<RepoStatusReport> {
  const gitPath = lookupCommand("git");
  const ghPath = lookupCommand("gh");
  let gitVersion = "";
  if (gitPath) {
    const v = await git({ cwd: process.cwd(), args: ["--version"] });
    gitVersion = v.stdout.trim() || v.stderr.trim();
  }
  const lines = [
    "repo-mcp status",
    `git: ${gitPath ? `ok: ${gitPath} (${gitVersion})` : `MISSING — ${GIT_INSTALL_HINT}`}`,
    `gh:  ${ghPath ? `ok: ${ghPath}` : `not installed — ${GH_INSTALL_HINT} (optional; no repo-mcp tool needs it yet)`}`,
    "",
    "policy: push/send-pack have NO tool (structurally forbidden); no generic exec exists;",
    "        fetch/pull/commit are direct (pull is --ff-only, noninteractive, no force);",
    "        branch_create/merge/rebase/reset/restore/switch/destructive_local need a two-step",
    "        single-use approval token (exact args + HEAD + status digest, TTL 5 min);",
    "        branch_plan/commit_message generate text only.",
    "",
    `trust boundary: ${TRUST_BOUNDARY}`,
  ];
  return {
    text: lines.join("\n"),
    gitPresent: !!gitPath,
    structured: {
      git: { present: !!gitPath, path: gitPath, version: gitVersion, installHint: gitPath ? undefined : GIT_INSTALL_HINT },
      gh: { present: !!ghPath, path: ghPath, installHint: GH_INSTALL_HINT, usedByTools: false },
      policy: { pushTool: "absent", pull: "--ff-only", commit: "staged-only", approvalTtlSeconds: 300, generationToolsExecute: false },
    },
  };
}

async function repoStatus() {
  const report = await repoStatusReport();
  return result(report.text, report.structured);
}

export const statusHandlers = new Map<string, ToolHandler>([
  ["repo_status", repoStatus],
]);
