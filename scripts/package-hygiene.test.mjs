import assert from "node:assert/strict";
import { test } from "node:test";
import { contentFindings } from "./package-hygiene.mjs";

test("package guards detect shapes without storing real private examples", () => {
  assert.deepEqual(contentFindings(["", "Users", "example-user", "file"].join("/")), ["absolute home path"]);
  assert.deepEqual(contentFindings(["mailbox", "example.invalid"].join("@")), ["e-mail address"]);
  assert.deepEqual(contentFindings(["ZZZZ", "123"].join("-")), ["non-placeholder ticket prefix"]);
  assert.deepEqual(contentFindings("sample private label", ["private label"]), ["denylisted name"]);
});

test("neutral ticket examples and Teams thread IDs remain valid", () => {
  assert.deepEqual(contentFindings("ABC-123 19:example@thread.tacv2 ~/vaults/work"), []);
});
