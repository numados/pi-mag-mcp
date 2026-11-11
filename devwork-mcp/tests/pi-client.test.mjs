/**
 * Compatibility smoke test against the installed Pi MCP client.
 *
 * The child process gets an allowlisted environment, a temporary HOME and a
 * temporary installation profile, so no real token, `gh` login or `az` login on
 * this machine is read.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist", "server.js");

const EXPECTED_TOOLS = [
  "devwork_create",
  "devwork_get",
  "devwork_pbi_status",
  "devwork_pr_create",
  "devwork_pr_list",
  "devwork_pr_show",
  "devwork_pr_update",
  "devwork_pr_vote",
  "devwork_query",
  "devwork_repos",
  "devwork_status",
  "devwork_task_create",
  "devwork_task_done",
  "devwork_update",
];

const SECRET = "pi-client-secret-value";

function findPiMcpRoot() {
  const explicit = process.env.PI_MCP_ROOT;
  const candidates = [
    ...(explicit ? [explicit] : []),
    path.resolve(
      process.execPath,
      "..",
      "..",
      "lib",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@earendil-works",
      "pi-mcp",
    ),
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

/** One installation profile plus a repository directory, both temporary. */
function fixture({ withProfile = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devwork-pi-client-"));
  const repo = path.join(root, "repo");
  // the profile must be pinned to this repository root
  const installations = path.join(root, "installations");
  mkdirSync(repo, { recursive: true });
  mkdirSync(installations, { recursive: true });
  writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere\n");
  const profilePath = path.join(installations, "example-service.json");
  if (withProfile) {
    writeFileSync(
      profilePath,
      JSON.stringify({
        installationId: "example-service",
        repositoryRoot: repo,
        defaultBackend: "github",
        github: { repositories: ["acme/service-x"], defaultRepo: "acme/service-x", token: "env:DEVWORK_TEST_GITHUB_TOKEN" },
        jira: { auth: "off" },
        ado: { auth: "off" },
        write: { policy: "read-write", allow: ["create", "pr"], requirePreview: true },
      }),
      { mode: 0o600 },
    );
  }
  return { root, repo, installations, profilePath };
}

async function withServer(t, run, options = {}) {
  const pi = await loadPiClient();
  if (!pi) {
    t.skip("Pi MCP client not found; set PI_MCP_ROOT to run the compatibility smoke test");
    return;
  }
  const f = fixture(options);
  const home = mkdtempSync(path.join(tmpdir(), "devwork-pi-client-home-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ...(options.withProfile === false ? {} : { DEVWORK_INSTALLATION_FILE: f.profilePath }),
    DEVWORK_TEST_GITHUB_TOKEN: SECRET,
  };
  const { McpClient, StdioTransport } = pi;
  const transport = new StdioTransport({
    command: process.execPath,
    args: [serverEntry],
    inheritEnv: false,
    env,
    cwd: f.repo,
    stderr: "pipe",
  });
  const client = new McpClient({ name: "devwork-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await run({ client, fixture: f });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
}

test("the Pi client negotiates with the devwork server", async (t) => {
  await withServer(t, async ({ client }) => {
    assert.equal(client.protocolVersion, "2025-11-25", "Pi's revision is still served");
    assert.equal(client.serverInfo?.name, "devwork");
    assert.ok(client.instructions && client.instructions.length > 0);
  });
});

test("tools/list advertises the fourteen tools with read-only annotations", async (t) => {
  await withServer(t, async ({ client }) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    const status = tools.find((tool) => tool.name === "devwork_status");
    assert.equal(status.annotations?.readOnlyHint, true);
    assert.equal(status.outputSchema?.type, "object");
    const create = tools.find((tool) => tool.name === "devwork_create");
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.ok(create.description.includes("approvalToken"), "the preview contract is discoverable");
  });
});

test("devwork_status reports the installation without leaking the token", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("devwork_status", {});
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /installation: example-service/);
    assert.match(text, /github: ✓/);
    assert.match(text, /writes: create, pr/);
    assert.ok(!text.includes(SECRET), "the resolved token never reaches the answer");
    assert.ok(!JSON.stringify(result.structuredContent).includes(SECRET));
  });
});

test("a reference outside the installation scope is refused", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("devwork_get", { ref: "https://github.com/other/repo/issues/1" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside this installation's scope/);
    assert.match(result.content[0].text, /allowed: acme\/service-x/);
  });
});

test("a write without a preview is refused", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("devwork_pr_update", { ref: "https://github.com/acme/service-x/pull/7", status: "active", confirm: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no matching preview/);
  });
});

test("a preview is delivered and never executes", async (t) => {
  await withServer(t, async ({ client }) => {
    const result = await client.callTool("devwork_create", { type: "Issue", title: "Example", project: "acme/service-x" });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent;
    assert.equal(structured.requiresConfirmation, true);
    assert.match(structured.approvalToken, /^[0-9a-f-]{36}$/);
    assert.equal(structured.preview.op, "create");
    assert.match(result.content[0].text, /PREVIEW/);
  });
});

test("unknown arguments are rejected before any request", async (t) => {
  await withServer(t, async ({ client }) => {
    let failed = false;
    try {
      const result = await client.callTool("devwork_get", { ref: "1", surprise: true });
      failed = result.isError === true;
    } catch {
      failed = true;
    }
    assert.equal(failed, true, "strict input schemas reject unknown arguments");
  });
});

test("without an installation every tool refuses and explains the fix", async (t) => {
  await withServer(
    t,
    async ({ client }) => {
      const result = await client.callTool("devwork_get", { ref: "1" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no usable installation/);
      assert.match(result.content[0].text, /install\.sh devwork --local/);
    },
    { withProfile: false },
  );
});
