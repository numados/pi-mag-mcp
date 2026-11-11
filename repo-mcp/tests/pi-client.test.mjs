/** Compatibility smoke test against the installed Pi MCP client.
 *
 *  Port of the source stdio smoke test (agent-toolkit/mcp/repo-mcp at
 *  ca48d8d): the server boots, lists the exact tool surface (no push), serves
 *  real reads over the protocol, structurally refuses push-ish tool names, and
 *  enforces the approval contract over the wire.
 *
 *  The child process gets an isolated HOME and git config, and the fixture is
 *  built with git init/add/commit only — no real git config, hooks or remotes
 *  are ever read.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const EXPECTED_TOOLS = [
  "repo_status", "git_status", "git_log", "git_diff", "git_show", "git_branch_list",
  "git_blame", "git_default_branch", "git_refs", "git_fetch", "git_pull", "git_commit",
  "branch_create", "merge", "rebase", "reset", "restore", "switch", "destructive_local",
  "branch_plan", "commit_message",
];

const APPROVAL_NAMES = new Set(["branch_create", "merge", "rebase", "reset", "restore", "switch", "destructive_local"]);

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "repo-mcp-pi-client-"));
process.on("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const fakeHome = path.join(fixtureRoot, "home");
mkdirSync(fakeHome, { recursive: true });
writeFileSync(path.join(fakeHome, ".gitconfig"), "");
process.env.HOME = fakeHome;
process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(fakeHome, ".gitconfig");
process.env.GIT_AUTHOR_NAME = "repo-mcp-smoke";
process.env.GIT_AUTHOR_EMAIL = "smoke@localhost";
process.env.GIT_COMMITTER_NAME = "repo-mcp-smoke";
process.env.GIT_COMMITTER_EMAIL = "smoke@localhost";

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${r.stderr}`);
}

function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    path.resolve(process.execPath, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-mcp"),
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-mcp",
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "dist", "client.js")));
}

async function loadPiClient() {
  const root = findPiMcpRoot();
  if (!root) return null;
  const client = await import(path.join(root, "dist", "client.js"));
  const stdio = await import(path.join(root, "dist", "transports", "stdio.js"));
  return { McpClient: client.McpClient, StdioTransport: stdio.StdioTransport };
}

test("stdio server over the Pi client: list, read, generation, approval gate, structural refusal", async (t) => {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }

  const repo = path.join(fixtureRoot, "repo");
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-b", "master");
  writeFileSync(path.join(repo, "a.txt"), "smoke\n");
  sh(repo, "add", "a.txt");
  sh(repo, "commit", "-m", "add a.txt");

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: fakeHome,
    XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(fakeHome, ".gitconfig"),
    GIT_AUTHOR_NAME: "repo-mcp-smoke",
    GIT_AUTHOR_EMAIL: "smoke@localhost",
    GIT_COMMITTER_NAME: "repo-mcp-smoke",
    GIT_COMMITTER_EMAIL: "smoke@localhost",
  };

  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env,
    cwd: repo,
    stderr: "pipe",
  });
  const client = new McpClient({ name: "repo-mcp-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.map((x) => x.name);
    assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
    for (const n of names) {
      assert.ok(!/push|send[_-]?pack|exec/.test(n), `no push/exec-flavoured tool: ${n}`);
    }
    assert.ok(listed[0].outputSchema, "outputSchema must be declared");

    for (const tool of listed) {
      const properties = tool.inputSchema.properties ?? {};
      const required = tool.inputSchema.required ?? [];
      if (APPROVAL_NAMES.has(tool.name)) {
        assert.equal(properties.confirm?.type, "boolean", `${tool.name} declares confirm: boolean`);
        assert.equal(properties.token?.type, "string", `${tool.name} declares token: string`);
        assert.ok(!required.includes("confirm"), `${tool.name} preview does not require confirm`);
        assert.ok(!required.includes("token"), `${tool.name} preview does not require token`);
      } else {
        assert.ok(!Object.hasOwn(properties, "confirm"), `${tool.name} must not declare confirm`);
        assert.ok(!Object.hasOwn(properties, "token"), `${tool.name} must not declare token`);
      }
    }

    // real read over the wire (cwd = repo)
    const st = await client.callTool("git_status", {});
    assert.equal(st.isError, undefined);
    assert.match(st.content[0].text, /## master/);
    assert.equal(st.structuredContent.repo, realpathSync(repo));

    // generation over the wire
    const plan = await client.callTool("branch_plan", { tracker: "jira", type: "bugfix", ticket: "SMOKE-7", base: "master" });
    assert.equal(plan.isError, undefined);
    assert.equal(plan.structuredContent.branch, "bugfix/SMOKE-7");

    // ticketless generation must survive its own envelope (ticket is null on
    // the wire, not absent) — regression guard for output validation
    writeFileSync(path.join(repo, "b.txt"), "staged\n");
    sh(repo, "add", "b.txt");
    const drafted = await client.callTool("commit_message", { type: "feat", summary: "Add the smoke fixture" });
    assert.equal(drafted.isError, undefined, drafted.content[0].text);
    assert.equal(drafted.structuredContent.ok, true);
    assert.equal(drafted.structuredContent.ticket, null);
    assert.equal(drafted.structuredContent.ticketSource, "none");
    assert.match(drafted.structuredContent.message, /^feat: Add the smoke fixture/);

    // Both body formats accepted by the source must survive input validation.
    const bullets = ["Keep the supplied summary", "Accept both body formats"];
    for (const body of [bullets, bullets.join("\n")]) {
      const withBody = await client.callTool("commit_message", { type: "feat", summary: "Add the smoke fixture", body });
      assert.equal(withBody.isError, undefined, withBody.content[0].text);
      assert.equal(withBody.structuredContent.message, `feat: Add the smoke fixture\n\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}`);
    }
    sh(repo, "reset", "--hard", "HEAD");

    // the declared input contract is enforced before a handler runs
    const mistyped = await client.callTool("git_diff", { staged: "true" });
    assert.equal(mistyped.isError, true);
    assert.match(mistyped.content[0].text, /invalid arguments/);

    // approval tier over the wire: confirm without token is refused
    const noToken = await client.callTool("merge", { ref: "master", confirm: true });
    assert.equal(noToken.isError, true);
    assert.match(noToken.content[0].text, /requires the approval token/);

    // preview → confirm round-trip over the wire
    const prev = await client.callTool("switch", { branch: "master" });
    assert.equal(prev.isError, undefined);
    assert.equal(prev.structuredContent.requiresConfirmation, true);
    const token = prev.structuredContent.token;
    const done = await client.callTool("switch", { branch: "master", confirm: true, token });
    assert.equal(done.isError, undefined);
    assert.match(done.content[0].text, /executed \(approved\)/);

    // forbidden tier is structural: no such tool, and the refusal says why
    const pushy = await client.callTool("git_push", {});
    assert.equal(pushy.isError, true);
    assert.match(pushy.content[0].text, /refused — repo-mcp has no push\/send-pack or generic-exec tool/);

    const unknown = await client.callTool("definitely_not_a_tool", {});
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown tool/);

    // The updated server exempts large tests, not large production sources.
    writeFileSync(path.join(repo, "fixture.test.mjs"), "// fixture\n".repeat(3_000));
    sh(repo, "add", "fixture.test.mjs");
    const committedTest = await client.callTool("git_commit", { message: "test: add a large test fixture" });
    assert.equal(committedTest.isError, undefined, committedTest.content[0].text);
    assert.equal(committedTest.structuredContent.ok, true);
    const beforeBlocked = await client.callTool("git_log", { limit: 1 });
    writeFileSync(path.join(repo, "large-source.ts"), "x".repeat(20_001));
    sh(repo, "add", "large-source.ts");
    const blockedSource = await client.callTool("git_commit", { message: "feat: add a large source fixture" });
    assert.equal(blockedSource.isError, true);
    assert.match(blockedSource.content[0].text, /staged file-size policy violation/);
    const afterBlocked = await client.callTool("git_log", { limit: 1 });
    assert.equal(afterBlocked.structuredContent.output, beforeBlocked.structuredContent.output);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(repo, { recursive: true, force: true });
  }
});
