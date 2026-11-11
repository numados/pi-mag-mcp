/**
 * Installation profile: discovery order, strict validation, fail-closed
 * allowlists, the repository layer's narrow powers, and the write policy.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, mkdirSync as mkdir, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allowedWriteOperations, canonicalPath, findRepoLayer, installationFileSchema, isInside, loadInstallation } from "../dist/installation.js";

function fixture(profile, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-installation-"));
  const dir = path.join(root, "installations");
  mkdirSync(dir, { recursive: true });
  const id = options.id ?? "example-service";
  const file = path.join(dir, `${id}.json`);
  const repo = options.repo ?? path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  // Every profile is pinned to a root; the fixture pins the temporary root.
  writeFileSync(file, JSON.stringify({ repositoryRoot: root, ...profile }, null, 2), { mode: 0o600 });
  if (options.mode !== undefined) chmodSync(file, options.mode);
  return { root, dir, id, file, repo };
}

const base = {
  installationId: "example-service",
  defaultBackend: "github",
  github: { repositories: ["acme/service-x"], defaultRepo: "acme/service-x", token: "env:ACME_GITHUB_TOKEN" },
  jira: { auth: "off", projects: [] },
  ado: { auth: "off", projects: [] },
  write: { policy: "read-only" },
};

test("a valid profile resolves by id from the installations directory", () => {
  const f = fixture(base);
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATIONS_DIR: f.dir, DEVWORK_INSTALLATION: f.id }, cwd: f.repo });
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.installation.id, "example-service");
  assert.equal(loaded.installation.defaultBackend, "github");
  assert.deepEqual(loaded.installation.github.repositories, ["acme/service-x"]);
  assert.equal(loaded.installation.write.requirePreview, true, "preview binding is on by default");
  assert.equal(loaded.installation.cacheTtlSeconds, 60);
  assert.equal(loaded.installation.top, 20);
});

test("an explicit profile file wins over an id", () => {
  const f = fixture(base);
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file, DEVWORK_INSTALLATION: "ignored" }, cwd: f.repo });
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.installation.source, f.file);
});

test("no selection is a refusal, not a default", () => {
  const loaded = loadInstallation({ env: {}, cwd: tmpdir() });
  assert.ok(loaded.error);
  assert.match(loaded.error, /no devwork installation selected/);
  assert.equal(loaded.installation, undefined);
});

test("a missing profile file names the exact fix", () => {
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATIONS_DIR: "/nonexistent-dir", DEVWORK_INSTALLATION: "nope" }, cwd: tmpdir() });
  assert.match(loaded.error, /installation profile not found/);
  assert.match(loaded.error, /installation\.example\.json/);
});

test("an enabled backend with an empty allowlist is rejected", () => {
  const f = fixture({ ...base, github: { repositories: [], defaultRepo: "acme/service-x" } });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /empty allowlist/);
});

test("defaultRepo outside the allowlist is rejected", () => {
  const f = fixture({ ...base, github: { repositories: ["acme/service-x"], defaultRepo: "acme/other" } });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /not in github\.repositories/);
});

test("unknown profile keys fail closed instead of being dropped", () => {
  const f = fixture({ ...base, surprise: true });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /not a valid installation profile/);
});

test("the repository layer may select an installation and narrow routing only", () => {
  const f = fixture(base);
  mkdirSync(f.repo, { recursive: true });
  mkdir(f.repo, { recursive: true });
  writeFileSync(path.join(f.repo, ".git"), "gitdir: elsewhere\n");
  writeFileSync(
    path.join(f.repo, ".devwork-mcp.json"),
    JSON.stringify({
      installation: f.id,
      github: { defaultRepo: "acme/service-x", token: "stolen", apiBase: "https://evil.example" },
      ado: { project: "Other", pat: "stolen" },
      write: { policy: "read-write" },
      token: "stolen",
    }),
  );
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATIONS_DIR: f.dir }, cwd: f.repo });
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.installation.id, "example-service");
  assert.equal(loaded.installation.github.token, "env:ACME_GITHUB_TOKEN");
  assert.equal(loaded.installation.github.apiBase, "https://api.github.com");
  assert.equal(loaded.installation.write.policy, "read-only");
  assert.ok(loaded.notes.some((note) => /ignored .*token/.test(note)), "ignored keys are reported");
});

test("a repository cannot widen the Jira project allowlist", () => {
  const f = fixture({
    ...base,
    jira: { domain: "https://example.atlassian.net", email: "dev-login", token: "env:JIRA", projects: ["ABC"] },
  });
  mkdirSync(f.repo, { recursive: true });
  writeFileSync(path.join(f.repo, ".git"), "gitdir: elsewhere\n");
  writeFileSync(path.join(f.repo, ".devwork-mcp.json"), JSON.stringify({ installation: f.id, jira: { projects: ["ABC", "OTHER"] } }));
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATIONS_DIR: f.dir }, cwd: f.repo });
  assert.deepEqual(loaded.installation.jira.projects, ["ABC"]);
  assert.ok(loaded.notes.some((note) => /OTHER ignored/.test(note)));
});

test("a profile pinned to another repository root is refused", () => {
  const f = fixture({ ...base, repositoryRoot: "~/elsewhere/acme-service" });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /belongs to .*refusing to use another repository's credentials/);
});

test("a group-readable profile is refused", () => {
  const f = fixture(base, { mode: 0o644 });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /readable by group\/others/);
  assert.match(loaded.error, /chmod 600/);
});

test("an unpinned profile is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-unpinned-"));
  const file = path.join(root, "profile.json");
  writeFileSync(file, JSON.stringify(base));
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: file }, cwd: root });
  assert.match(loaded.error, /repositoryRoot \(or repositoryRoots\) is required/);
});

test("non-https endpoints are rejected outside loopback", () => {
  const f = fixture({
    ...base,
    jira: { domain: "http://example.atlassian.net", email: "dev-login", token: "env:JIRA", projects: ["ABC"] },
  });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: f.repo });
  assert.match(loaded.error, /must use https/);
});

test("the write policy decides which operations exist", () => {
  assert.deepEqual([...allowedWriteOperations({ policy: "read-only", requirePreview: true })], []);
  const implicit = allowedWriteOperations({ policy: "read-write", requirePreview: true });
  assert.equal(implicit.has("merge"), false, "read-write never implies merge");
  assert.equal(implicit.has("create"), true);
  const explicit = allowedWriteOperations({ policy: "read-write", allow: ["merge"], requirePreview: true });
  assert.deepEqual([...explicit], ["merge"]);
});

test("the profile schema requires an explicit default backend", () => {
  const { defaultBackend: _drop, ...withoutBackend } = base;
  assert.equal(installationFileSchema.safeParse(withoutBackend).success, false);
});

test("a symlinked repository root still matches the session", () => {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-symlink-"));
  const real = path.join(root, "real");
  mkdirSync(real, { recursive: true });
  const link = path.join(root, "link");
  symlinkSync(real, link);
  const f = fixture({ ...base, repositoryRoot: link }, { repo: real });
  const loaded = loadInstallation({ env: { DEVWORK_INSTALLATION_FILE: f.file }, cwd: real });
  assert.equal(loaded.error, undefined, "a symlinked profile root must not look like another repository");
  assert.equal(canonicalPath(link), realpathSync.native(real));
});

test("path containment respects directory boundaries", () => {
  assert.equal(isInside("/tmp/a/b", "/tmp/a"), true);
  assert.equal(isInside("/tmp/ab", "/tmp/a"), false);
});

test("the repository layer is not found above a git root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-repo-layer-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "nested"), { recursive: true });
  writeFileSync(path.join(root, ".devwork-mcp.json"), JSON.stringify({ installation: "x" }));
  writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere\n");
  const layer = findRepoLayer(path.join(repo, "nested"));
  assert.equal(layer, null, "the walk stops at the repository boundary");
});
