/**
 * Contract test: the nine tools, their intents, their required fields, the
 * documented caps, and the output schema every search answer must satisfy.
 * `TOOLS` is the single owner, so this file asserts it against the behaviour
 * table in registry.js instead of restating the surface.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLS, requirementReportSchema, searchResponseSchema, toolByName } from "../dist/contract.js";
import { CHAINS } from "../dist/registry.js";

const EXPECTED = [
  "providers",
  "search",
  "search_text",
  "search_files",
  "search_structure",
  "search_docs",
  "search_semantic",
  "search_machine",
  "search_crossrepo",
];

test("the tool surface is exactly the nine inherited tools", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name).sort(), [...EXPECTED].sort());
});

test("every intent-taking tool maps onto a real chain", () => {
  for (const tool of TOOLS) {
    if (tool.name === "providers") continue;
    if (tool.intent) assert.ok(CHAINS[tool.intent], `${tool.name} names unknown intent ${tool.intent}`);
    assert.ok(tool.outputSchema, `${tool.name} must advertise an output schema`);
  }
  // The router itself takes the intent from the arguments; specific tools pin it.
  assert.equal(toolByName("search").intent, undefined);
  assert.equal(toolByName("search_text").intent, "text");
  assert.equal(toolByName("search_structure").intent, "structure");
});

test("all tools are read-only and open-world", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.annotations.openWorldHint, true, tool.name);
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`);
    assert.equal(tool.title, tool.annotations.title, `${tool.name} title must match its annotation`);
  }
});

test("structure search requires a language, other tools do not", () => {
  const structure = toolByName("search_structure").inputSchema;
  assert.equal(structure.safeParse({ query: "x" }).success, false);
  assert.equal(structure.safeParse({ query: "x", lang: "ts" }).success, true);
  assert.equal(toolByName("search_text").inputSchema.safeParse({ query: "x" }).success, true);
});

test("the router validates the intent and leaves query checking to the router", () => {
  const search = toolByName("search").inputSchema;
  assert.equal(search.safeParse({ intent: "knowledge", query: "x" }).success, false);
  assert.equal(search.safeParse({ intent: "semantic", query: "x" }).success, true);
  // The "query is required" message comes from the router, not from a schema error.
  assert.equal(search.safeParse({ intent: "text", query: "" }).success, true);
});

test("documented caps are enforced on the wire", () => {
  const search = toolByName("search").inputSchema;
  assert.equal(search.safeParse({ intent: "text", query: "x", limit: 0 }).success, false);
  assert.equal(search.safeParse({ intent: "text", query: "x", limit: 201 }).success, false);
  assert.equal(search.safeParse({ intent: "text", query: "x", limit: 200 }).success, true);
  assert.equal(search.safeParse({ intent: "text", query: "x", maxSnippet: 2_001 }).success, false);
});

test("unknown arguments are ignored rather than rejected, as before", () => {
  const parsed = toolByName("search_files").inputSchema.safeParse({ query: "x", lang: "ts" });
  assert.equal(parsed.success, true);
  assert.equal("lang" in parsed.data, false);
});

test("the search response schema accepts a real answer and rejects a broken one", () => {
  const answer = {
    results: [{ path: "/tmp/a.ts", line: 3, snippet: "needle", kind: "text" }],
    provider: "rg",
    skipped: [{ name: "auggie", reason: "disabled by config" }],
    note: "degraded: lexical only — semantic providers unavailable/disabled",
    count: 1,
  };
  assert.equal(searchResponseSchema.safeParse(answer).success, true);
  assert.equal(searchResponseSchema.safeParse({ ...answer, count: "1" }).success, false);
  assert.equal(searchResponseSchema.safeParse({ ...answer, results: [{ line: 1 }] }).success, false);
});

test("a doctor report entry must carry a verdict", () => {
  const entry = {
    provider: "zoekt",
    check: "zoekt-webserver",
    what: "cross-repo trigram index",
    verdict: "blocked",
    detail: "needs go",
  };
  assert.equal(requirementReportSchema.safeParse(entry).success, true);
  assert.equal(requirementReportSchema.safeParse({ ...entry, verdict: "missing" }).success, false);
});
