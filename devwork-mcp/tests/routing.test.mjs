/**
 * Routing plus scope. Routing says where a reference points; scope decides
 * whether this installation may touch it. The second half of the test file is
 * the authorization boundary: nothing outside the allowlist may be routed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRef, unroutableMessage } from "../dist/route.js";
import { backendEnabled, checkRepo, checkTarget, defaultAdoProject, defaultGithubRepo, describeScope } from "../dist/scope.js";

const table = { defaultBackend: "ado", jira: { projects: ["ABC"] } };

function installation(overrides = {}) {
  return {
    id: "example-service",
    source: "/tmp/profile.json",
    defaultBackend: "ado",
    github: { apiBase: "https://api.github.com", repositories: ["acme/service-x"], auth: "token", ...overrides.github },
    jira: { domain: "https://example.atlassian.net", email: "dev@example.com", token: "env:JIRA", projects: ["ABC"], auth: "token", ...overrides.jira },
    ado: { org: "https://dev.azure.com/acme", project: "Service X", projects: ["Service X"], requestTimeoutMs: 30_000, auth: "token", ...overrides.ado },
    write: { policy: "read-only", requirePreview: true },
    cacheTtlSeconds: 60,
    top: 20,
  };
}

test("a bare number routes to the default backend", () => {
  assert.deepEqual(parseRef("174253", table), { backend: "ado", kind: "item", id: "174253" });
  assert.deepEqual(parseRef(" 120300 ", table, "pr"), { backend: "ado", kind: "pr", id: "120300" });
});

test("Jira keys route only for projects this installation knows", () => {
  assert.deepEqual(parseRef("ABC-42", table), { backend: "jira", kind: "item", id: "ABC-42", key: "ABC-42" });
  assert.equal(parseRef("OTHER-42", table), null, "an unknown project is not silently routed");
  const wildcard = { ...table, jira: { projects: [] } };
  assert.equal(parseRef("OTHER-42", wildcard)?.backend, "jira", "an empty table keeps the old any-key behaviour at the routing layer; scope still refuses it");
});

test("GitHub references keep the repository", () => {
  assert.deepEqual(parseRef("acme/service-x#7", table), { backend: "github", kind: "item", id: "7", repo: "acme/service-x" });
  assert.deepEqual(parseRef("https://github.com/acme/service-x/pull/42", table), {
    backend: "github",
    kind: "pr",
    id: "42",
    repo: "acme/service-x",
    host: "github.com",
  });
});

test("ADO URLs keep host, organization and project", () => {
  const item = parseRef("https://dev.azure.com/acme/Other%20Project/_workitems/edit/123", table);
  assert.equal(item.backend, "ado");
  assert.equal(item.kind, "item");
  assert.equal(item.id, "123");
  assert.equal(item.org, "acme");
  assert.equal(item.project, "Other Project");
  assert.equal(item.host, "dev.azure.com");

  const pr = parseRef("https://dev.azure.com/acme/Service%20X/_git/repo/_git/repo/pullrequest/9", table);
  assert.equal(pr, null, "a double _git segment is not a pull request URL");

  const goodPr = parseRef("https://dev.azure.com/acme/Service%20X/_git/repo/pullrequest/9", table);
  assert.equal(goodPr.kind, "pr");
  assert.equal(goodPr.project, "Service X");
});

test("Jira browse URLs keep the host", () => {
  assert.deepEqual(parseRef("https://example.atlassian.net/browse/ABC-9", table), {
    backend: "jira",
    kind: "item",
    id: "ABC-9",
    key: "ABC-9",
    host: "example.atlassian.net",
  });
});

test("unknown shapes are refused with an explanatory message", () => {
  assert.equal(parseRef("not a reference", table), null);
  assert.match(unroutableMessage("nonsense", table), /cannot route "nonsense"/);
  assert.match(unroutableMessage("nonsense", table), /Jira projects routed here: ABC/);
});

test("a repository outside the allowlist is refused", () => {
  const inst = installation();
  assert.equal(checkRepo(inst, "acme/service-x").ok, true);
  assert.equal(checkRepo(inst, "ACME/Service-X").ok, true, "case-insensitive");
  const denied = checkRepo(inst, "other/repo");
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /outside this installation's scope — allowed: acme\/service-x/);
});

test("an empty repository allowlist denies everything", () => {
  const inst = installation({ github: { repositories: [] } });
  assert.match(checkRepo(inst, "acme/service-x").reason, /may not touch any GitHub repository/);
});

test("a GitHub URL for another repository is refused before any request", () => {
  const decision = checkTarget(installation(), parseRef("https://github.com/other/repo/issues/1", table));
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /outside this installation's scope/);
});

test("a GitHub Enterprise host must match apiBase", () => {
  const inst = installation({ github: { apiBase: "https://github.example.com/api/v3", repositories: ["acme/service-x"] } });
  const decision = checkTarget(inst, { backend: "github", kind: "item", id: "1", repo: "acme/service-x", host: "github.com" });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /does not serve this installation/);
});

test("ADO organization, project and host are all checked", () => {
  const inst = installation();
  assert.equal(checkTarget(inst, { backend: "ado", kind: "item", id: "1", org: "acme", project: "Service X", host: "dev.azure.com" }).ok, true);
  assert.match(checkTarget(inst, { backend: "ado", kind: "item", id: "1", org: "other", project: "Service X" }).reason, /organization "other" is outside/);
  assert.match(checkTarget(inst, { backend: "ado", kind: "item", id: "1", project: "Secret Project" }).reason, /outside this installation's scope/);
  assert.match(checkTarget(inst, { backend: "ado", kind: "item", id: "1", host: "dev.azure.com.evil.example", project: "Service X" }).reason, /outside this installation/);
});

test("Jira host and project are checked", () => {
  const inst = installation();
  assert.equal(checkTarget(inst, { backend: "jira", kind: "item", id: "ABC-1", key: "ABC-1", host: "example.atlassian.net" }).ok, true);
  assert.match(checkTarget(inst, { backend: "jira", kind: "item", id: "ABC-1", key: "ABC-1", host: "other.atlassian.net" }).reason, /outside this installation/);
  assert.match(checkTarget(inst, { backend: "jira", kind: "item", id: "XYZ-1", key: "XYZ-1" }).reason, /Jira project "XYZ" is outside/);
});

test("a disabled backend is refused even inside the allowlist", () => {
  const inst = installation({ ado: { auth: "off" } });
  assert.match(backendEnabled(inst, "ado").reason, /disabled in this installation/);
  assert.match(checkTarget(inst, { backend: "ado", kind: "item", id: "1" }).reason, /disabled/);
});

test("defaults only ever point inside the allowlist", () => {
  const single = installation({ github: { repositories: ["acme/service-x"] } });
  assert.equal(defaultGithubRepo(single), "acme/service-x");
  const multiple = installation({ github: { repositories: ["acme/a", "acme/b"] } });
  assert.equal(defaultGithubRepo(multiple), undefined, "two repositories need an explicit reference");
  assert.equal(defaultAdoProject(installation()), "Service X");
});

test("the scope description lists what is allowed", () => {
  const lines = describeScope(installation()).join("\n");
  assert.match(lines, /github: acme\/service-x/);
  assert.match(lines, /jira: +https:\/\/example\.atlassian\.net · projects ABC/);
  assert.match(lines, /ado: +https:\/\/dev\.azure\.com\/acme · projects Service X/);
});

test("a URL cannot impersonate a GitHub host", () => {
  assert.equal(parseRef("https://evil.example/github.com/acme/service-x/issues/1", table), null);
  assert.equal(parseRef("https://evil.example/github.com/acme/service-x/pull/1", table), null);
  const canonical = parseRef("https://www.github.com/acme/service-x/pull/5", table);
  assert.equal(canonical.host, "github.com", "www is normalised so the host check stays meaningful");
});

test("an ADO URL from an unknown host is routed but not authorized", () => {
  const foreign = parseRef("https://tfs.example.com/Other/Secret/_workitems/edit/7", table);
  assert.equal(foreign.backend, "ado");
  assert.equal(foreign.host, "tfs.example.com");
  const decision = checkTarget(installation(), foreign);
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /outside this installation/);
});
