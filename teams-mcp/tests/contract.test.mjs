/**
 * Contract invariants: the one tool's input and output shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIMITS,
  teamsMessageInputSchema,
  teamsMessageOutputSchema,
  isFailureStatus,
} from "../dist/contract.js";

test("a message URL is required, trimmed and length-bounded", () => {
  assert.equal(teamsMessageInputSchema.safeParse({}).success, false);
  assert.equal(teamsMessageInputSchema.safeParse({ url: "   " }).success, false);
  assert.equal(teamsMessageInputSchema.safeParse({ url: 17 }).success, false);
  assert.equal(teamsMessageInputSchema.safeParse({ url: " x " }).data.url, "x");
  assert.equal(teamsMessageInputSchema.safeParse({ url: "x".repeat(LIMITS.locatorMaxChars + 1) }).success, false);
});

test("unknown arguments are rejected instead of silently dropped", () => {
  assert.equal(teamsMessageInputSchema.safeParse({ url: "https://x", channel: "General" }).success, false);
});

test("the output schema accepts documented statuses and known causes only", () => {
  const base = {
    messageId: "1",
    author: "Ada",
    created: "2026-01-01T00:00:00Z",
    edited: null,
    text: "hello",
    truncated: false,
    reason: null,
    notes: [],
  };
  for (const status of ["ok", "empty", "unavailable", "cancelled"]) {
    assert.equal(teamsMessageOutputSchema.safeParse({ ...base, status }).success, true, `status ${status}`);
  }
  assert.equal(teamsMessageOutputSchema.safeParse({ ...base, status: "fine" }).success, false);
  assert.equal(teamsMessageOutputSchema.safeParse({ ...base, status: "unavailable", reason: "made-up" }).success, false);
  assert.equal(teamsMessageOutputSchema.safeParse({ ...base, status: "unavailable", reason: "auth" }).success, true);
});

test("only unavailable and cancelled are execution failures", () => {
  assert.equal(isFailureStatus("unavailable"), true);
  assert.equal(isFailureStatus("cancelled"), true);
  assert.equal(isFailureStatus("empty"), false);
  assert.equal(isFailureStatus("ok"), false);
});
