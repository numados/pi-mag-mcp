/**
 * Text projection of every structured result.
 *
 * The structured form is authoritative; this text exists so clients that
 * ignore `structuredContent` still get usable output, and so a status is
 * legible without parsing prose. It never adds information the structure lacks.
 */
import type { CreatePdfOutput, OfficeStatus, PdfCleanOutput } from "./contract.js";

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
