/**
 * Contract invariants: strict inputs, real defaults, structured outputs.
 *
 * The advertised schema is the runtime validator, so these tests are the
 * acceptance baseline for the tool surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  createPdfInputSchema,
  pdfCleanInputSchema,
  createPdfOutputSchema,
  pdfCleanOutputSchema,
  isFailureStatus,
} from "../dist/contract.js";

const parsePdf = (value) => createPdfInputSchema.safeParse(value);
const parseClean = (value) => pdfCleanInputSchema.safeParse(value);

test("create_pdf defaults are real values and ranges are enforced", () => {
  const parsed = parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf" });
  assert.equal(parsed.success, true);
  assert.deepEqual(
    { sortBy: parsed.data.sortBy, quality: parsed.data.quality, maxDimension: parsed.data.maxDimension, grayscale: parsed.data.grayscale, overwrite: parsed.data.overwrite },
    { sortBy: "name", quality: 82, maxDimension: 2480, grayscale: false, overwrite: false },
  );
  assert.equal(parsePdf({ images: [], output: "/tmp/a.pdf" }).success, false);
  assert.equal(parsePdf({ images: ["/tmp/a.png"] }).success, false, "output is required");
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", quality: 0 }).success, false);
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", quality: 101 }).success, false);
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", quality: 82.5 }).success, false);
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", sortBy: "size" }).success, false);
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", maxDimension: -1 }).success, false);
  assert.equal(
    parsePdf({ images: Array.from({ length: LIMITS.imagesMax + 1 }, (_, i) => `/tmp/${i}.png`), output: "/tmp/a.pdf" }).success,
    false,
  );
});

test("unknown arguments are rejected instead of silently dropped", () => {
  assert.equal(parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf", dpi: 300 }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw", quality: 80 }).success, false);
});

test("pdf_clean keeps the operation enum and validates numeric ranges", () => {
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw" }).data.threshold, 55);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw" }).data.dpi, 300);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw" }).data.language, "eng");
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "shred" }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw", threshold: 0 }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw", threshold: 100 }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw", dpi: 71 }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "bw", dpi: 601 }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "ocr", language: "eng; rm -rf /" }).success, false);
  assert.equal(parseClean({ input: "/tmp/a.pdf", operation: "ocr", language: "rus+eng" }).success, true);
});

test("output schemas accept documented shapes and reject unknown causes", () => {
  const created = {
    status: "ok",
    output: "/tmp/a.pdf",
    pages: 2,
    inputBytes: 10,
    outputBytes: 5,
    files: ["/tmp/a.png"],
    skipped: [],
    quality: 82,
    maxDimension: 2480,
    grayscale: false,
    reason: null,
    notes: [],
  };
  assert.equal(createPdfOutputSchema.safeParse(created).success, true);
  assert.equal(createPdfOutputSchema.safeParse({ ...created, status: "fine" }).success, false);
  assert.equal(createPdfOutputSchema.safeParse({ ...created, reason: "made-up" }).success, false);

  const clean = {
    status: "ok",
    operation: "info",
    resolvedOperation: "info",
    input: "/tmp/a.pdf",
    output: null,
    inputBytes: 10,
    outputBytes: null,
    backend: "poppler → inspection",
    kind: "digital",
    pages: 2,
    hasFonts: true,
    reason: null,
    notes: [],
  };
  assert.equal(pdfCleanOutputSchema.safeParse(clean).success, true);
  assert.equal(pdfCleanOutputSchema.safeParse({ ...clean, reason: "auth" }).success, false, "a remote-only cause cannot leak into this server");
});

test("only unavailable and cancelled are execution failures", () => {
  assert.equal(isFailureStatus("unavailable"), true);
  assert.equal(isFailureStatus("cancelled"), true);
  assert.equal(isFailureStatus("empty"), false);
  assert.equal(isFailureStatus("ok"), false);
});
