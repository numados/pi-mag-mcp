/**
 * Text rendering: one owner of every human-readable answer the server sends.
 * The structured payloads carry the same information; this module decides the
 * wording, so a text change cannot drift from tool to tool.
 */

import type { RequirementReport } from "./contract.js";
import type { ProviderStatus } from "./registry.js";
import type { SearchResponse } from "./types.js";

/** The routed-search answer: who answered, why the others were skipped, the hits. */
export function formatResponse(response: SearchResponse): string {
  const skipped =
    response.skipped.length > 0
      ? ` (skipped: ${response.skipped.map((entry) => `${entry.name} — ${entry.reason}`).join("; ")})`
      : "";
  const lines = [`${response.provider}${skipped}`];
  response.results.forEach((hit, index) => {
    const location = hit.line !== undefined ? `:${hit.line}` : "";
    lines.push(`${index + 1}) ${hit.path}${location}${hit.snippet ? `  ${hit.snippet}` : ""}`);
  });
  lines.push(`${response.count} results${response.note ? ` — ${response.note}` : ""}`);
  return lines.join("\n");
}

const mark = (status: ProviderStatus): string => (!status.enabled ? "–" : status.available ? "✓" : "✗");

/** The provider table: what the router can use right now. */
export function formatStatus(statuses: ProviderStatus[], sources: string[]): string {
  return [
    `config: ${sources.join(" > ") || "defaults"}`,
    ...statuses.map((status) => {
      const intents = status.intents.join(", ");
      return `${mark(status)} ${status.name} [${intents}]${status.reason ? ` — ${status.reason}` : ""}`;
    }),
  ].join("\n");
}

const verdictMark: Record<RequirementReport["verdict"], string> = {
  present: "✓",
  installable: "✗",
  blocked: "✗",
  builtin: "✗",
  disabled: "–",
};

/**
 * The doctor report: per requirement either "you are fine", "run this command"
 * or "this machine cannot install it, turn the provider off with this line".
 */
export function formatDoctor(report: RequirementReport[], sources: string[], nodeVersion: string): string {
  const lines = [`node ${nodeVersion} · config: ${sources.join(" > ") || "defaults (no config file found)"}`, ""];
  for (const entry of report) {
    const optional = entry.required === false ? " (optional)" : "";
    lines.push(`${verdictMark[entry.verdict]} ${entry.provider} — ${entry.what}${optional}`);
    if (entry.verdict === "installable" && entry.install) {
      lines.push(`    install: ${entry.install}`);
      for (const step of entry.postSetup ?? []) lines.push(`    then:    ${step}`);
    } else if (entry.detail) {
      lines.push(`    ${entry.detail}`);
    }
  }
  return lines.join("\n");
}
