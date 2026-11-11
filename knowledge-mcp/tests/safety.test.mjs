/**
 * Path safety: containment by path.relative (a trailing-slash root cannot
 * reject everything), symlink escapes rejected through the realpath of the
 * deepest existing ancestor, protected locations, the vault index and the
 * secret scan.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { notePath, resolveWikiTarget, safeResolve, scanSecrets, vaultIndex } from "../dist/safety.js";

function makeVault(t) {
  const base = mkdtempSync(join(tmpdir(), "kmcp-saf-"));
  const root = join(base, "vault");
  mkdirSync(join(root, "notes"), { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

test("safeResolve rejects escapes and protected dirs (ported)", (t) => {
  const { root } = makeVault(t);
  assert.throws(() => safeResolve(root, "../outside.md", "read"), /path escapes the vault: \.\.\/outside\.md/);
  assert.throws(() => safeResolve(root, ".git/config", "read"), /protected location/);
  assert.throws(() => safeResolve(root, ".obsidian/app", "read"), /protected location/);
  assert.throws(() => safeResolve(root, "attachments/pic.png", "write"), /protected/i);
  assert.equal(safeResolve(root, "notes/a.md", "read"), join(root, "notes/a.md"));
  // attachments are readable, just not writable
  assert.equal(safeResolve(root, "attachments/pic.png", "read"), join(root, "attachments/pic.png"));
});

test("safeResolve works on a root that does not exist yet", () => {
  const vault = join(tmpdir(), `kmcp-missing-${process.pid}`);
  assert.equal(safeResolve(vault, "notes/a.md", "read"), join(vault, "notes/a.md"));
  assert.throws(() => safeResolve(vault, "../outside.md", "read"), /escapes/);
});

test("a config path with a trailing slash resolves and rejects correctly", (t) => {
  const { root } = makeVault(t);
  const slashed = root + "/";
  assert.equal(safeResolve(slashed, "notes/a.md", "read"), join(root, "notes/a.md"));
  assert.throws(() => safeResolve(slashed, "../outside.md", "read"), /escapes/);
  // absolute-inside-root is still allowed
  assert.equal(safeResolve(slashed, join(root, "notes/a.md"), "read"), join(root, "notes/a.md"));
});

test("a symlink pointing outside the root is rejected, one staying inside is not", (t) => {
  const { base, root } = makeVault(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  mkdirSync(join(root, "real"));
  symlinkSync(outside, join(root, "link"));
  symlinkSync(join(root, "real"), join(root, "alias"));

  assert.throws(() => safeResolve(root, "link/secret.md", "read"), /path escapes the vault: link\/secret\.md/);
  assert.throws(() => safeResolve(root, "link/secret.md", "write"), /escapes/);
  assert.equal(safeResolve(root, "alias/x.md", "read"), join(root, "alias/x.md"));
});

test("notePath appends .md and reports missing notes with the .md path", (t) => {
  assert.equal(notePath("/v/a"), "/v/a.md");
  const { root } = makeVault(t);
  writeFileSync(join(root, "notes/there.md"), "x");
  assert.equal(notePath(join(root, "notes/there.md"), true), join(root, "notes/there.md"));
  assert.throws(
    () => notePath(join(root, "notes/gone"), true),
    (e) => {
      assert.match(e.message, /note not found: .*notes\/gone\.md$/);
      return true;
    },
  );
});

test("vaultIndex indexes basenames and skips hidden dirs", (t) => {
  const base = mkdtempSync(join(tmpdir(), "kmcp-idx-"));
  mkdirSync(join(base, "Knowledge"));
  mkdirSync(join(base, ".hidden"));
  mkdirSync(join(base, ".obsidian"));
  writeFileSync(join(base, "Knowledge", "My Note.md"), "# hi");
  writeFileSync(join(base, "root.md"), "# root");
  writeFileSync(join(base, ".hidden", "h.md"), "h");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const idx = vaultIndex(base);
  assert.equal(idx.all.length, 2);
  assert.equal(idx.byBasename.get("my note").length, 1);
});

test("resolveWikiTarget: exact path, unique basename, ambiguity, missing", (t) => {
  const base = mkdtempSync(join(tmpdir(), "kmcp-wiki-"));
  mkdirSync(join(base, "Notes"), { recursive: true });
  mkdirSync(join(base, "Deep"));
  mkdirSync(join(base, "Deep2"));
  writeFileSync(join(base, "Notes", "My Note.md"), "x");
  writeFileSync(join(base, "Deep", "other.md"), "x");
  writeFileSync(join(base, "Deep2", "other.md"), "x");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const exact = resolveWikiTarget(base, "Notes/My Note");
  assert.equal(exact.paths.length, 1);
  assert.equal(exact.ambiguous, false);

  const byBase = resolveWikiTarget(base, "My Note");
  assert.equal(byBase.paths.length, 1);
  assert.equal(byBase.paths[0], join(base, "Notes", "My Note.md"));

  const amb = resolveWikiTarget(base, "other");
  assert.equal(amb.paths.length, 2);
  assert.equal(amb.ambiguous, true);

  assert.deepEqual(resolveWikiTarget(base, "nope"), { paths: [], ambiguous: false });
  assert.throws(() => resolveWikiTarget(base, "../../etc/passwd"), /link escapes the vault: /);
});

test("scanSecrets catches AWS key and JWT (ported)", () => {
  assert.ok(scanSecrets("key AKIAIOSFODNN7EXAMPLE").includes("AWS access key"));
  assert.ok(
    scanSecrets("jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV").length > 0,
  );
  assert.deepEqual(scanSecrets("clean text"), []);
});
