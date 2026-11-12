/**
 * Doctor: the toolchain table, the readiness verdicts and the `--doctor` CLI.
 *
 * Discovery is injected (unit level) or faked with executables in the OS temp
 * directory, so no test depends on this machine's installed tools; the CLI
 * tests spawn the built server directly, without the optional Pi client. The
 * fake executables log any non-version invocation, so the tests also prove the
 * doctor never runs a PDF-mutating command.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildDoctorReport, renderDoctorReport } from "../dist/doctor.js";
import { installCommandFor, loadRequirements, parseRequirements, toolchainInstallHint } from "../dist/requirements.js";
import {
  candidateCommands,
  defaultProbe,
  missingToolsFor,
  missingToolsNote,
  resolveTool,
  TOOL_NAMES,
  VERSION_FLAG,
} from "../dist/toolchain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const pathsFor = (present) =>
  Object.fromEntries(TOOL_NAMES.map((tool) => [tool, present.includes(tool) ? `/fixture/bin/${tool}` : null]));

const depsFor = (present) => ({
  resolveTool: (tool) => Promise.resolve(present.includes(tool) ? `/fixture/bin/${tool}` : null),
});

function fakeExecutable(dir, name, audit) {
  const file = path.join(dir, name);
  // Version flags answer 0; anything else is logged as a mutation attempt and
  // also answers 0, so a wrongly-used flag cannot pass silently as absent.
  const body =
    audit === undefined
      ? "#!/bin/sh\nexit 0\n"
      : `#!/bin/sh\ncase "$1" in ${VERSION_FLAG[name]}) exit 0;; *) printf '%s\\n' "$*" >> ${JSON.stringify(audit)};; esac\n`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

// ------------------------------------------------------------------- table

test("requirements.json is valid and covers exactly the toolchain", () => {
  const entries = loadRequirements();
  assert.deepEqual(
    [...entries].map((entry) => entry.tool).sort(),
    [...TOOL_NAMES].sort(),
    "the table and TOOL_NAMES must not drift apart",
  );
  for (const entry of entries) {
    assert.equal(typeof entry.required, "boolean", `${entry.tool} must say whether it is required`);
    assert.match(installCommandFor(entry), /^brew install (imagemagick|ghostscript|ocrmypdf|poppler)$/);
  }
  assert.equal(toolchainInstallHint(entries), "brew install imagemagick ghostscript ocrmypdf poppler");
  assert.throws(() => parseRequirements({ binaries: [{ tool: "magick" }] }), /requirements.json is invalid/);
  assert.throws(() => parseRequirements({}), /requirements.json is invalid/);
});

test("the operation mapping the doctor reports is the one the runtime checks", () => {
  const all = pathsFor(TOOL_NAMES);
  for (const operation of ["create_pdf", "auto", "grayscale", "bw", "clean-scan", "ocr", "optimize", "info"]) {
    assert.deepEqual(missingToolsFor(operation, all), []);
  }
  assert.deepEqual(missingToolsFor("bw", pathsFor(["magick"])), ["gs"]);
  assert.deepEqual(missingToolsFor("info", pathsFor([])), ["pdfinfo", "pdffonts"]);
  // The runtime note names packages from the table, deduplicated, plus one hint.
  assert.equal(
    missingToolsNote("info", ["pdfinfo", "pdffonts"]),
    "Missing poppler for 'info'. Install with: brew install imagemagick ghostscript ocrmypdf poppler.",
  );
});

// ----------------------------------------------------------------- verdicts

test("a fully available toolchain reports every operation ready and ok", async () => {
  const report = await buildDoctorReport(depsFor(TOOL_NAMES));
  assert.equal(report.ok, true);
  assert.deepEqual(report.tools.map((tool) => tool.verdict), TOOL_NAMES.map(() => "present"));
  for (const operation of report.operations) assert.equal(operation.readiness, "ready");
  assert.match(renderDoctorReport(report), /readiness: ok — 5\/5 tools present/);
});

test("a partial toolchain limits exactly the operations that need the missing tools", async () => {
  const report = await buildDoctorReport(depsFor(["magick", "gs"]));
  const readiness = Object.fromEntries(report.operations.map((entry) => [entry.operation, entry.readiness]));
  assert.deepEqual(readiness, {
    create_pdf: "ready",
    auto: "blocked",
    grayscale: "ready",
    bw: "ready",
    "clean-scan": "blocked",
    ocr: "blocked",
    optimize: "ready",
    info: "blocked",
  });
  // Optional tools only limit operations: partial readiness is a valid state.
  assert.equal(report.ok, true);
  const text = renderDoctorReport(report);
  assert.match(text, /readiness: partial — 2\/5 tools present/);
  assert.match(text, /blocked: auto, clean-scan, ocr, info/);
});

test("a missing required tool fails readiness even when optional tools are present", async () => {
  const report = await buildDoctorReport(depsFor(["gs", "ocrmypdf", "pdfinfo", "pdffonts"]));
  assert.equal(report.ok, false);
  assert.match(renderDoctorReport(report), /exit 1: a required tool is missing/);
});

test("an absent toolchain blocks every operation and names the install hint", async () => {
  const report = await buildDoctorReport(depsFor([]));
  assert.equal(report.ok, false);
  assert.deepEqual(report.tools.map((tool) => tool.verdict), TOOL_NAMES.map(() => "missing"));
  for (const operation of report.operations) assert.equal(operation.readiness, "blocked");
  const text = renderDoctorReport(report);
  assert.match(text, /✗ magick \(required\) — .* \[install: brew install imagemagick\]/);
  assert.match(
    text,
    /readiness: not ready — 0\/5 tools present; install the toolchain: brew install imagemagick ghostscript ocrmypdf poppler/,
  );
});

// --------------------------------------------------------------- discovery

test("candidates are probed PATH-first, then the Homebrew fallback prefixes", () => {
  assert.deepEqual(candidateCommands("magick"), ["magick", "/opt/homebrew/bin/magick", "/usr/local/bin/magick"]);
});

test("the real probe accepts a fake executable, rejects absence, and odd exits stay usable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office-mcp-probe-"));
  try {
    const fake = fakeExecutable(dir, "ocrmypdf");
    assert.equal(await defaultProbe(fake, VERSION_FLAG.ocrmypdf), true);
    assert.equal(await defaultProbe(path.join(dir, "nope"), VERSION_FLAG.ocrmypdf), false);
    // A binary that exists but exits non-zero on its version flag is usable.
    const odd = path.join(dir, "gs");
    writeFileSync(odd, "#!/bin/sh\nexit 3\n");
    chmodSync(odd, 0o755);
    assert.equal(await defaultProbe(odd, VERSION_FLAG.gs), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTool walks the candidate list until one answers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office-mcp-resolve-"));
  try {
    const fake = fakeExecutable(dir, "ocrmypdf");
    const onlyInDir = (command, flag) =>
      command.startsWith(`${dir}/`) ? defaultProbe(command, flag) : Promise.resolve(false);
    assert.equal(await resolveTool("ocrmypdf", onlyInDir, [dir]), fake);
    assert.equal(await resolveTool("magick", onlyInDir, [dir]), null, "no candidate, no resolution");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- CLI

/** stdin is a pipe nobody writes to or closes — a doctor that reads it hangs. */
function runDoctorCli(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverEntry, "--doctor"], {
      env: { ...env, TMPDIR: process.env.TMPDIR ?? tmpdir() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

test("--doctor with the full toolchain on PATH exits 0 and runs version flags only", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "office-mcp-cli-bin-"));
  const home = mkdtempSync(path.join(tmpdir(), "office-mcp-cli-home-"));
  const audit = path.join(bin, "audit.log");
  try {
    for (const tool of TOOL_NAMES) fakeExecutable(bin, tool, audit);
    const result = await runDoctorCli({ PATH: bin, HOME: home });

    assert.equal(result.timedOut, false, "the doctor must not wait on stdin");
    assert.equal(result.code, 0, result.stderr);
    for (const tool of TOOL_NAMES) assert.match(result.stdout, new RegExp(`✓ ${tool} `));
    assert.match(result.stdout, /readiness: ok — 5\/5 tools present/);
    assert.equal(existsSync(audit), false, "no command beyond a version flag may run");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("--doctor exits 1 exactly when a required tool is missing, whatever this machine has", async () => {
  const empty = mkdtempSync(path.join(tmpdir(), "office-mcp-cli-empty-"));
  const home = mkdtempSync(path.join(tmpdir(), "office-mcp-cli-home-"));
  try {
    // PATH has no toolchain; the Homebrew prefixes are still probed, so the
    // machine may legitimately answer for some tools. The exit code must agree
    // with the report it printed: 1 iff a required tool shows as missing.
    const result = await runDoctorCli({ PATH: empty, HOME: home });
    assert.equal(result.timedOut, false);
    const required = loadRequirements().filter((entry) => entry.required).map((entry) => entry.tool);
    const missingRequired = required.filter((tool) => result.stdout.includes(`✗ ${tool} (required)`));
    assert.equal(result.code, missingRequired.length > 0 ? 1 : 0);
    for (const tool of TOOL_NAMES) assert.match(result.stdout, new RegExp(`[✓✗] ${tool} \\((required|optional)\\)`));
    assert.match(result.stdout, /^operations:$/m);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("--doctor consumes no stdin: it exits with the pipe held open", async () => {
  const result = await runDoctorCli({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
  assert.equal(result.timedOut, false, "nothing may keep the process alive waiting for input");
  assert.ok(result.code === 0 || result.code === 1);
  assert.match(result.stdout, /office doctor \(node /);
});
