/**
 * Provider logic that encodes invariants: normalization of each backend's
 * payload, the ADO "Done has no RemainingWork" rule, WIQL/JQL construction with
 * the installation scope baked in, and vote mapping. Pure functions only — no
 * network, no credentials.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AdoClient, buildCreatePatch, buildWiql, normalizeItem, normalizePr as normalizeAdoPr, sanitizeDoneUpdate } from "../dist/ado.js";
import { GithubClient, buildSearchQuery, normalizeIssue as normalizeGithubIssue, normalizePr as normalizeGithubPr, onlyAllowedRepos } from "../dist/github.js";
import { adfToPlain, buildJql, normalizeIssue as normalizeJiraIssue, plainToAdf } from "../dist/jira.js";
import { cacheGet, cachePut, clearCache, invalidate } from "../dist/cache.js";
import { redact, safeBody } from "../dist/redact.js";

const ado = { org: "https://dev.azure.com/acme", project: "Service X", projects: ["Service X"], requestTimeoutMs: 30_000, auth: "token" };

test("ADO items normalize fields, identity and hours", () => {
  const item = normalizeItem(
    {
      id: 42,
      rev: 7,
      fields: {
        "System.WorkItemType": "Task",
        "System.Title": "Implement login",
        "System.State": "In Progress",
        "System.AssignedTo": { displayName: "Ada", uniqueName: "ada-login" },
        "System.Tags": "backend; ui ;",
        "Microsoft.VSTS.Scheduling.RemainingWork": 8,
        "Microsoft.VSTS.Scheduling.CompletedWork": 2,
        "System.Description": "<p>text</p>",
      },
    },
    ado,
    "Service X",
  );
  assert.equal(item.id, "42");
  assert.equal(item.backend, "ado");
  assert.equal(item.type, "Task");
  assert.equal(item.state, "In Progress");
  assert.equal(item.assignedTo, "ada-login", "uniqueName wins over displayName");
  assert.deepEqual(item.tags, ["backend", "ui"]);
  assert.equal(item.remaining, "8");
  assert.equal(item.completed, "2");
  assert.equal(item.rev, 7);
  assert.equal(item.url, "https://dev.azure.com/acme/Service%20X/_workitems/edit/42");
});

test("ADO Done updates never carry RemainingWork", () => {
  const sanitized = sanitizeDoneUpdate({
    id: "42",
    state: "Done",
    fields: {
      "Microsoft.VSTS.Scheduling.RemainingWork": "8",
      "Microsoft.VSTS.Scheduling.CompletedWork": "8",
    },
  });
  assert.deepEqual(sanitized.fields, { "Microsoft.VSTS.Scheduling.CompletedWork": "8" });

  const other = sanitizeDoneUpdate({ id: "42", state: "Active", fields: { "Microsoft.VSTS.Scheduling.RemainingWork": "3" } });
  assert.deepEqual(other.fields, { "Microsoft.VSTS.Scheduling.RemainingWork": "3" }, "only Done is sanitized");
});

test("WIQL is built from structured filters and escapes quotes", () => {
  const wiql = buildWiql({ type: "Bug", state: "Active", assignedTo: "O'Brien", contains: "it's", changedWithinDays: 7, top: 5 });
  assert.match(wiql, /^SELECT \[System\.Id\] FROM WorkItems WHERE/);
  assert.match(wiql, /\[System\.WorkItemType\] = 'Bug'/);
  assert.match(wiql, /\[System\.AssignedTo\] = 'O''Brien'/);
  assert.match(wiql, /\[System\.Title\] CONTAINS 'it''s'/);
  assert.match(wiql, /ORDER BY \[System\.ChangedDate\] DESC$/);
  assert.match(buildWiql({ assignedTo: "me" }), /\[System\.AssignedTo\] = @me/);
  assert.match(buildWiql({}), /FROM WorkItems ORDER BY/);
});

test("ADO pull requests normalize status, votes and the head commit", () => {
  const pr = normalizeAdoPr(
    {
      pullRequestId: 9,
      title: "Add login",
      status: "active",
      isDraft: true,
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      createdBy: { displayName: "Ada" },
      repository: { name: "service-x", webUrl: "https://dev.azure.com/acme/Service%20X/_git/service-x" },
      reviewers: [
        { displayName: "Bob", vote: 10, isRequired: true },
        { displayName: "Cy", vote: -10 },
        { displayName: "Di", vote: 0 },
      ],
      lastMergeSourceCommit: { commitId: "abc123" },
    },
    ado,
    "Service X",
  );
  assert.equal(pr.id, "9");
  assert.equal(pr.status, "active");
  assert.equal(pr.isDraft, true);
  assert.equal(pr.repository, "service-x");
  assert.equal(pr.headSha, "abc123", "the head commit is kept so a stale merge can be detected");
  assert.deepEqual(
    pr.reviewers.map((reviewer) => reviewer.vote),
    ["approve", "reject", "no-vote"],
  );
  assert.equal(pr.reviewers[0].required, true);
});

test("GitHub issues and PRs share a number space but normalize differently", () => {
  const issue = normalizeGithubIssue({
    number: 12,
    title: "Bug",
    state: "open",
    html_url: "https://github.com/acme/service-x/issues/12",
    labels: ["bug", { name: "backend" }],
    assignees: [{ login: "ada" }],
    body: "text",
    comments: 3,
  });
  assert.equal(issue.type, "Issue");
  assert.deepEqual(issue.tags, ["bug", "backend"]);
  assert.equal(issue.assignedTo, "ada");
  assert.equal(issue.area, "acme/service-x");

  const pr = normalizeGithubPr({
    number: 7,
    state: "closed",
    merged: true,
    draft: false,
    head: { ref: "feature", sha: "deadbeef" },
    base: { ref: "main", repo: { full_name: "acme/service-x" } },
  });
  assert.equal(pr.status, "completed", "a merged closed PR is completed");
  assert.equal(pr.headSha, "deadbeef");
  assert.equal(pr.repository, "acme/service-x");
  assert.equal(normalizeGithubPr({ number: 8, state: "closed", merged: false }).status, "abandoned");
  assert.equal(normalizeGithubPr({ number: 9, state: "open" }).status, "active");
});

test("Jira documents round-trip and issues normalize", () => {
  assert.deepEqual(plainToAdf("one"), { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] });
  assert.equal(adfToPlain(plainToAdf("first\n\nsecond")).includes("second"), true);

  const issue = normalizeJiraIssue(
    {
      key: "ABC-5",
      fields: {
        summary: "Do the thing",
        status: { name: "In Progress" },
        issuetype: { name: "Story" },
        assignee: { displayName: "Ada" },
        priority: { name: "High" },
        labels: ["backend"],
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
        subtasks: [{ key: "ABC-6", fields: { issuetype: { name: "Sub-task" }, summary: "child", status: { name: "To Do" } } }],
      },
    },
    "https://example.atlassian.net",
  );
  assert.equal(issue.id, "ABC-5");
  assert.equal(issue.key, "ABC-5");
  assert.equal(issue.url, "https://example.atlassian.net/browse/ABC-5");
  assert.equal(issue.description, "body");
  assert.equal(issue.children.length, 1);
});

test("JQL carries the installation scope and escapes quotes", () => {
  const scoped = buildJql({ state: "Open", assignedTo: "me", contains: 'say "hi"' }, ["ABC", "XYZ"]);
  assert.match(scoped, /^project in \("ABC", "XYZ"\) AND /, "the scope is the first predicate");
  assert.match(scoped, /status = "Open"/);
  assert.match(scoped, /assignee = currentUser\(\)/);
  assert.match(scoped, /text ~ "say hi"/);
  assert.match(buildJql({}), /ORDER BY updated DESC$/);
});

test("the read cache is partitioned by installation", () => {
  clearCache();
  cachePut("installation-a", "item:Service X:1", { title: "a" });
  assert.deepEqual(cacheGet("installation-a", "item:Service X:1", 60), { title: "a" });
  assert.equal(cacheGet("installation-b", "item:Service X:1", 60), undefined, "another installation cannot read it");
  invalidate("installation-a", "1");
  assert.equal(cacheGet("installation-a", "item:Service X:1", 60), undefined);
  cachePut("installation-a", "item:2", "x");
  assert.equal(cacheGet("installation-a", "item:2", 0), undefined, "ttl 0 disables caching");
  clearCache();
});

test("GitHub search filters cannot become query qualifiers", () => {
  const plain = buildSearchQuery({ contains: "login bug" }, "acme/service-x");
  assert.match(plain, /repo:acme\/service-x/);
  assert.match(plain, /"login bug"/, "free text is quoted as a phrase");

  const injected = buildSearchQuery({ contains: "x repo:other/repo org:other" }, "acme/service-x");
  const outsideQuotes = injected.replace(/"[^"]*"/g, "");
  assert.equal((outsideQuotes.match(/repo:/g) ?? []).length, 1, "exactly one live repo qualifier survives");
  assert.ok(!/org:/.test(outsideQuotes), "the injected org qualifier stays inside the phrase");
  assert.match(injected, /"x repo:other\/repo org:other"/, "the free text is preserved as a phrase, not dropped");

  const assignee = buildSearchQuery({ assignedTo: "a repo:other/other" }, "acme/service-x");
  assert.match(assignee, /assignee:arepootherother/, "the assignee is reduced to a login");
  assert.equal((assignee.match(/repo:/g) ?? []).length, 1, "only the query's own repo qualifier remains");

  assert.throws(() => buildSearchQuery({ state: "state" }, "acme/service-x"), /unsupported state filter/);
  assert.match(buildSearchQuery({ state: "open" }, "acme/service-x"), /state:open/);
  assert.match(buildSearchQuery({ state: "done" }, "acme/service-x"), /state:closed/);
});

test("GitHub search answers are filtered to the installation allowlist", () => {
  const items = [
    { backend: "github", id: "1", area: "acme/service-x" },
    { backend: "github", id: "2", area: "other/repo" },
    { backend: "github", id: "3" },
  ];
  assert.deepEqual(onlyAllowedRepos(items, ["acme/service-x"]).map((item) => item.id), ["1"]);
  assert.deepEqual(onlyAllowedRepos(items, ["ACME/Service-X"]).map((item) => item.id), ["1"], "case-insensitive");
});

test("a child Task is created with a hierarchy relation to its parent", () => {
  const patch = buildCreatePatch(
    { type: "Task", title: "Implement X", project: "Service X", parentId: "42" },
    ado,
  );
  const relation = patch.find((entry) => entry.path === "/relations/-");
  assert.ok(relation, "the parent relation is part of the create patch");
  assert.equal(relation.value.rel, "System.LinkTypes.Hierarchy-Reverse");
  assert.equal(
    relation.value.url,
    "https://dev.azure.com/acme/Service%20X/_apis/wit/workItems/42",
  );
  assert.equal(
    buildCreatePatch({ type: "Task", title: "standalone" }, ado).some((entry) => entry.path === "/relations/-"),
    false,
    "no relation is invented without a parent",
  );
});

test("a merge refuses to run without the previewed head SHA", async () => {
  const github = new GithubClient({ apiBase: "https://api.github.com", repositories: ["acme/service-x"], auth: "token" }, async () => "token");
  await assert.rejects(() => github.prUpdate({ repo: "acme/service-x", n: "7", status: "completed" }), /head SHA/);

  const adoClient = new AdoClient("example-service", ado, async () => ({ header: "Basic x", mode: "token", source: "test", notes: [] }));
  await assert.rejects(() => adoClient.prUpdate({ id: "7", status: "completed" }), /head commit/);
});

test("provider error text is redacted before it can reach a caller", () => {
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [redacted]");
  assert.equal(redact("failed with Basic YWxhZGRpbjpvcGVuc2VzYW1l"), "failed with Basic [redacted]");
  assert.equal(redact('{"token":"super-secret-value"}'), '{"token":"[redacted]"}');
  assert.equal(redact("the secret was hunter2hunter2", ["hunter2hunter2"]), "the secret was [redacted]");
  assert.equal(safeBody("x".repeat(600)).length, 400);
  assert.ok(!safeBody("leak: Bearer aaaaaaaaaaaaaaaa").includes("aaaaaaaaaaaaaaaa"));
});
