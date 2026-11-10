/**
 * PDF behaviour: image collection, the overwrite/aliasing rules, honest
 * dependency failures and one real ImageMagick conversion when it is installed.
 *
 * No test runs OCR or writes outside a temporary directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS } from "../dist/contract.js";
import { collectImages, commitOutput, createPdf, isAlreadyExists, pdfClean, sortImages } from "../dist/pdf.js";

/** A valid 1x1 PNG, so a real conversion can be attempted without fixtures. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const magickAvailable = spawnSync("magick", ["-version"], { encoding: "utf8" }).status === 0;

function pdfInput(overrides) {
  return {
    sortBy: "name",
    quality: 82,
    maxDimension: 2480,
    grayscale: false,
    overwrite: false,
    ...overrides,
  };
}

function cleanInput(overrides) {
  return {
    operation: "info",
    language: "eng",
    threshold: 55,
    dpi: 300,
    overwrite: false,
    ...overrides,
  };
}

test("collectImages expands one directory level and skips non-images", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-images-"));
  try {
    writeFileSync(join(dir, "page1.png"), PNG);
    writeFileSync(join(dir, "page10.png"), PNG);
    writeFileSync(join(dir, "page2.png"), PNG);
    writeFileSync(join(dir, "notes.txt"), "x");
    const { files, skipped, overflow } = collectImages([dir], dir);
    assert.equal(files.length, 3);
    assert.ok(files.every((file) => file.endsWith(".png")));
    assert.equal(skipped.length, 0);
    assert.equal(overflow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectImages reports a missing path instead of throwing", () => {
  const { files, skipped } = collectImages(["/nonexistent/dir-office-mcp"], "/");
  assert.equal(files.length, 0);
  assert.match(skipped[0], /not found/);
});

test("image expansion is capped", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-cap-"));
  try {
    for (let index = 0; index < LIMITS.expandedImagesMax + 2; index += 1) {
      writeFileSync(join(dir, `p${String(index).padStart(4, "0")}.png`), PNG);
    }
    const collected = collectImages([dir], dir);
    assert.equal(collected.overflow, true);
    assert.equal(collected.files.length, LIMITS.expandedImagesMax);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("natural numeric sorting keeps page2 before page10", () => {
  const files = ["/tmp/a/page10.png", "/tmp/a/page1.png", "/tmp/a/page2.png"];
  assert.deepEqual(sortImages(files, "name").map((file) => file.split("/").pop()), ["page1.png", "page2.png", "page10.png"]);
  assert.deepEqual(sortImages(files, "name-desc").map((file) => file.split("/").pop()), ["page10.png", "page2.png", "page1.png"]);
  assert.deepEqual(sortImages(files, "none"), files);
});

test("publishing never replaces a file that appeared while the job ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-publish-"));
  try {
    const temp = join(dir, ".out.tmp.pdf");
    const output = join(dir, "out.pdf");
    writeFileSync(temp, "new content");
    writeFileSync(output, "existing content");

    assert.throws(
      () => commitOutput(temp, output, false),
      (error) => isAlreadyExists(error),
      "the publish step itself must fail, not overwrite",
    );
    assert.equal(readFileSync(output, "utf8"), "existing content");
    assert.equal(statSync(temp, { throwIfNoEntry: false }), undefined, "the temporary file is cleaned up");

    writeFileSync(temp, "new content");
    commitOutput(temp, output, true);
    assert.equal(readFileSync(output, "utf8"), "new content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create_pdf refuses an existing output unless overwrite is explicit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-pdf-"));
  try {
    writeFileSync(join(dir, "page1.png"), PNG);
    const output = join(dir, "out.pdf");
    writeFileSync(output, "existing content");

    const refused = await createPdf(pdfInput({ images: [join(dir, "page1.png")], output }));
    assert.equal(refused.status, "unavailable");
    assert.equal(refused.reason, "conflict");
    assert.equal(readFileSync(output, "utf8"), "existing content", "the existing file is untouched");
    assert.match(refused.notes.join(" "), /overwrite=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create_pdf refuses a non-PDF output and an empty image set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-pdf-"));
  try {
    writeFileSync(join(dir, "page1.png"), PNG);
    const wrongType = await createPdf(pdfInput({ images: [join(dir, "page1.png")], output: join(dir, "out.jpg") }));
    assert.equal(wrongType.reason, "unsupported");

    const nothing = await createPdf(pdfInput({ images: [join(dir, "missing.png")], output: join(dir, "out.pdf") }));
    assert.equal(nothing.status, "unavailable");
    assert.equal(nothing.reason, "not-found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create_pdf builds a real PDF when ImageMagick is installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-pdf-"));
  try {
    writeFileSync(join(dir, "page1.png"), PNG);
    writeFileSync(join(dir, "page2.png"), PNG);
    const output = join(dir, "out.pdf");
    const result = await createPdf(pdfInput({ images: [dir], output }));

    if (!magickAvailable) {
      assert.equal(result.reason, "missing-tools", "a missing toolchain is reported honestly");
      return;
    }
    assert.equal(result.status, "ok", result.notes.join(" "));
    assert.equal(result.pages, 2);
    assert.ok(statSync(output).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pdf_clean refuses to overwrite its input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-clean-"));
  try {
    const source = join(dir, "doc.pdf");
    writeFileSync(source, "%PDF-1.4 placeholder");
    const result = await pdfClean(cleanInput({ input: source, operation: "bw", output: source }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "conflict");
    assert.equal(readFileSync(source, "utf8"), "%PDF-1.4 placeholder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pdf_clean refuses an existing default output before touching the toolchain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-clean-"));
  try {
    const source = join(dir, "doc.pdf");
    writeFileSync(source, "%PDF-1.4 placeholder");
    writeFileSync(join(dir, "doc.optimize.pdf"), "previous result");
    const result = await pdfClean(cleanInput({ input: source, operation: "optimize" }));
    assert.equal(result.reason, "conflict");
    assert.match(result.notes.join(" "), /overwrite=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pdf_clean reports a missing input and a non-PDF input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-clean-"));
  try {
    const missing = await pdfClean(cleanInput({ input: join(dir, "nope.pdf") }));
    assert.equal(missing.reason, "not-found");

    const notPdf = join(dir, "notes.txt");
    writeFileSync(notPdf, "hello");
    const wrong = await pdfClean(cleanInput({ input: notPdf }));
    assert.equal(wrong.reason, "unsupported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pdf_clean does not guess when inspection cannot complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-clean-"));
  try {
    const fake = join(dir, "broken.pdf");
    writeFileSync(fake, "this is not a real PDF");
    const result = await pdfClean(cleanInput({ input: fake, operation: "auto" }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.resolvedOperation, null, "no operation is picked without a completed inspection");
    assert.ok(["unsupported", "missing-tools"].includes(result.reason), `unexpected reason ${result.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pdf_clean reports the output path honestly and leaves no temp files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-clean-"));
  try {
    const source = join(dir, "doc.pdf");
    writeFileSync(source, "%PDF-1.4 placeholder");
    const nested = join(dir, "nested", "out.pdf");
    const result = await pdfClean(cleanInput({ input: source, operation: "optimize", output: nested }));

    if (result.status === "ok") {
      assert.equal(result.output, nested);
      assert.ok(statSync(nested).size > 0);
    } else {
      assert.equal(existsSync(nested), false, "a failed job leaves no final output");
    }
    const leftovers = existsSync(join(dir, "nested"))
      ? readdirSync(join(dir, "nested")).filter((name) => name.startsWith(".") && name.includes(".tmp-"))
      : [];
    assert.deepEqual(leftovers, [], "no temporary file survives a job");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path markers are filled inside an argument, not only whole tokens", async () => {
  const { substituteArgs } = await import("../dist/pdf.js");
  assert.deepEqual(substituteArgs(["-sOutputFile={output}", "{input}", "-dQUIET"], "/in.pdf", "/out.pdf"), [
    "-sOutputFile=/out.pdf",
    "/in.pdf",
    "-dQUIET",
  ]);
  const leftover = substituteArgs(["-sOutputFile={output}", "{input}", "{output}"], "/in.pdf", "/out.pdf").filter((arg) =>
    ["TEMP", "INPUT", "{output}", "{input}"].includes(arg),
  );
  assert.deepEqual(leftover, [], "no placeholder can survive into the command");
});

test("a real cleanup writes the requested output and no stray file in cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-mcp-real-"));
  const stray = join(process.cwd(), "TEMP");
  const strayBefore = existsSync(stray) ? statSync(stray).mtimeMs : null;
  try {
    // Build a real single-page PDF from the 1x1 PNG when ImageMagick is present.
    const png = join(dir, "p.png");
    writeFileSync(png, PNG);
    const pdf = join(dir, "doc.pdf");
    const built = spawnSync("magick", [png, "-background", "white", "-alpha", "remove", "-alpha", "off", pdf], {
      encoding: "utf8",
    });
    if (!magickAvailable || built.status !== 0 || !existsSync(pdf)) {
      // Report the dependency path instead of failing on a machine without tools.
      const result = await pdfClean(cleanInput({ input: png, operation: "optimize" }));
      assert.equal(result.status, "unavailable");
      return;
    }

    const output = join(dir, "doc.clean.pdf");
    const result = await pdfClean(cleanInput({ input: pdf, operation: "optimize", output }));
    assert.equal(result.status, "ok", result.notes.join(" "));
    assert.ok(statSync(output).size > 0);
    assert.equal(result.outputBytes, statSync(output).size);
    const strayAfter = existsSync(stray) ? statSync(stray).mtimeMs : null;
    assert.equal(strayAfter, strayBefore, "no TEMP file is written into the working directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
