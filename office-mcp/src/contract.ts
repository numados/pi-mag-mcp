/**
 * Single owner of the office-mcp contract.
 *
 * The advertised input schemas (tools/list + runtime validation), the advertised
 * output schemas and the failure vocabulary all derive from here. No other
 * module restates these rules.
 */
import { z } from "zod";

export const STATUSES = ["ok", "empty", "unavailable", "cancelled"] as const;
export type OfficeStatus = (typeof STATUSES)[number];

/** Structured failure causes. Notes and guidance derive from these alone. */
export const FAILURE_KINDS = [
  "not-found",
  "timeout",
  "cancelled",
  "busy",
  "missing-tools",
  "unsupported",
  "conflict",
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Hard limits. One owner; the tools read these, never restate them. */
export const LIMITS = {
  /** create_pdf: caller-supplied paths and the expansion cap. */
  imagesMax: 200,
  expandedImagesMax: 500,
  /** Subprocess output cap and per-operation timeouts. */
  pdfCreateTimeoutMs: 300_000,
  pdfCleanTimeoutMs: 540_000,
  subprocessOutputMaxBytes: 16_000_000,
  /** Concurrent heavy PDF jobs; excess calls get an honest busy status. */
  maxConcurrentPdfJobs: 2,
} as const;

export const PDF_OPERATIONS = ["auto", "grayscale", "bw", "clean-scan", "ocr", "optimize", "info"] as const;
export type PdfOperation = (typeof PDF_OPERATIONS)[number];

export const PDF_SORT_ORDERS = ["name", "name-desc", "mtime", "mtime-desc", "none"] as const;
export type PdfSortOrder = (typeof PDF_SORT_ORDERS)[number];

// ------------------------------------------------------------------ inputs

const filePath = z.string().trim().min(1, "a file path is required").max(4_096, "path is too long");

export const createPdfInputSchema = z.strictObject({
  images: z
    .array(filePath)
    .min(1, "at least one image path or directory is required")
    .max(LIMITS.imagesMax, `at most ${LIMITS.imagesMax} inputs`)
    .describe("Image file paths and/or directories. Directories are expanded to image files directly inside them (non-recursive)."),
  output: filePath.describe("Output PDF path, e.g. /tmp/scans.pdf"),
  sortBy: z.enum(PDF_SORT_ORDERS).default("name").describe(
    "Page order. name (default) = natural numeric sort, so page2 precedes page10; none keeps the given order.",
  ),
  quality: z
    .number()
    .int("quality must be an integer")
    .min(1)
    .max(100)
    .default(82)
    .describe("JPEG quality 1-100; lower means a smaller PDF (default 82)"),
  maxDimension: z
    .number()
    .int("maxDimension must be an integer")
    .min(0)
    .max(20_000)
    .default(2_480)
    .describe("Downscale so no side exceeds this many px; 0 keeps the original size (default 2480)"),
  grayscale: z.boolean().default(false).describe("Convert pages to grayscale (default false)"),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Replace an existing output file. Default false: an existing output is refused, never silently replaced."),
});
export type CreatePdfInput = z.infer<typeof createPdfInputSchema>;

export const pdfCleanInputSchema = z.strictObject({
  input: filePath.describe("Path to the input PDF file"),
  operation: z.enum(PDF_OPERATIONS).describe(
    "What to do. auto = inspect then pick (scanned → clean-scan, digital → grayscale); info inspects only.",
  ),
  output: filePath.optional().describe("Output PDF path. Default: <name>.<operation>.pdf next to the input"),
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_+-]{1,64}$/, "language must look like eng, deu or rus+eng")
    .default("eng")
    .describe('OCR language(s) for ocr/clean-scan, e.g. "eng" or "rus+eng" (default eng)'),
  threshold: z
    .number()
    .int("threshold must be an integer")
    .min(1)
    .max(99)
    .default(55)
    .describe("Binarization threshold % for bw; higher keeps more as black (default 55)"),
  dpi: z
    .number()
    .int("dpi must be an integer")
    .min(72)
    .max(600)
    .default(300)
    .describe("Rasterization DPI for bw (default 300)"),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Replace an existing output file. Default false: an existing output is refused, never silently replaced."),
});
export type PdfCleanInput = z.infer<typeof pdfCleanInputSchema>;

// ----------------------------------------------------------------- outputs

const status = z.enum(STATUSES);
const reason = z.enum(FAILURE_KINDS).nullable();
const notes = z.array(z.string());

export const createPdfOutputSchema = z.object({
  status,
  output: z.string().nullable(),
  pages: z.number().int(),
  inputBytes: z.number().int().nullable(),
  outputBytes: z.number().int().nullable(),
  files: z.array(z.string()),
  skipped: z.array(z.string()),
  quality: z.number().int().nullable(),
  maxDimension: z.number().int().nullable(),
  grayscale: z.boolean().nullable(),
  reason,
  notes,
});
export type CreatePdfOutput = z.infer<typeof createPdfOutputSchema>;

export const pdfCleanOutputSchema = z.object({
  status,
  operation: z.enum(PDF_OPERATIONS),
  /** Operation actually executed; differs from `operation` for auto. */
  resolvedOperation: z.enum(PDF_OPERATIONS).nullable(),
  input: z.string(),
  output: z.string().nullable(),
  inputBytes: z.number().int().nullable(),
  outputBytes: z.number().int().nullable(),
  backend: z.string(),
  /** digital | scanned, set only by info/auto after a successful inspection. */
  kind: z.string().nullable(),
  pages: z.number().int().nullable(),
  hasFonts: z.boolean().nullable(),
  reason,
  notes,
});
export type PdfCleanOutput = z.infer<typeof pdfCleanOutputSchema>;

/** True for statuses the model must treat as execution failures. */
export function isFailureStatus(value: OfficeStatus): boolean {
  return value === "unavailable" || value === "cancelled";
}
