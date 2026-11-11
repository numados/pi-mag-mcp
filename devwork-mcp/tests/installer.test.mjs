/**
 * The project-scoped installer: `./install.sh devwork --local` writes one
 * private profile and one project registration, and leaves the user-level
 * mcp.json alone. `--skip-build` lets this test exercise the wiring without
 * recursively running the package tests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const installScript = path.join(root, "install.sh");

function run(args, env) {
  return execFileSync("bash", [installScript, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "devwork-installer-home-"));
  const repo = mkdtempSync(path.join(tmpdir(), "devwork-installer-repo-"));
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  const userConfig = path.join(home, ".pi", "agent", "mcp.json");
  writeFileSync(userConfig, JSON.stringify({ mcpServers: { existing: { command: "node", args: ["/tmp/other.js"] } } }, null, 2));
  return { home, repo, userConfig };
}

test("--local --dry-run writes nothing", () => {
  const f = fixture();
  const output = run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--dry-run"], { HOME: f.home });
  assert.match(output, /dry run — nothing is built, tested or written/);
  assert.equal(existsSync(path.join(f.repo, ".pi", "mcp.json")), false);
  assert.equal(existsSync(path.join(f.home, ".config", "devwork-mcp", "installations", "example-service.json")), false);
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});

test("--local registers the project entry and a private profile", () => {
  const f = fixture();
  const before = readFileSync(f.userConfig, "utf8");
  const output = run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--skip-build"], { HOME: f.home });

  const projectFile = path.join(f.repo, ".pi", "mcp.json");
  assert.equal(existsSync(projectFile), true, "the project registration is written");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  const entry = project.mcpServers.devwork;
  assert.ok(entry, "the devwork entry exists");
  assert.ok(entry.command.endsWith("node"), `the entry uses the node binary, got ${entry.command}`);
  assert.deepEqual(entry.env, { DEVWORK_INSTALLATION: "example-service" });
  assert.equal(entry.cwd, ".");
  assert.equal(entry.exposure, "codemode");
  assert.deepEqual(entry.toolExposure, { devwork_status: "direct", devwork_get: "direct", devwork_query: "direct" });
  assert.ok(entry.args[0].endsWith("devwork-mcp/dist/server.js"), "the entry points at this package's build");
  assert.equal(statSync(projectFile).mode & 0o077, 0, "the registration is private");

  const profilePath = path.join(f.home, ".config", "devwork-mcp", "installations", "example-service.json");
  assert.equal(existsSync(profilePath), true, "the profile lives outside the repository");
  assert.equal(statSync(profilePath).mode & 0o077, 0, "the profile is mode 600");
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.equal(profile.installationId, "example-service");
  assert.equal(realpathSync(profile.repositoryRoot), realpathSync(f.repo), "the profile pins the canonical repository root");
  assert.match(profile.github.token, /^env:/);

  assert.equal(readFileSync(f.userConfig, "utf8"), before, "the user-level mcp.json is never touched");
  assert.match(output, /registered for/);
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});

test("an existing profile and unrelated project entries survive a re-run", () => {
  const f = fixture();
  run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--skip-build"], { HOME: f.home });

  const profilePath = path.join(f.home, ".config", "devwork-mcp", "installations", "example-service.json");
  writeFileSync(profilePath, JSON.stringify({ installationId: "example-service", defaultBackend: "github", write: { policy: "read-only" } }));
  chmodSync(profilePath, 0o600);
  const projectFile = path.join(f.repo, ".pi", "mcp.json");
  const withOther = JSON.parse(readFileSync(projectFile, "utf8"));
  withOther.mcpServers.other = { command: "node", args: ["/tmp/other-project.js"] };
  writeFileSync(projectFile, JSON.stringify(withOther, null, 2));

  run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--skip-build"], { HOME: f.home });
  const after = JSON.parse(readFileSync(projectFile, "utf8"));
  assert.ok(after.mcpServers.other, "an unrelated project entry is preserved");
  assert.ok(after.mcpServers.devwork, "the devwork entry is rewritten in place");
  assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).write.policy, "read-only", "an existing profile is left alone");
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});

test("a user-level registration is refused with the local command", () => {
  const f = fixture();
  assert.throws(
    () => run(["devwork", "--dry-run"], { HOME: f.home }),
    /installation-scoped: run \.\/install\.sh devwork --local/,
  );
  const buildOnly = run(["devwork", "--no-pi", "--dry-run"], { HOME: f.home });
  assert.match(buildOnly, /would skip registration/);
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});

test("--local refuses a missing repository or installation id", () => {
  const f = fixture();
  assert.throws(() => run(["devwork", "--local", "--installation", "x", "--skip-build"], { HOME: f.home }), /--repo/);
  assert.throws(() => run(["devwork", "--local", "--repo", f.repo, "--skip-build"], { HOME: f.home }), /--installation/);
  assert.throws(() => run(["devwork", "--local", "--repo", path.join(f.repo, "missing"), "--installation", "x"], { HOME: f.home }), /no such directory/);
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});

test("an existing profile with loose permissions is called out", () => {
  const f = fixture();
  run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--skip-build"], { HOME: f.home });
  const profilePath = path.join(f.home, ".config", "devwork-mcp", "installations", "example-service.json");
  chmodSync(profilePath, 0o644);
  const output = run(["devwork", "--local", "--repo", f.repo, "--installation", "example-service", "--skip-build"], { HOME: f.home });
  assert.match(output, /WARNING: mode is 644/);
  assert.match(output, /chmod 600/);
  rmSync(f.home, { recursive: true, force: true });
  rmSync(f.repo, { recursive: true, force: true });
});
