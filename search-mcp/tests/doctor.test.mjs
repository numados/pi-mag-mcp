/**
 * Doctor policy: the verdict rules and the text a user acts on. The requirement
 * table is read from requirements.json (the single owner), and binary/manager
 * lookups are injected so the test does not depend on this machine.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { candidateCommands, resolveCandidate } from "../dist/candidates.js";
import { fdProvider } from "../dist/providers/fd.js";
import { buildDoctorReport, judgeRequirement, readinessFailed } from "../dist/doctor.js";
import { formatDoctor } from "../dist/render.js";
import { loadRequirements, parseRequirements } from "../dist/requirements.js";

const requirement = (overrides = {}) => ({
  provider: "ast-grep",
  check: "ast-grep",
  what: "structural code search",
  install: "brew install ast-grep",
  manager: "brew",
  required: true,
  ...overrides,
});

const deps = ({ binaries = [], managers = ["brew"], disabled = [] } = {}) => ({
  hasBinary: (command) => binaries.includes(command),
  hasManager: (manager) => managers.includes(manager),
  isEnabled: (provider) => !disabled.includes(provider),
});

test("requirements.json is valid and covers every shipped provider", () => {
  const requirements = loadRequirements();
  const providers = requirements.map((entry) => entry.provider).sort();
  assert.deepEqual(providers, ["ast-grep", "auggie", "fd", "mdfind", "rg", "rga", "serena", "zoekt"]);
  for (const entry of requirements) {
    assert.ok(entry.check, `${entry.provider} needs a check binary`);
    assert.equal(typeof entry.required, "boolean", `${entry.provider} must say whether it is required`);
  }
});

test("a malformed requirement file fails loudly instead of being half-used", () => {
  assert.throws(() => parseRequirements({ binaries: [{ provider: "rg" }] }), /requirements.json is invalid/);
  assert.throws(() => parseRequirements({}), /requirements.json is invalid/);
});

test("verdict: present when the binary answers", () => {
  assert.equal(judgeRequirement(requirement(), deps({ binaries: ["ast-grep"] })).verdict, "present");
});

test("verdict: installable when only the package manager is missing the binary", () => {
  const report = judgeRequirement(requirement(), deps({ binaries: [] }));
  assert.equal(report.verdict, "installable");
  assert.equal(report.install, "brew install ast-grep");
  assert.equal(report.detail, undefined);
});

test("verdict: blocked when the package manager itself is absent, with the disable line", () => {
  const report = judgeRequirement(requirement({ provider: "zoekt", check: "zoekt-webserver", manager: "go" }), deps({ managers: ["brew"] }));
  assert.equal(report.verdict, "blocked");
  assert.match(report.detail, /needs go, which is not on PATH/);
  assert.match(report.detail, /\{"providers":\{"zoekt":\{"enabled":false\}\}\}/);
});

test("verdict: disabled by config wins over a missing binary", () => {
  const report = judgeRequirement(requirement(), deps({ binaries: [], disabled: ["ast-grep"] }));
  assert.equal(report.verdict, "disabled");
  assert.match(report.detail, /enable with \{"providers":\{"ast-grep":\{"enabled":true\}\}\}/);
});

test("verdict: disabled by config also wins over a present binary", () => {
  const report = judgeRequirement(requirement(), deps({ binaries: ["ast-grep"], disabled: ["ast-grep"] }));
  assert.equal(report.verdict, "disabled");
  assert.equal(readinessFailed([report]), false, "an intentionally disabled provider never fails readiness");
});

test("readiness fails only for enabled, required requirements", () => {
  const entry = (verdict, overrides = {}) => ({ ...requirement(), verdict, ...overrides });
  assert.equal(readinessFailed([entry("present")]), false);
  assert.equal(readinessFailed([entry("disabled")]), false, "required but disabled is an intentional state, not a broken machine");
  for (const verdict of ["installable", "blocked", "builtin"]) {
    assert.equal(readinessFailed([entry(verdict)]), true, `${verdict} must fail readiness`);
  }
  assert.equal(readinessFailed([entry("blocked", { required: false })]), false, "optional never fails readiness");
});

test("following the disable hint clears a blocked required provider from readiness failure", () => {
  const report = buildDoctorReport(
    [requirement({ provider: "zoekt", check: "zoekt-webserver", manager: "go", required: true })],
    deps({ managers: ["brew"] }),
  );
  assert.equal(report[0].verdict, "blocked");
  assert.match(report[0].detail, /disable with/);
  assert.equal(readinessFailed(report), true);
  const disabled = buildDoctorReport(
    [requirement({ provider: "zoekt", check: "zoekt-webserver", manager: "go", required: true })],
    deps({ managers: ["brew"], disabled: ["zoekt"] }),
  );
  assert.equal(disabled[0].verdict, "disabled");
  assert.equal(readinessFailed(disabled), false, "the documented remediation must clear the exit failure");
});

test("verdict: builtin when there is no install command", () => {
  const report = judgeRequirement(
    { provider: "mdfind", check: "mdfind", what: "Spotlight", required: false },
    deps({ binaries: [] }),
  );
  assert.equal(report.verdict, "builtin");
  assert.match(report.detail, /no install command/);
});

test("the report keeps table order and renders an actionable line per state", () => {
  const requirements = [
    requirement({ provider: "rg", check: "rg" }),
    requirement({ provider: "zoekt", check: "zoekt-webserver", manager: "go", required: false }),
    requirement({ provider: "auggie", check: "auggie", required: false, auth: true }),
  ];
  const report = buildDoctorReport(requirements, deps({ binaries: ["rg"], managers: ["brew"], disabled: ["auggie"] }));
  assert.deepEqual(report.map((entry) => entry.provider), ["rg", "zoekt", "auggie"]);
  assert.deepEqual(report.map((entry) => entry.verdict), ["present", "blocked", "disabled"]);

  const text = formatDoctor(report, ["/tmp/providers.json"], "v22.0.0");
  assert.match(text, /✓ rg — structural code search/);
  assert.match(text, /✗ zoekt — structural code search \(optional\)/);
  assert.match(text, /disable with \{"providers":\{"zoekt":\{"enabled":false\}\}\}/);
  assert.match(text, /– auggie — structural code search \(optional\)/);
  assert.match(text, /config: \/tmp\/providers\.json/);
});

test("an installable entry shows the command and any post-setup steps", () => {
  const report = buildDoctorReport(
    [requirement({ provider: "zoekt", check: "zoekt-webserver", manager: "go", postSetup: ["zoekt-webserver &", "zoekt-index <roots>"] })],
    deps({ binaries: [], managers: ["go"] }),
  );
  const text = formatDoctor(report, [], "v22.0.0");
  assert.match(text, /install: brew install ast-grep/);
  assert.match(text, /then: {4}zoekt-webserver &/);
  assert.match(text, /then: {4}zoekt-index <roots>/);
});

test("doctor CLI drains an asynchronous stdout before exiting", () => {
  const home = mkdtempSync(path.join(tmpdir(), "search-mcp-doctor-drain-"));
  const entry = new URL("../dist/server.js", import.meta.url).href;
  const code = `
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => { setTimeout(() => write(...args), 20); return false; };
    process.argv.push('--doctor');
    await import(${JSON.stringify(entry)});
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { HOME: home, PATH: "", XDG_CONFIG_HOME: path.join(home, ".config") },
      cwd: home, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^node /);
    assert.match(result.stdout, /fd —/);
    assert.match(result.stdout, /zoekt —/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------- candidate resolution (fd)
// The provider and the doctor share one candidate list; these tests pin it
// without depending on this machine's PATH or home directory.

test("candidates: fd falls back to the vendored copy, other binaries do not", () => {
  const home = "/tmp/example-home";
  assert.deepEqual(candidateCommands("fd", home), ["fd", path.join(home, ".pi", "agent", "bin", "fd")]);
  assert.deepEqual(candidateCommands("rg", home), ["rg"]);
  assert.deepEqual(candidateCommands("brew", home), ["brew"]);
});

test("candidates: resolution accepts a PATH hit, a vendored-only hit, and reports absence", () => {
  const home = "/tmp/example-home";
  const vendored = path.join(home, ".pi", "agent", "bin", "fd");
  const onPath = (command) => (command === "fd" ? "/usr/local/bin/fd" : null);
  const onlyVendored = (command) => (command === vendored ? vendored : null);

  assert.equal(resolveCandidate("fd", { home, lookup: onPath }), "/usr/local/bin/fd");
  assert.equal(resolveCandidate("fd", { home, lookup: onlyVendored }), vendored, "the vendored copy alone satisfies the fd requirement");
  assert.equal(resolveCandidate("fd", { home, lookup: () => null }), null);
  assert.equal(resolveCandidate("rg", { home, lookup: onlyVendored }), null, "nothing else may resolve through fd's vendored copy");
});

test("candidates: an executable vendored copy is found through the real lookup (fd not on PATH)", () => {
  const home = mkdtempSync(path.join(tmpdir(), "search-mcp-vendored-"));
  const emptyPath = mkdtempSync(path.join(tmpdir(), "search-mcp-empty-path-"));
  const noFdHome = mkdtempSync(path.join(tmpdir(), "search-mcp-no-fd-"));
  try {
    const bin = path.join(home, ".pi", "agent", "bin");
    mkdirSync(bin, { recursive: true });
    const vendoredFd = path.join(bin, "fd");
    writeFileSync(vendoredFd, "#!/bin/sh\nexit 0\n");
    chmodSync(vendoredFd, 0o755);

    const previous = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      assert.equal(resolveCandidate("fd", { home }), vendoredFd);
      assert.equal(resolveCandidate("fd", { home: noFdHome }), null, "genuinely absent stays absent");
    } finally {
      process.env.PATH = previous;
    }
  } finally {
    for (const dir of [home, emptyPath, noFdHome]) rmSync(dir, { recursive: true, force: true });
  }
});

test("provider: a broken fd on PATH falls through to the vendored copy, absence is honest", async () => {
  const brokenPath = mkdtempSync(path.join(tmpdir(), "search-mcp-broken-fd-"));
  const home = mkdtempSync(path.join(tmpdir(), "search-mcp-vendored-fd-"));
  const noFdHome = mkdtempSync(path.join(tmpdir(), "search-mcp-no-fd-"));
  const emptyPath = mkdtempSync(path.join(tmpdir(), "search-mcp-empty-path-"));
  try {
    const bin = path.join(home, ".pi", "agent", "bin");
    mkdirSync(bin, { recursive: true });
    const vendoredFd = path.join(bin, "fd");
    writeFileSync(vendoredFd, "#!/bin/sh\nexit 0\n");
    chmodSync(vendoredFd, 0o755);
    // An fd that exists but fails --version must not shadow the vendored copy.
    const brokenFd = path.join(brokenPath, "fd");
    writeFileSync(brokenFd, "#!/bin/sh\nexit 1\n");
    chmodSync(brokenFd, 0o755);

    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    const restore = () => {
      process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    };

    // Genuinely absent first: the provider caches its first successful pick.
    process.env.PATH = emptyPath;
    process.env.HOME = noFdHome;
    const absent = await fdProvider.probe();
    assert.equal(absent.ok, false);
    assert.match(absent.reason ?? "", /fd not found/);

    // Then the fallback: broken on PATH, working vendored copy under HOME.
    process.env.PATH = brokenPath;
    process.env.HOME = home;
    try {
      const probe = await fdProvider.probe();
      assert.equal(probe.ok, true, "an existing-but-broken PATH fd must not shadow the vendored copy");
    } finally {
      restore();
    }
  } finally {
    for (const dir of [brokenPath, home, noFdHome, emptyPath]) rmSync(dir, { recursive: true, force: true });
  }
});
