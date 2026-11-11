/**
 * Readiness report: no installation, a complete one, and the guarantee that no
 * secret value ever reaches the text or the structured answer.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { doctorReport, loadRequirements, probeBinaries } from "../dist/doctor.js";

const SECRET = "super-secret-token-value";

function fixture(profile) {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-doctor-"));
  const dir = path.join(root, "installations");
  mkdirSync(dir, { recursive: true });
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const file = path.join(dir, "example-service.json");
  writeFileSync(file, JSON.stringify({ repositoryRoot: root, ...profile }), { mode: 0o600 });
  return { root, dir, repo, file };
}

const failingRun = async (command) => {
  throw new Error(`${command} is not installed`);
};

const profile = {
  installationId: "example-service",
  defaultBackend: "github",
  github: { repositories: ["acme/service-x"], defaultRepo: "acme/service-x", token: "env:ACME_GITHUB_TOKEN" },
  jira: { auth: "off" },
  ado: { auth: "off" },
  write: { policy: "read-only" },
};

test("without an installation the report says exactly what to do", async () => {
  const report = await doctorReport({ env: {}, cwd: tmpdir(), deps: { run: failingRun } });
  assert.equal(report.structured.ok, false);
  assert.equal(report.structured.status, "no-installation");
  assert.match(report.text, /NO INSTALLATION/);
  assert.match(report.text, /install\.sh devwork --local/);
});

test("a configured installation reports scope, credential source and policy", async () => {
  const f = fixture(profile);
  const report = await doctorReport({
    env: { DEVWORK_INSTALLATION_FILE: f.file, ACME_GITHUB_TOKEN: SECRET },
    cwd: f.repo,
    deps: { run: failingRun },
  });
  assert.equal(report.structured.ok, true);
  assert.equal(report.structured.installation, "example-service");
  assert.deepEqual(report.structured.scope.github, ["acme/service-x"]);
  assert.equal(report.structured.scope.jira, "off");
  assert.equal(report.structured.credentials.github.mode, "token");
  assert.match(report.structured.credentials.github.source, /installation token/);
  assert.equal(report.structured.write.policy, "read-only");
  assert.deepEqual(report.structured.write.allow, []);
  assert.match(report.text, /writes: DISABLED/);
  assert.ok(!JSON.stringify(report).includes(SECRET), "the resolved secret must never be reported");
  assert.ok(!report.text.includes("ACME_GITHUB_TOKEN="), "no variable values are printed");
});

test("a missing credential is reported as a cause, not a crash", async () => {
  const f = fixture(profile);
  const report = await doctorReport({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo, deps: { run: failingRun } });
  assert.equal(report.structured.ok, true, "the installation is valid; only its credential is missing");
  assert.equal(report.structured.credentials.github.mode, "none");
  assert.match(report.text, /github: ✗/);
  assert.ok(report.structured.notes.some((note) => /ACME_GITHUB_TOKEN is unset/.test(note)));
});

test("machine requirements come from requirements.json", async () => {
  const requirements = loadRequirements();
  assert.deepEqual(requirements.map((entry) => entry.check), ["git", "gh", "az"]);
  assert.ok(requirements.every((entry) => entry.required === false), "no requirement is mandatory: installations carry their own credentials");

  const verdicts = await probeBinaries(requirements, async (command) => {
    if (command === "git") return "git version 2.0.0";
    throw new Error("missing");
  });
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.check, verdict.present]),
    [
      ["git", true],
      ["gh", false],
      ["az", false],
    ],
  );
});

test("only requirements this installation can use are reported", async () => {
  const f = fixture(profile);
  const isolated = await doctorReport({
    env: { DEVWORK_INSTALLATION_FILE: f.file, ACME_GITHUB_TOKEN: SECRET },
    cwd: f.repo,
    deps: { run: failingRun },
  });
  assert.doesNotMatch(isolated.text, /brew install gh/, "an installation token does not need the gh CLI");
  assert.doesNotMatch(isolated.text, /azure-cli/, "a disabled ADO backend does not need az");

  const ambient = fixture({ ...profile, github: { ...profile.github, auth: "ambient" } });
  const report = await doctorReport({
    env: { DEVWORK_INSTALLATION_FILE: ambient.file },
    cwd: ambient.repo,
    deps: { run: failingRun },
  });
  assert.match(report.text, /install: brew install gh/);
  assert.match(report.text, /used only when github\.auth is "ambient"/);
  assert.equal(report.structured.credentials.github.mode, "none", "no ambient login is reachable in this environment");
});
