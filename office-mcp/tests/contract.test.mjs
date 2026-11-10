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
  confluencePageInputSchema,
  confluenceSearchInputSchema,
  createPdfInputSchema,
  pdfCleanInputSchema,
  teamsMessageInputSchema,
  confluenceSearchOutputSchema,
  pdfCleanOutputSchema,
  isFailureStatus,
} from "../dist/contract.js";

const parsePage = (value) => confluencePageInputSchema.safeParse(value);
const parseSearch = (value) => confluenceSearchInputSchema.safeParse(value);
const parsePdf = (value) => createPdfInputSchema.safeParse(value);
const parseClean = (value) => pdfCleanInputSchema.safeParse(value);

test("a locator is required, trimmed and length-bounded", () => {
  assert.equal(parsePage({}).success, false);
  assert.equal(parsePage({ url: "" }).success, false);
  assert.equal(parsePage({ url: "   " }).success, false);
  assert.equal(parsePage({ url: 17 }).success, false);
  assert.equal(parsePage({ url: " 123456 " }).data.url, "123456");
  assert.equal(parsePage({ url: "x".repeat(LIMITS.locatorMaxChars + 1) }).success, false);
});

test("unknown arguments are rejected instead of silently dropped", () => {
  assert.equal(parsePage({ url: "1", pageId: "2" }).success, false);
  assert.equal(parseSearch({ cql: "text~a", limit: 5, offset: 10 }).success, false);
});

test("cql is non-empty and limit is a bounded integer with a default", () => {
  assert.equal(parseSearch({}).success, false);
  assert.equal(parseSearch({ cql: "   " }).success, false);
  assert.equal(parseSearch({ cql: "x".repeat(LIMITS.cqlMaxChars + 1) }).success, false);
  assert.equal(parseSearch({ cql: "text~a" }).data.limit, 10);
  for (const bad of [0, -1, 1.5, LIMITS.searchMaxResults + 1, "5", null]) {
    assert.equal(parseSearch({ cql: "text~a", limit: bad }).success, false, `limit=${bad} must be rejected`);
  }
  assert.equal(parseSearch({ cql: "text~a", limit: LIMITS.searchMaxResults }).success, true);
});

test("teams_message requires a non-empty url", () => {
  assert.equal(teamsMessageInputSchema.safeParse({}).success, false);
  assert.equal(teamsMessageInputSchema.safeParse({ url: "  " }).success, false);
  assert.equal(teamsMessageInputSchema.safeParse({ url: "https://x" }).success, true);
});

test("create_pdf defaults are real values and ranges are enforced", () => {
  const parsed = parsePdf({ images: ["/tmp/a.png"], output: "/tmp/a.pdf" });
  assert.equal(parsed.success, true);
  assert.deepEqual(
    { sortBy: parsed.data.sortBy, quality: parsed.data.quality, maxDimension: parsed.data.maxDimension, grayscale: parsed.data.grayscale, overwrite: parsed.data.overwrite },
    { sortBy: "name", quality: 82, maxDimension: 2480, grayscale: false, overwrite: false },
  );
  assert.equal(parsePdf({ images: [], output: "/tmp/a.pdf" }).success, false);
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
  const search = {
    status: "ok",
    cql: "text~a",
    count: 0,
    results: [],
    truncated: false,
    droppedUnsafeUrls: 0,
    reason: null,
    notes: [],
  };
  assert.equal(confluenceSearchOutputSchema.safeParse(search).success, true);
  assert.equal(confluenceSearchOutputSchema.safeParse({ ...search, reason: "made-up" }).success, false);

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
  assert.equal(pdfCleanOutputSchema.safeParse({ ...clean, status: "fine" }).success, false);
});

test("only unavailable and cancelled are execution failures", () => {
  assert.equal(isFailureStatus("unavailable"), true);
  assert.equal(isFailureStatus("cancelled"), true);
  assert.equal(isFailureStatus("empty"), false);
  assert.equal(isFailureStatus("ok"), false);
});
