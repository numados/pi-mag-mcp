/**
 * Text projection of every structured result.
 *
 * The structured form is authoritative; this text exists so clients that
 * ignore `structuredContent` still get usable output, and so a status is
 * legible without parsing prose. It never adds information the structure lacks.
 */
import type {
  ConfluenceCommentsOutput,
  ConfluencePageOutput,
  ConfluenceSearchOutput,
  CreatePdfOutput,
  OfficeStatus,
  PdfCleanOutput,
  TeamsMessageOutput,
} from "./contract.js";

const STATUS_HEADLINE: Readonly<Record<OfficeStatus, string>> = {
  ok: "OK",
  empty: "Nothing found",
  unavailable: "Unavailable",
  cancelled: "Cancelled",
};

function head(status: OfficeStatus, subject: string): string[] {
  return [`${STATUS_HEADLINE[status]}: ${subject}`];
}

function withNotes(lines: string[], notes: string[]): string[] {
  if (notes.length === 0) return lines;
  lines.push("");
  for (const note of notes) lines.push(`- ${note}`);
  return lines;
}

export function renderPage(output: ConfluencePageOutput): string {
  if (output.status !== "ok") {
    return withNotes(head(output.status, "Confluence page"), output.notes).join("\n");
  }
  const meta = [
    `Type: ${output.type} | Space: ${output.spaceKey} | v${output.version ?? "?"} | Updated: ${output.updated || "unknown"}`,
    `URL: ${output.url}`,
  ];
  const lines = [...head("ok", output.title), ...meta, "", "---", "", output.text];
  if (output.textTruncated) lines.push("", `Note: the page text was truncated at ${output.text.length} characters.`);
  return withNotes(lines, output.notes).join("\n");
}

export function renderComments(output: ConfluenceCommentsOutput): string {
  if (output.status === "empty" || (output.status === "ok" && output.comments.length === 0)) {
    return withNotes(["No comments."], output.notes).join("\n");
  }
  if (output.status !== "ok") {
    return withNotes(head(output.status, "Confluence comments"), output.notes).join("\n");
  }
  const lines = head("ok", `${output.count} comment(s)`);
  for (const comment of output.comments) {
    lines.push("", `**${comment.author}** (${comment.created}):`, comment.text);
  }
  if (output.truncated) lines.push("", "Note: more comments exist than were returned.");
  return withNotes(lines, output.notes).join("\n");
}

export function renderSearch(output: ConfluenceSearchOutput): string {
  if (output.status === "empty" || (output.status === "ok" && output.results.length === 0)) {
    return withNotes([`No results for: ${output.cql}`], output.notes).join("\n");
  }
  if (output.status !== "ok") {
    return withNotes(head(output.status, `Confluence search "${output.cql}"`), output.notes).join("\n");
  }
  const lines = head("ok", `${output.count} result(s) for "${output.cql}"`);
  for (const result of output.results) {
    lines.push("", `• [${result.type}] ${result.title} (space ${result.spaceKey}, id ${result.id})`);
    lines.push(`  ${result.url}`);
    if (result.excerpt) lines.push(`  ${result.excerpt}${result.excerptTruncated ? " [truncated]" : ""}`);
  }
  if (output.truncated) lines.push("", "Note: more matches exist than were requested.");
  if (output.droppedUnsafeUrls > 0) {
    lines.push("", `Note: ${output.droppedUnsafeUrls} result(s) were withheld because their link was not http(s).`);
  }
  return withNotes(lines, output.notes).join("\n");
}

export function renderTeams(output: TeamsMessageOutput): string {
  if (output.status !== "ok") {
    return withNotes(head(output.status, "Teams message"), output.notes).join("\n");
  }
  const lines = [
    ...head("ok", `Teams message ${output.messageId}`),
    `Author: ${output.author}`,
    `Created: ${output.created}`,
  ];
  if (output.edited) lines.push(`Edited: ${output.edited}`);
  lines.push("", output.text);
  if (output.truncated) lines.push("", "Note: the message text was truncated.");
  return withNotes(lines, output.notes).join("\n");
}

export function renderCreatePdf(output: CreatePdfOutput): string {
  if (output.status !== "ok") {
    return withNotes(head(output.status, "create_pdf"), output.notes).join("\n");
  }
  const lines = head("ok", output.output ?? "");
  lines.push(`Pages: ${output.pages}`);
  lines.push(
    `Settings: quality=${output.quality}, maxDimension=${output.maxDimension === 0 ? "original" : output.maxDimension}, grayscale=${output.grayscale ? "yes" : "no"}`,
  );
  if (output.skipped.length > 0) lines.push(`Skipped: ${output.skipped.join("; ")}`);
  return withNotes(lines, output.notes).join("\n");
}

export function renderPdfClean(output: PdfCleanOutput): string {
  if (output.status !== "ok") {
    return withNotes(head(output.status, `pdf_clean '${output.operation}'`), output.notes).join("\n");
  }
  const lines = head("ok", `${output.resolvedOperation ?? output.operation} → ${output.output ?? ""}`);
  lines.push(`Backend: ${output.backend}`);
  if (output.kind) lines.push(`Type: ${output.kind}${output.pages === null ? "" : `, ${output.pages} page(s)`}`);
  return withNotes(lines, output.notes).join("\n");
}

/** `isError` marks execution failure only: zero matches is a successful answer. */
export function isErrorResult(output: { status: OfficeStatus }): boolean {
  return output.status === "unavailable" || output.status === "cancelled";
}
