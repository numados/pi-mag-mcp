/**
 * Doctor policy: the verdict rules and the text a user acts on. The requirement
 * table is read from requirements.json (the single owner), and binary/manager
 * lookups are injected so the test does not depend on this machine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDoctorReport, judgeRequirement } from "../dist/doctor.js";
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
