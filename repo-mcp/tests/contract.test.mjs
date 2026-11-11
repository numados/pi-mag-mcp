/**
 * Contract test: the advertised tool surface, its tier membership and the
 * response envelope. These assertions are the guard against silent drift — a
 * consumer (skill, agent instruction, codemode script) breaks when a name, a
 * tier or the envelope changes, so the test names them explicitly.
 *
 * The tier boundary (D-R7) is the server's reason to exist: the approval tier
 * is exactly seven tools, none promoted to allowed, none demoted to forbidden,
 * and push/send-pack stays tool-less.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toJSONSchema } from "zod";
import {
  APPROVAL_TIER,
  FORBIDDEN_SHAPE,
  TOOL_NAMES,
  TOOLS,
  envelopeSchema,
  toolByName,
} from "../dist/contract.js";
import { toolDefs } from "../dist/tools.js";

const EXPECTED = [
  "repo_status", "git_status", "git_log", "git_diff", "git_show", "git_branch_list",
  "git_blame", "git_default_branch", "git_refs", "git_fetch", "git_pull", "git_commit",
  "branch_create", "merge", "rebase", "reset", "restore", "switch", "destructive_local",
  "branch_plan", "commit_message",
];

test("the tool list is exactly the 21 documented tools", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED].sort());
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, "no duplicate tool names");
});

test("no push/send-pack/remote-write/exec tool name exists at all", () => {
  for (const name of TOOL_NAMES) {
    assert.ok(!FORBIDDEN_SHAPE.test(name), `${name} must not be a push/exec-flavoured name`);
  }
});

test("tier membership matches the documented surface", () => {
  const byTier = (tier) => TOOLS.filter((t) => t.tier === tier).map((t) => t.name).sort();
  assert.deepEqual(byTier("read"), ["git_blame", "git_branch_list", "git_default_branch", "git_diff", "git_log", "git_refs", "git_show", "git_status"]);
  assert.deepEqual(byTier("allowed"), ["git_commit", "git_fetch", "git_pull"]);
  assert.deepEqual(byTier("doctor"), ["repo_status"]);
  assert.deepEqual(byTier("approval"), ["branch_create", "destructive_local", "merge", "rebase", "reset", "restore", "switch"]);
  assert.deepEqual(byTier("generation"), ["branch_plan", "commit_message"]);
});

test("the approval tier is exactly the source's seven tools (D-R7, unchanged)", () => {
  assert.deepEqual([...APPROVAL_TIER].sort(), ["branch_create", "destructive_local", "merge", "rebase", "reset", "restore", "switch"]);
  for (const name of APPROVAL_TIER) {
    assert.equal(toolByName(name).tier, "approval", `${name} is approval-gated, not promoted to allowed`);
  }
  // None demoted to forbidden: every approval tool still exists.
  for (const name of APPROVAL_TIER) {
    assert.ok(TOOL_NAMES.includes(name), `${name} still exists as a tool`);
  }
});

test("every contract tool has a handler and every handler a tool", () => {
  const handlers = toolDefs().map((t) => t.name).sort();
  assert.deepEqual(handlers, [...EXPECTED].sort());
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 50, `${tool.name} needs a discoverable description`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(tool.annotations.readOnlyHint, tool.tier === "read" || tool.tier === "doctor" || tool.tier === "generation");
  }
});

test("approval tools declare confirm/token as optional; others declare neither", () => {
  for (const tool of TOOLS) {
    const json = toJSONSchema(tool.inputSchema);
    const properties = json.properties ?? {};
    const required = json.required ?? [];
    if (APPROVAL_TIER.includes(tool.name)) {
      assert.equal(properties.confirm?.type, "boolean", `${tool.name} declares confirm: boolean`);
      assert.equal(properties.token?.type, "string", `${tool.name} declares token: string`);
      assert.ok(!required.includes("confirm"), `${tool.name} preview does not require confirm`);
      assert.ok(!required.includes("token"), `${tool.name} preview does not require token`);
    } else {
      assert.ok(!Object.hasOwn(properties, "confirm"), `${tool.name} must not declare confirm`);
      assert.ok(!Object.hasOwn(properties, "token"), `${tool.name} must not declare token`);
    }
  }
});

test("the response envelope accepts a real answer and rejects one without ok", () => {
  assert.equal(envelopeSchema.safeParse({ ok: true, mode: "read", repo: "/tmp/x" }).success, true, "extra fields survive a loose envelope");
  assert.equal(envelopeSchema.safeParse({ error: "x" }).success, false, "ok is required");
});

test("a preview answer fits the envelope", () => {
  const preview = {
    ok: true,
    requiresConfirmation: true,
    token: "0123456789abcdef0123456789abcdef",
    expiresAt: "2026-01-01T00:00:00.000Z",
    mode: "approval-preview",
    preview: { tool: "merge", fields: { ref: "master" }, argv: ["merge", "--no-edit", "master"], head: "abc", statusDigest: "def" },
  };
  assert.equal(envelopeSchema.safeParse(preview).success, true);
});

test("the generation and doctor tools are read-only (no execution)", () => {
  for (const name of ["branch_plan", "commit_message", "repo_status"]) {
    assert.equal(toolByName(name).annotations.readOnlyHint, true, `${name} executes nothing`);
  }
});
