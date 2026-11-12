/**
 * PDF tools: `create_pdf` (images → PDF via ImageMagick) and `pdf_clean`
 * (ghostscript / ImageMagick / OCRmyPDF / poppler router).
 *
 * Safety rules owned here:
 * - a caller's input file is never overwritten and an existing output is
 *   refused unless `overwrite: true` was passed explicitly;
 * - each transformation writes a unique temporary file next to the target and
 *   is renamed into place only after it exists and is a regular file;
 * - dependency discovery is honest: a missing tool names the exact install
 *   command instead of failing mid-run;
 * - `auto` refuses to guess when inspection could not complete;
 * - concurrent heavy jobs are capped, so two OCR runs cannot exhaust memory.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  PDF_OPERATIONS,
  type CreatePdfInput,
  type CreatePdfOutput,
  type FailureKind,
  type PdfCleanInput,
  type PdfCleanOutput,
  type PdfOperation,
  type PdfSortOrder,
} from "./contract.js";
import { toolchainInstallHint } from "./requirements.js";
import { missingToolsFor, missingToolsNote, toolPaths, type Operation, type ToolName, type ToolPaths } from "./toolchain.js";
import { runCommand, SubprocessError, sanitizedEnv } from "./subprocess.js";

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".bmp",
  ".gif",
]);

function normalizePath(input: string, cwd: string): string {
  return resolve(cwd, input.replace(/^@/, ""));
}

function isPdf(file: string): boolean {
  return extname(file).toLowerCase() === ".pdf";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** A unique temporary path in the destination directory, so rename stays atomic. */
function temporaryPath(output: string): string {
  const dir = dirname(output);
  const stem = basename(output, extname(output));
  return join(dir, `.${stem}.tmp-${process.pid}-${randomUUID().slice(0, 8)}.pdf`);
}

/**
 * Publish a finished temporary file.
 *
 * With `overwrite` the file is moved into place. Without it a hard link is
 * created instead: creating the link and failing when the target exists is one
 * atomic step, so a file that appeared while the job was running is not
 * silently replaced.
 */
export function commitOutput(temp: string, output: string, overwrite: boolean): void {
  if (overwrite) {
    renameSync(temp, output);
    return;
  }
  try {
    linkSync(temp, output);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** True when a publish attempt lost the race with an existing file. */
export function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

// ------------------------------------------------------------- concurrency

let activePdfJobs = 0;

async function withPdfSlot<T>(busy: T, work: () => Promise<T>): Promise<T> {
  if (activePdfJobs >= LIMITS.maxConcurrentPdfJobs) return busy;
  activePdfJobs += 1;
  try {
    return await work();
  } finally {
    activePdfJobs -= 1;
  }
}

// ------------------------------------------------------- tool discovery
// Binary names, version flags, fallback locations, the operation -> tools
// mapping and the missing-tools notes are owned by ./toolchain.ts, which the
// --doctor report shares; the install hints come from requirements.json via
// ./requirements.ts. This module only asks for the resolved paths.

// ------------------------------------------------------------- create_pdf

export interface CollectedImages {
  files: string[];
  skipped: string[];
  overflow: boolean;
}

/** Expand files and one directory level without recursing. */
export function collectImages(inputs: string[], cwd: string): CollectedImages {
  const files: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let overflow = false;

  for (const input of inputs) {
    const path = resolve(cwd, input);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      skipped.push(`${input} (not found)`);
      continue;
    }

    let candidates: string[] = [];
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        skipped.push(`${input} (not readable)`);
        continue;
      }
      candidates = entries
        .map((name) => resolve(path, name))
        .filter((child) => {
          try {
            const childStat = statSync(child);
            return childStat.isFile() && IMAGE_EXTENSIONS.has(extname(child).toLowerCase());
          } catch {
            return false;
          }
        })
        .sort();
      if (candidates.length === 0) skipped.push(`${input} (no images inside)`);
    } else if (stat.isFile() && IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      candidates = [path];
    } else {
      skipped.push(`${input} (not a supported image: ${extname(path) || "no extension"})`);
    }

    for (const candidate of candidates) {
      if (files.length >= LIMITS.expandedImagesMax) {
        overflow = true;
        break;
      }
      if (!seen.has(candidate)) {
        seen.add(candidate);
        files.push(candidate);
      }
    }
    if (overflow) break;
  }

  return { files, skipped, overflow };
}

export function sortImages(files: string[], sortBy: PdfSortOrder): string[] {
  const sorted = [...files];
  switch (sortBy) {
    case "name":
      sorted.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      break;
    case "name-desc":
      sorted.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
      break;
    case "mtime":
      sorted.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
      break;
    case "mtime-desc":
      sorted.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      break;
    case "none":
      break;
  }
  return sorted;
}

function createPdfOutput(partial: Partial<CreatePdfOutput>): CreatePdfOutput {
  return {
    status: "unavailable",
    output: null,
    pages: 0,
    inputBytes: null,
    outputBytes: null,
    files: [],
    skipped: [],
    quality: null,
    maxDimension: null,
    grayscale: null,
    reason: null,
    notes: [],
    ...partial,
  };
}

export async function createPdf(input: CreatePdfInput, signal?: AbortSignal): Promise<CreatePdfOutput> {
  const cwd = process.cwd();
  const collected = collectImages(input.images, cwd);
  const base: Partial<CreatePdfOutput> = {
    files: collected.files,
    skipped: collected.skipped,
    quality: input.quality,
    maxDimension: input.maxDimension,
    grayscale: input.grayscale,
  };

  if (collected.files.length === 0) {
    return createPdfOutput({
      ...base,
      reason: "not-found",
      notes: [`No image files were found in the given paths.${collected.skipped.length ? ` Skipped: ${collected.skipped.join("; ")}` : ""}`],
    });
  }
  if (collected.overflow) {
    return createPdfOutput({
      ...base,
      reason: "unsupported",
      notes: [`More than ${LIMITS.expandedImagesMax} images would be expanded; narrow the input or split the job.`],
    });
  }

  const output = normalizePath(input.output, cwd);
  if (!isPdf(output)) {
    return createPdfOutput({ ...base, reason: "unsupported", notes: ["The output path must end with .pdf."] });
  }
  if (collected.files.includes(output)) {
    return createPdfOutput({ ...base, reason: "conflict", notes: ["The output path is one of the input images; refusing to overwrite an input."] });
  }
  if (existsSync(output) && !input.overwrite) {
    return createPdfOutput({
      ...base,
      reason: "conflict",
      notes: [`${output} already exists. Pass overwrite=true to replace it, or choose another output path.`],
    });
  }

  const busy = createPdfOutput({ ...base, reason: "busy", notes: [`${LIMITS.maxConcurrentPdfJobs} PDF jobs are already running; retry when one finishes.`] });
  return withPdfSlot(busy, async () => {
    const paths = await toolPaths();
    if (!paths.magick) {
      return createPdfOutput({ ...base, reason: "missing-tools", notes: [`ImageMagick is required: ${toolchainInstallHint()}.`] });
    }

    const ordered = sortImages(collected.files, input.sortBy);
    const temp = temporaryPath(output);
    try {
      mkdirSync(dirname(output), { recursive: true });
    } catch (error) {
      return createPdfOutput({
        ...base,
        reason: "unsupported",
        notes: [`Cannot create the output directory ${dirname(output)}: ${error instanceof Error ? error.message : String(error)}`],
      });
    }

    const args = [...ordered, "-auto-orient", "-background", "white", "-alpha", "remove", "-alpha", "off"];
    if (input.maxDimension > 0) args.push("-resize", `${input.maxDimension}x${input.maxDimension}>`);
    if (input.grayscale) args.push("-colorspace", "Gray");
    args.push("-quality", String(input.quality), "-compress", "JPEG", temp);

    try {
      await runCommand(paths.magick, args, {
        timeoutMs: LIMITS.pdfCreateTimeoutMs,
        env: sanitizedEnv(),
        ...(signal ? { signal } : {}),
      });
      const created = statSync(temp, { throwIfNoEntry: false });
      if (!created || !created.isFile() || created.size === 0) {
        return createPdfOutput({ ...base, reason: "unknown", notes: ["ImageMagick finished without producing a PDF file."] });
      }
      commitOutput(temp, output, input.overwrite);
      const inputBytes = ordered.reduce((sum, file) => sum + (statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0);
      const outputBytes = statSync(output).size;
      return createPdfOutput({
        ...base,
        status: "ok",
        output,
        pages: ordered.length,
        inputBytes,
        outputBytes,
        notes: [
          `Created ${output} from ${ordered.length} page(s).`,
          `Size: ${formatBytes(outputBytes)} (images on disk: ${formatBytes(inputBytes)}).`,
        ],
      });
    } catch (error) {
      rmSync(temp, { force: true });
      if (isAlreadyExists(error)) {
        return createPdfOutput({
          ...base,
          reason: "conflict",
          notes: [`${output} appeared while the PDF was being built, so it was not replaced. Pass overwrite=true to replace it.`],
        });
      }
      const failure = subprocessFailure(error);
      return createPdfOutput({ ...base, reason: failure.reason, notes: [failure.note] });
    }
  });
}

// -------------------------------------------------------------- pdf_clean

interface Inspection {
  ok: boolean;
  pages: number | null;
  hasFonts: boolean | null;
  sizeBytes: number;
  notes: string[];
}

async function inspectPdf(paths: ToolPaths, input: string, signal?: AbortSignal): Promise<Inspection> {
  const notes: string[] = [];
  let pages: number | null = null;
  let hasFonts: boolean | null = null;

  if (paths.pdfinfo) {
    try {
      const { stdout } = await runCommand(paths.pdfinfo, [input], {
        timeoutMs: 30_000,
        env: sanitizedEnv(),
        ...(signal ? { signal } : {}),
      });
      const match = stdout.match(/^Pages:\s+(\d+)/m);
      if (match?.[1]) pages = Number.parseInt(match[1], 10);
      else notes.push("pdfinfo did not report a page count.");
    } catch (error) {
      notes.push(`pdfinfo failed: ${describe(error)}`);
    }
  } else {
    notes.push("pdfinfo is missing (poppler).");
  }

  if (paths.pdffonts) {
    try {
      const { stdout } = await runCommand(paths.pdffonts, [input], {
        timeoutMs: 30_000,
        env: sanitizedEnv(),
        ...(signal ? { signal } : {}),
      });
      // The report has a two-line header; any further row means embedded fonts.
      const rows = stdout.trim().split("\n").slice(2).filter((line) => line.trim().length > 0);
      hasFonts = rows.length > 0;
    } catch (error) {
      notes.push(`pdffonts failed: ${describe(error)}`);
    }
  } else {
    notes.push("pdffonts is missing (poppler).");
  }

  const size = statSync(input, { throwIfNoEntry: false })?.size ?? 0;
  return { ok: pages !== null && hasFonts !== null, pages, hasFonts, sizeBytes: size, notes };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pdfCleanOutput(partial: Partial<PdfCleanOutput>): PdfCleanOutput {
  return {
    status: "unavailable",
    operation: "info",
    resolvedOperation: null,
    input: "",
    output: null,
    inputBytes: null,
    outputBytes: null,
    backend: "",
    kind: null,
    pages: null,
    hasFonts: null,
    reason: null,
    notes: [],
    ...partial,
  };
}

function subprocessFailure(error: unknown): { reason: FailureKind; note: string } {
  if (error instanceof SubprocessError) {
    switch (error.kind) {
      case "not-found":
        return { reason: "missing-tools", note: `${error.message}. Install with: ${toolchainInstallHint()}.` };
      case "timeout":
        return { reason: "timeout", note: `The local tool timed out: ${error.message}.` };
      case "cancelled":
        return { reason: "cancelled", note: "The job was cancelled; no output file was written." };
      case "output-overflow":
        return { reason: "unknown", note: "The local tool produced more output than this server accepts." };
      default:
        return { reason: "unknown", note: `The local tool failed: ${error.message}${error.stderr ? ` (${error.stderr})` : ""}` };
    }
  }
  return { reason: "unknown", note: describe(error) };
}

function commandFor(operation: PdfOperation, input: PdfCleanInput, paths: ToolPaths): { command: string; args: string[]; backend: string } {
  switch (operation) {
    case "grayscale":
      return {
        command: paths.gs!,
        backend: "ghostscript → grayscale",
        args: [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.6",
          "-sColorConversionStrategy=Gray",
          "-dProcessColorModel=/DeviceGray",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          "-sOutputFile={output}",
          "{input}",
        ],
      };
    case "bw":
      return {
        command: paths.magick!,
        backend: `imagemagick → 1-bit B&W (${input.dpi}dpi, threshold ${input.threshold}%)`,
        args: [
          "-density",
          String(input.dpi),
          "{input}",
          "-alpha",
          "remove",
          "-background",
          "white",
          "-colorspace",
          "Gray",
          "-normalize",
          "-sharpen",
          "0x1",
          "-threshold",
          `${input.threshold}%`,
          "-compress",
          "Group4",
          "{output}",
        ],
      };
    case "clean-scan":
      return {
        command: paths.ocrmypdf!,
        backend: `ocrmypdf → clean-scan (lang=${input.language})`,
        args: ["--clean", "--deskew", "--optimize", "1", "--skip-text", "-l", input.language, "{input}", "{output}"],
      };
    case "ocr":
      return {
        command: paths.ocrmypdf!,
        backend: `ocrmypdf → OCR text layer (lang=${input.language})`,
        args: ["--skip-text", "--optimize", "0", "-l", input.language, "{input}", "{output}"],
      };
    case "optimize":
      return {
        command: paths.gs!,
        backend: "ghostscript → /ebook compression",
        args: [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.6",
          "-dPDFSETTINGS=/ebook",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          "-sOutputFile={output}",
          "{input}",
        ],
      };
    default:
      throw new Error(`unhandled operation: ${operation}`);
  }
}

/**
 * Fill the path markers inside each argument.
 *
 * The replacement is per-argument, not whole-argument: `-sOutputFile={output}`
 * is a single token for ghostscript, and a whole-token comparison would leave a
 * literal file named `TEMP` in the working directory instead of writing where
 * the caller asked.
 */
export function substituteArgs(args: string[], input: string, output: string): string[] {
  return args.map((arg) => arg.replaceAll("{input}", input).replaceAll("{output}", output));
}

function inspectFailure(operation: Operation, missing: readonly ToolName[]): { reason: FailureKind; note: string } {
  return { reason: "missing-tools", note: missingToolsNote(operation, missing) };
}

/**
 * Why an output path cannot be written, or null when it can.
 *
 * One owner for the overwrite/aliasing rules, shared by the early check (which
 * must not depend on installed tools) and the post-inspection check.
 */
function outputProblem(
  source: string,
  input: PdfCleanInput,
  operation: PdfOperation,
  cwd: string,
): { reason: FailureKind; note: string } | null {
  const output = input.output ? normalizePath(input.output, cwd) : defaultOutput(source, operation);
  if (!isPdf(output)) return { reason: "unsupported", note: "The output path must end with .pdf." };
  if (output === source) {
    return {
      reason: "conflict",
      note: "The output path is the input file; this server never overwrites its input. Choose another output path.",
    };
  }
  if (existsSync(output) && !input.overwrite) {
    return { reason: "conflict", note: `${output} already exists. Pass overwrite=true to replace it, or choose another output path.` };
  }
  return null;
}

export async function pdfClean(input: PdfCleanInput, signal?: AbortSignal): Promise<PdfCleanOutput> {
  const cwd = process.cwd();
  const source = normalizePath(input.input, cwd);
  const base: Partial<PdfCleanOutput> = { operation: input.operation, input: source };

  const sourceStat = statSync(source, { throwIfNoEntry: false });
  if (!sourceStat || !sourceStat.isFile()) {
    return pdfCleanOutput({ ...base, reason: "not-found", notes: [`Input file not found: ${source}`] });
  }
  if (!isPdf(source)) {
    return pdfCleanOutput({ ...base, reason: "unsupported", notes: [`Input is not a PDF: ${source}`] });
  }

  // An explicit operation can be checked before tool discovery, so a refused
  // overwrite is reported even on a machine without the local toolchain.
  if (input.operation !== "info" && input.operation !== "auto") {
    const problem = outputProblem(source, input, input.operation, cwd);
    if (problem) {
      return pdfCleanOutput({ ...base, resolvedOperation: input.operation, reason: problem.reason, notes: [problem.note] });
    }
  }

  const busy = pdfCleanOutput({ ...base, reason: "busy", notes: [`${LIMITS.maxConcurrentPdfJobs} PDF jobs are already running; retry when one finishes.`] });
  return withPdfSlot(busy, async () => {
    const paths = await toolPaths();

    let operation: PdfOperation = input.operation;
    let inspection: Inspection | null = null;

    if (operation === "info" || operation === "auto") {
      const missing = missingToolsFor(operation, paths);
      if (missing.length > 0) {
        const failure = inspectFailure(operation, missing);
        return pdfCleanOutput({ ...base, reason: failure.reason, notes: [failure.note] });
      }
      inspection = await inspectPdf(paths, source, signal);
      if (!inspection.ok) {
        // Guessing here would silently pick the wrong cleanup for a scan.
        return pdfCleanOutput({
          ...base,
          inputBytes: inspection.sizeBytes,
          reason: "unsupported",
          notes: ["Could not complete PDF inspection, so no operation was chosen.", ...inspection.notes],
        });
      }
      const kind = inspection.hasFonts ? "digital" : "scanned";
      if (operation === "info") {
        return pdfCleanOutput({
          ...base,
          status: "ok",
          inputBytes: inspection.sizeBytes,
          kind,
          pages: inspection.pages,
          hasFonts: inspection.hasFonts,
          backend: "poppler → inspection",
          notes: [
            `Type: ${inspection.hasFonts ? "digital (embedded text/fonts)" : "scanned or image-based (no fonts)"}`,
            `Recommendation: ${inspection.hasFonts ? "grayscale for ink saving, or optimize for a smaller file" : "bw for print-ready 1-bit output, or clean-scan to keep quality with OCR"}`,
          ],
        });
      }
      operation = inspection.hasFonts ? "grayscale" : "clean-scan";
    }

    const missing = missingToolsFor(operation, paths);
    if (missing.length > 0) {
      const failure = inspectFailure(operation, missing);
      return pdfCleanOutput({ ...base, resolvedOperation: operation, reason: failure.reason, notes: [failure.note] });
    }

    const problem = outputProblem(source, input, operation, cwd);
    if (problem) {
      return pdfCleanOutput({ ...base, resolvedOperation: operation, reason: problem.reason, notes: [problem.note] });
    }
    const output = input.output ? normalizePath(input.output, cwd) : defaultOutput(source, operation);

    const temp = temporaryPath(output);
    let command: { command: string; args: string[]; backend: string };
    try {
      command = commandFor(operation, input, paths);
    } catch (error) {
      return pdfCleanOutput({ ...base, resolvedOperation: operation, reason: "unsupported", notes: [describe(error)] });
    }

    try {
      mkdirSync(dirname(output), { recursive: true });
      await runCommand(command.command, substituteArgs(command.args, source, temp), {
        timeoutMs: LIMITS.pdfCleanTimeoutMs,
        env: sanitizedEnv(),
        ...(signal ? { signal } : {}),
      });
      const created = statSync(temp, { throwIfNoEntry: false });
      if (!created || !created.isFile() || created.size === 0) {
        rmSync(temp, { force: true });
        return pdfCleanOutput({
          ...base,
          resolvedOperation: operation,
          reason: "unknown",
          notes: [`${command.backend} finished without producing a PDF file.`],
        });
      }
      commitOutput(temp, output, input.overwrite);
      const inputBytes = inspection?.sizeBytes ?? statSync(source).size;
      const outputBytes = statSync(output).size;
      return pdfCleanOutput({
        ...base,
        status: "ok",
        resolvedOperation: operation,
        output,
        inputBytes,
        outputBytes,
        backend: command.backend,
        kind: inspection ? (inspection.hasFonts ? "digital" : "scanned") : null,
        pages: inspection?.pages ?? null,
        hasFonts: inspection?.hasFonts ?? null,
        notes: [`${formatBytes(inputBytes)} → ${formatBytes(outputBytes)}.`],
      });
    } catch (error) {
      rmSync(temp, { force: true });
      if (isAlreadyExists(error)) {
        return pdfCleanOutput({
          ...base,
          resolvedOperation: operation,
          reason: "conflict",
          notes: [`${output} appeared while the PDF was being cleaned, so it was not replaced. Pass overwrite=true to replace it.`],
        });
      }
      const failure = subprocessFailure(error);
      return pdfCleanOutput({ ...base, resolvedOperation: operation, reason: failure.reason, notes: [failure.note] });
    }
  });
}

function defaultOutput(input: string, operation: PdfOperation): string {
  const stem = basename(input, extname(input));
  return join(dirname(input), `${stem}.${operation}.pdf`);
}

/** Exposed for the `info` path in tests: the operations this module can run. */
export const OPERATIONS = PDF_OPERATIONS;
