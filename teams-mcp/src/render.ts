/**
 * Text projection of the structured result.
 *
 * The structure is authoritative; this text exists so clients that ignore
 * `structuredContent` still get usable output.
 */
import { isFailureStatus, type TeamsMessageOutput } from "./contract.js";

const STATUS_HEADLINE: Readonly<Record<TeamsMessageOutput["status"], string>> = {
  ok: "OK",
  empty: "Nothing found",
  unavailable: "Unavailable",
  cancelled: "Cancelled",
};

export function renderTeams(output: TeamsMessageOutput): string {
  if (output.status !== "ok") {
    const lines = [`${STATUS_HEADLINE[output.status]}: Teams message`];
    if (output.notes.length > 0) {
      lines.push("");
      for (const note of output.notes) lines.push(`- ${note}`);
    }
    return lines.join("\n");
  }

  const lines = [
    `OK: Teams message ${output.messageId}`,
    `Author: ${output.author}`,
    `Created: ${output.created}`,
  ];
  if (output.edited) lines.push(`Edited: ${output.edited}`);
  lines.push("", output.text);
  if (output.truncated) lines.push("", "Note: the message text was truncated.");
  for (const note of output.notes) lines.push(`- ${note}`);
  return lines.join("\n");
}

/** `isError` marks execution failure only. */
export function isErrorResult(output: TeamsMessageOutput): boolean {
  return isFailureStatus(output.status);
}
