/**
 * Contract test: the advertised tool surface, its schemas and its annotations.
 * These assertions are the guard against silent drift — a consumer (skill,
 * agent instruction, codemode script) breaks when a name or a required field
 * changes, so the test names them explicitly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOLS,
  TOOL_NAMES,
  createInput,
  envelopeSchema,
  prUpdateInput,
  queryInput,
  toolByName,
} from "../dist/contract.js";
import { WRITE_OPERATIONS } from "../dist/types.js";
import { HANDLERS } from "../dist/tools/index.js";

const EXPECTED = [
  "devwork_status",
  "devwork_get",
  "devwork_query",
  "devwork_create",
  "devwork_update",
  "devwork_repos",
  "devwork_pr_show",
  "devwork_pr_list",
  "devwork_pr_create",
  "devwork_pr_update",
  "devwork_pr_vote",
  "devwork_task_create",
  "devwork_task_done",
  "devwork_pbi_status",
];

test("the tool list is exactly the fourteen documented tools", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED].sort());
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "no duplicate tool names");
});

test("every tool has a handler and every handler a tool", () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), [...EXPECTED].sort());
});

test("every tool carries a usable description and annotations", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 80, `${tool.name} needs a discoverable description`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(tool.annotations.openWorldHint, true, `${tool.name} talks to a remote tracker`);
    assert.equal(tool.annotations.readOnlyHint, tool.operation === "read", `${tool.name} read-only hint must match its operation`);
  }
});

test("write tools are gated by a known operation class", () => {
  const writes = TOOLS.filter((tool) => tool.operation !== "read");
  assert.deepEqual(writes.map((tool) => tool.name).sort(), [
    "devwork_create",
    "devwork_pr_create",
    "devwork_pr_update",
    "devwork_pr_vote",
    "devwork_task_create",
    "devwork_task_done",
    "devwork_update",
  ]);
  for (const tool of writes) {
    assert.ok(WRITE_OPERATIONS.includes(tool.operation), `${tool.name} names an unknown operation`);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
});

test("the merge-capable tool is marked destructive", () => {
  const update = toolByName("devwork_pr_update");
  assert.ok(update);
  assert.equal(update.annotations.destructiveHint, true);
  assert.equal(toolByName("devwork_pr_create").annotations.destructiveHint, false);
});

test("input schemas reject unknown arguments instead of ignoring them", () => {
  const result = createInput.safeParse({ type: "Task", title: "x", surprise: 1 });
  assert.equal(result.success, false);
  assert.equal(createInput.safeParse({ type: "Task", title: "x" }).success, true);
});

test("required fields and caps are declared", () => {
  assert.equal(queryInput.safeParse({}).success, true, "query has no required field");
  assert.equal(queryInput.safeParse({ top: 0 }).success, false);
  assert.equal(queryInput.safeParse({ top: 201 }).success, false);
  assert.equal(queryInput.safeParse({ top: 200 }).success, true);
  assert.equal(prUpdateInput.safeParse({ ref: "1", status: "merged" }).success, false);
  assert.equal(prUpdateInput.safeParse({ ref: "1", status: "completed" }).success, true);
});

test("the response envelope accepts a real answer and rejects one without ok", () => {
  const sample = {
    ok: true,
    installation: "example-service",
    scope: { github: ["acme/service"], jira: "off", ado: "off" },
    credentials: { github: { mode: "token", source: "installation token" } },
  };
  assert.equal(envelopeSchema.safeParse(sample).success, true, "extra fields survive a loose envelope");
  assert.equal(envelopeSchema.safeParse({ error: "x" }).success, false);
});

test("a preview answer fits the envelope", () => {
  const preview = {
    ok: true,
    requiresConfirmation: true,
    approvalToken: "00000000-0000-4000-8000-000000000000",
    approvalTtlSeconds: 600,
    preview: { op: "merge", backend: "github", id: "7" },
  };
  assert.equal(envelopeSchema.safeParse(preview).success, true);
});
