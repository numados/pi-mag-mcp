/**
 * Text projection of the structured result.
 *
 * The structured form is the authoritative one; this text exists so clients
 * that ignore `structuredContent` still get usable output, and so the status
 * is legible without parsing prose (research §8).
 */
import type { WebSearchOutput } from "./contract.js";
import { isFailureStatus } from "./contract.js";

const STATUS_HEADLINE: Readonly<Record<WebSearchOutput["status"], string>> = {
  ok: "Search results",
  empty: "No matching results",
  unavailable: "Search unavailable",
  cancelled: "Search cancelled",
};

export function renderText(output: WebSearchOutput): string {
  const lines: string[] = [];
  lines.push(`${STATUS_HEADLINE[output.status]} for "${output.query}" (mode: ${output.mode})`);

  if (output.status === "ok" && output.provider) {
    lines.push(`Source: ${output.provider}`);
  }
  if (output.fallback) {
    lines.push(
      `Fallback: ${output.fallback.from} unavailable (${output.fallback.reason}); showing ${output.fallback.to} results.`,
    );
  }

  output.results.forEach((result, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   ${result.url}`);
    if (result.snippet) {
      lines.push(`   ${result.snippet}${result.snippetTruncated ? " [truncated]" : ""}`);
    }
  });

  if (output.resultsTruncated) {
    lines.push("");
    lines.push(`Note: more results were available than the ${output.results.length} requested.`);
  }
  if (output.droppedUnsafeUrls > 0) {
    lines.push(
      `Note: ${output.droppedUnsafeUrls} result(s) were withheld because the provider supplied a non-http(s) link.`,
    );
  }

  if (output.notes.length > 0) {
    lines.push("");
    for (const note of output.notes) lines.push(`- ${note}`);
  }

  if (output.status === "ok") {
    lines.push("");
    lines.push("Snippets are excerpts, not the full page; open a source before relying on a claim.");
  }

  return lines.join("\n");
}

/**
 * `isError` marks execution failure only. An honest "no matches" is a
 * successful search with zero results, not an error (research §3, §9).
 */
export function isErrorResult(output: WebSearchOutput): boolean {
  return isFailureStatus(output.status);
}
