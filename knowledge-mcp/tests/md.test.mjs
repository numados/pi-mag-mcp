/**
 * Markdown engine: frontmatter subset parsing (unparsable blocks stay
 * verbatim), outline/section slicing, wikilinks and the small line diff.
 * Ported from agent-toolkit knowledge-mcp plus a few subset corners.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractWikiLinks,
  lineDiff,
  outline,
  parseNote,
  parseYamlSubset,
  renderNote,
  section,
  serializeYaml,
} from "../dist/md.js";

// ── frontmatter ───────────────────────────────────────────────────────────

test("parseNote: no frontmatter", () => {
  const n = parseNote("# Title\n\nbody");
  assert.equal(n.frontmatterRaw, null);
  assert.equal(n.body, "# Title\n\nbody");
});

test("parseNote: scalar + list frontmatter", () => {
  const n = parseNote("---\ntitle: My Note\ntags: [a, b]\nupdated: 2026-10-03\nnum: 42\nflag: true\n---\n# H\nbody");
  assert.equal(n.frontmatter.title, "My Note");
  assert.deepEqual(n.frontmatter.tags, ["a", "b"]);
  assert.equal(n.frontmatter.updated, "2026-10-03");
  assert.equal(n.frontmatter.num, 42);
  assert.equal(n.frontmatter.flag, true);
  assert.equal(n.body, "# H\nbody");
});

test("parseNote: block list", () => {
  const n = parseNote("---\nrefs:\n  - one.md\n  - two.md\n---\nbody");
  assert.deepEqual(n.frontmatter.refs, ["one.md", "two.md"]);
});

test("parseNote: unparsable block → frontmatter null, raw kept", () => {
  const raw = "---\nweird: [unclosed\n  - broken: {\n---\nbody";
  const n = parseNote(raw);
  assert.equal(n.frontmatter, null);
  assert.ok(n.frontmatterRaw !== null);
  assert.equal(n.body, "body");
  // render keeps the block verbatim
  assert.equal(renderNote(n), raw);
});

test("parseYamlSubset: nested map one level", () => {
  const fm = parseYamlSubset("parent:\n  a: 1\n  b: two");
  assert.deepEqual(fm.parent, { a: 1, b: "two" });
});

test("parseYamlSubset: block scalar consumed verbatim", () => {
  const fm = parseYamlSubset("text: |\n  line1\n  line2\nk: v");
  assert.equal(fm.text, "line1\nline2");
  assert.equal(fm.k, "v");
});

test("parseYamlSubset: mapping list items with continuation keys", () => {
  const fm = parseYamlSubset("repos:\n  - name: a\n    path: /x\n  - plain");
  assert.deepEqual(fm.repos, [{ name: "a", path: "/x" }, "plain"]);
});

test("parseYamlSubset: comments and blank lines skipped", () => {
  const fm = parseYamlSubset("# header\n\nk: v\n");
  assert.deepEqual(fm, { k: "v" });
});

test("serializeYaml roundtrip via renderNote", () => {
  const n = { frontmatterRaw: null, frontmatter: { title: "X: with colon", list: ["a", "b"], nested: null }, body: "hi" };
  const out = renderNote(n);
  const back = parseNote(out);
  assert.equal(back.frontmatter.title, "X: with colon");
  assert.deepEqual(back.frontmatter.list, ["a", "b"]);
});

// ── outline / section ─────────────────────────────────────────────────────

test("outline skips fenced code headings", () => {
  const body = "# Real\n\n```md\n# fake\n```\n\n## Sub\n";
  const h = outline(body);
  assert.deepEqual(h.map((x) => x.text), ["Real", "Sub"]);
});

test("section slices to same-or-higher heading", () => {
  const body = "# A\nintro\n## B1\nb1 text\n## B2\nb2 text\n# C\nc";
  assert.equal(section(body, "b1"), "b1 text");
  assert.equal(section(body, "B2"), "b2 text");
  assert.equal(section(body, "nope"), null);
});

// ── wikilinks ─────────────────────────────────────────────────────────────

test("extractWikiLinks: plain, alias, section, embed", () => {
  const links = extractWikiLinks("see [[Note]] and [[Other|alias]] and [[Path/To#Sec]] and ![[embed.png]]");
  assert.deepEqual(links.map((l) => l.target), ["Note", "Other", "Path/To", "embed.png"]);
  assert.equal(links[1].alias, "alias");
  assert.equal(links[2].section, "Sec");
});

// ── diff ──────────────────────────────────────────────────────────────────

test("lineDiff marks changed lines", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
  assert.ok(d.some((l) => l === "- b"));
  assert.ok(d.some((l) => l === "+ B"));
  assert.ok(d.some((l) => l === "+ d"));
});
