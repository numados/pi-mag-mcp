/**
 * office MCP server entry (stdio). Two PDF tools:
 *   create_pdf — compressed PDF from images via ImageMagick.
 *   pdf_clean — ghostscript / ImageMagick / OCRmyPDF / poppler router.
 *
 * stdout is the protocol channel: nothing but MCP frames may be written there.
 * Diagnostics go to stderr and never include caller paths or document content.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createPdfInputSchema,
  createPdfOutputSchema,
  pdfCleanInputSchema,
  pdfCleanOutputSchema,
} from "./contract.js";
import { createPdf, pdfClean } from "./pdf.js";
import { isErrorResult, renderCreatePdf, renderPdfClean } from "./render.js";
import type { ZodType } from "zod";

function log(message: string): void {
  process.stderr.write(`[office] ${message}\n`);
}

/** Validate the produced structure against the advertised schema before sending it. */
function respond<T>(
  schema: ZodType<T>,
  value: T,
  render: (value: T) => string,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  const validated = schema.safeParse(value);
  if (!validated.success) {
    log(`structured output failed its own schema: ${validated.error.message}`);
    return {
      content: [{ type: "text", text: "Internal error: the tool produced output that failed validation." }],
      isError: true,
    };
  }
  const data = validated.data;
  return {
    content: [{ type: "text", text: render(data) }],
    structuredContent: data as unknown as Record<string, unknown>,
    ...(isErrorResult(data as unknown as { status: "ok" | "empty" | "unavailable" | "cancelled" }) ? { isError: true } : {}),
  };
}

serveStdio(() => {
  const server = new McpServer(
    { name: "office", version: "0.1.0" },
    {
      instructions:
        "office converts local images and PDFs only: it reads no remote service and needs no credentials. " +
        "Both tools write files, so an existing output is refused unless overwrite=true is passed.",
    },
  );

  server.registerTool(
    "create_pdf",
    {
      title: "Create PDF from images",
      description:
        "Build one compressed PDF from images (jpg, png, webp, heic, tiff, bmp, gif) via ImageMagick. " +
        "Accepts files and/or directories; directories expand one level and are sorted by name in numeric order by default. " +
        "Compresses by default: override quality/maxDimension only when the user asks for higher fidelity or a smaller file. " +
        "An existing output file is refused unless overwrite=true. Relative paths resolve against the Pi session directory.",
      inputSchema: createPdfInputSchema,
      outputSchema: createPdfOutputSchema,
      annotations: { title: "Create PDF from images", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx) => {
      const output = await createPdf(args, ctx.mcpReq.signal);
      return respond(createPdfOutputSchema, output, renderCreatePdf);
    },
  );

  server.registerTool(
    "pdf_clean",
    {
      title: "Clean up PDF",
      description:
        "Clean a PDF for printing or archiving. Operations: grayscale (ghostscript), bw (1-bit black & white, best ink saving for scans), " +
        "clean-scan (OCRmyPDF clean+deskew+OCR; use bw for full background removal), ocr (text layer only), optimize (smaller file), " +
        "info (inspect only), auto (inspect, then grayscale for digital or clean-scan for scans). " +
        "Never overwrites the input and refuses an existing output unless overwrite=true; writes <name>.<operation>.pdf by default. " +
        "Requires the local tools named by a missing-tools error. Relative paths resolve against the Pi session directory.",
      inputSchema: pdfCleanInputSchema,
      outputSchema: pdfCleanOutputSchema,
      annotations: { title: "Clean up PDF", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx) => {
      const output = await pdfClean(args, ctx.mcpReq.signal);
      return respond(pdfCleanOutputSchema, output, renderPdfClean);
    },
  );

  return server;
});
