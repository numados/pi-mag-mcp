/** repo-mcp tests.
 *
 *  Fixtures are throwaway git repos built with git init/add/commit ONLY
 *  (direct spawns), under an isolated HOME with GIT_CONFIG_NOSYSTEM=1,
 *  GIT_CONFIG_GLOBAL pointing at an empty file, and identity via env vars —
 *  no user config, no hooksPath, no remote activity ever.
 *
 *  fetch/pull, default-branch detection success paths, and injection sweeps
 *  run against a RECORDING MOCK runner swapped in via setGitRunner() — the
 *  seam every git call in the server goes through. Everything else (approvals,
 *  staged-only commit, destructive ops, generation) runs the real spawner
 *  against real fixtures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { setGitRunner, redact, git } from "../dist/exec.js";
import { setClock, pendingCount } from "../dist/approvals.js";
import { toolDefs } from "../dist/tools.js";
import { slugifyWords, stagedFromPorcelain } from "../dist/generate.js";

// ── isolated git environment (before ANY git spawn) ───────────────────────

const fixtureRoot = mkdtempSync(join(tmpdir(), "repo-mcp-test-"));
process.on("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const fakeHome = join(fixtureRoot, "home");
mkdirSync(fakeHome, { recursive: true });
writeFileSync(join(fakeHome, ".gitconfig"), "");
process.env.HOME = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(fakeHome, ".gitconfig");
process.env.GIT_AUTHOR_NAME = "repo-mcp-test";
process.env.GIT_AUTHOR_EMAIL = "test@localhost";
process.env.GIT_COMMITTER_NAME = "repo-mcp-test";
process.env.GIT_COMMITTER_EMAIL = "test@localhost";

// ── fixture helpers: git init/add/commit ONLY ─────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env: process.env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

let seq = 0;
function makeRepo(name = "repo") {
  const dir = join(fixtureRoot, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-b", "master");
  return dir;
}

function commitFile(repo, file, content, msg) {
  const p = join(repo, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  sh(repo, "add", file);
  sh(repo, "commit", "-m", msg ?? `add ${file}`);
}

function stage(repo, file, content) {
  writeFileSync(join(repo, file), content);
  sh(repo, "add", file);
}

// ── tool invocation ───────────────────────────────────────────────────────

const tools = new Map(toolDefs().map((t) => [t.name, t]));
const toolNames = [...tools.keys()];

async function call(name, args = {}, signal) {
  const t = tools.get(name);
  assert.ok(t, `tool ${name} exists`);
  return t.handler(args, signal);
}

/** recording mock runner — answers rev-parse from cwd, everything else from
 *  the optional handler, records every argv it was handed. */
function mockRunner(handler) {
  const calls = [];
  const impl = async ({ cwd, args, signal }) => {
    calls.push({ cwd, args });
    if (handler) {
      const h = handler({ cwd, args, signal });
      if (h) return { stdout: "", stderr: "", code: 0, truncated: false, aborted: false, ...h };
    }
    return { stdout: "", stderr: "", code: 0, truncated: false, aborted: false };
  };
  impl.calls = calls;
  return impl;
}

function withMock(impl, fn) {
  setGitRunner(impl);
  return Promise.resolve(fn(impl)).finally(() => setGitRunner(null));
}

function sc(res) {
  return res.structuredContent ?? {};
}

// ── structural surface ────────────────────────────────────────────────────

test("tool surface: no push/send-pack/exec tool, expected names only", () => {
  assert.deepEqual(
    toolNames.sort(),
    [
      "repo_status", "git_status", "git_log", "git_diff", "git_show", "git_branch_list",
      "git_blame", "git_default_branch", "git_refs", "git_fetch", "git_pull", "git_commit",
      "branch_create", "merge", "rebase", "reset", "restore", "switch", "destructive_local",
      "branch_plan", "commit_message",
    ].sort(),
  );
  for (const n of toolNames) {
    assert.match(n, /^(repo_status|git_|branch_|commit_|merge$|rebase$|reset$|restore$|switch$|destructive_local$)/, `unexpected tool name ${n}`);
  }
});

test("every approval-tier description demands real user approval and denies that confirm is permission", () => {
  for (const name of ["branch_create", "merge", "rebase", "reset", "restore", "switch", "destructive_local"]) {
    const d = tools.get(name).description;
    assert.match(d, /approval/i, `${name} says approval tier`);
    assert.match(d, /obtain explicit approval/i, `${name} tells the caller to obtain approval`);
    assert.match(d, /not permission|not itself human permission|transport, not permission/i, `${name} denies confirm==permission`);
  }
});

// ── repo resolution ───────────────────────────────────────────────────────

test("non-repo path is rejected with rev-parse evidence", async () => {
  const dir = join(fixtureRoot, "not-a-repo");
  mkdirSync(dir, { recursive: true });
  const r = await call("git_status", { repo: dir });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a git repository/);
});

test("subdirectory repo param binds commands to the resolved toplevel", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "one");
  const sub = join(repo, "nested", "deep");
  mkdirSync(sub, { recursive: true });
  const r = await call("git_status", { repo: sub });
  assert.equal(r.isError, undefined);
  assert.equal(sc(r).repo, realpathSync(repo)); // canonicalized (macOS /var → /private/var)
});

// ── read tools on a real fixture ──────────────────────────────────────────

test("git_status/log/diff/show/branch_list/refs read a real repo", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "one\n");
  commitFile(repo, "b.txt", "two\n");
  writeFileSync(join(repo, "a.txt"), "changed\n");

  const st = await call("git_status", { repo });
  assert.match(st.content[0].text, /## master/);
  assert.match(st.content[0].text, /M a\.txt/);

  const log = await call("git_log", { repo, limit: 1 });
  assert.equal(sc(log).output.split("\n").length, 1);
  assert.match(sc(log).command, /'log' '--oneline' '--decorate=short' '-n' '1'/);

  const diff = await call("git_diff", { repo });
  assert.match(sc(diff).output, /\+changed/);

  const stagedDiff = await call("git_diff", { repo, staged: true });
  assert.equal(sc(stagedDiff).output, ""); // nothing staged

  const show = await call("git_show", { repo });
  assert.match(sc(show).output, /add b\.txt/);

  const branches = await call("git_branch_list", { repo });
  assert.match(sc(branches).output, /refs\/heads\/master/);

  const refs = await call("git_refs", { repo, kind: "heads" });
  assert.match(sc(refs).output, /refs\/heads\/master\t/);

  const blame = await call("git_blame", { repo, path: "a.txt" });
  assert.match(sc(blame).command, /'--' 'a\.txt'/);

  const logPath = await call("git_log", { repo, path: "a.txt" });
  assert.match(sc(logPath).command, /'--' ':\(literal\)a\.txt'/);
});

test("git_default_branch: undeterminable base is an error, not a guess", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const r = await call("git_default_branch", { repo });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not determine the default branch.*pass base explicitly/s);
});

test("git_default_branch detection paths (mocked runner): origin/HEAD, tracking fallback, ambiguity", async () => {
  const dirs = [makeRepo("d1"), makeRepo("d2"), makeRepo("d3"), makeRepo("d4")].map((d) => realpathSync(d));
  let i = 0;
  await withMock(mockRunner(({ cwd, args }) => {
    if (args[0] === "rev-parse") return { stdout: cwd + "\n" };
    if (args[0] === "symbolic-ref" && dirs[i] === cwd) return { stdout: "refs/remotes/origin/develop\n" };
    return null;
  }), async () => {
    const r = await call("git_default_branch", { repo: dirs[0] });
    assert.equal(sc(r).branch, "origin/develop");
  });

  await withMock(mockRunner(({ cwd, args }) => {
    if (args[0] === "rev-parse") return { stdout: cwd + "\n" };
    if (args[0] === "symbolic-ref") return { code: 1, stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n" };
    if (args[0] === "for-each-ref") return { stdout: "master\torigin/master\nfeature\torigin/master\n" };
    return null;
  }), async () => {
    const r = await call("git_default_branch", { repo: dirs[1] });
    assert.equal(sc(r).branch, "origin/master");
  });

  await withMock(mockRunner(({ cwd, args }) => {
    if (args[0] === "rev-parse") return { stdout: cwd + "\n" };
    if (args[0] === "symbolic-ref") return { code: 1, stderr: "x" };
    if (args[0] === "for-each-ref") return { stdout: "master\torigin/master\nmain\torigin/main\n" };
    return null;
  }), async () => {
    const r = await call("git_default_branch", { repo: dirs[2] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /ambiguous/);
  });

  await withMock(mockRunner(({ cwd, args }) => {
    if (args[0] === "rev-parse") return { stdout: cwd + "\n" };
    return null;
  }), async () => {
    const r = await call("git_default_branch", { repo: dirs[3] });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /could not determine/);
  });
});

// ── validation / injection ────────────────────────────────────────────────

test("refs reject leading '-', control chars, and whitespace padding", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  for (const bad of ["--exec=rm -rf", "-x", "\u0007evil", " spaced", "spaced "]) {
    const r = await call("git_show", { repo, ref: bad });
    assert.equal(r.isError, true, `ref ${JSON.stringify(bad)} must be rejected`);
    assert.match(r.content[0].text, /must not|ref must/i);
  }
});

test("branch names reject options, ref paths, globs, control chars", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  for (const bad of ["-b", "refs/heads/master", "HEAD", "a..b", "a//b", "a.lock", ".hidden", "evil*", "evil\n", "a b"]) {
    const r = await call("switch", { repo, branch: bad });
    assert.equal(r.isError, true, `branch ${JSON.stringify(bad)} must be rejected`);
  }
});

test("paths must stay inside the repo and land after '--'", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const sub = join(repo, "sub");
  mkdirSync(sub);
  commitFile(repo, "sub/c.txt", "y");

  const escape1 = await call("git_log", { repo: sub, path: "../../outside.txt" });
  assert.equal(escape1.isError, true);
  assert.match(escape1.content[0].text, /outside the repository/);

  const escape2 = await call("git_log", { repo, path: "/etc/passwd" });
  assert.equal(escape2.isError, true);

  const ok = await call("git_log", { repo: sub, path: "c.txt" });
  assert.equal(ok.isError, undefined);
  assert.match(sc(ok).command, /'--' ':\(literal\)sub\/c\.txt'/); // repo-relative after --
});

test("remote must be a configured name, never a URL", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const r = await call("git_fetch", { repo, remote: "https://user:secret@example/x.git" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /plain configured remote name/);
});

test("unknown/extra params are inert: planted strings never reach argv", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const PLANT = "PLANTED-evil;rm -rf /";
  await withMock(mockRunner(), async (mock) => {
    for (const [name, args] of [
      ["git_status", { repo, options: [PLANT], flags: PLANT }],
      ["git_log", { repo, limit: 5, extra: PLANT, format: PLANT }],
      ["git_diff", { repo, staged: true, base2: PLANT }],
      ["git_show", { repo, ref: "HEAD", exec: PLANT }],
      ["git_refs", { repo, pattern: PLANT }],
      ["git_fetch", { repo, prune: true, refspec: PLANT, tags: true }],
      ["git_pull", { repo, rebase: true, strategy: PLANT, force: true, options: [PLANT] }],
    ]) {
      const r = await call(name, args);
      if (r.isError) continue; // mock may not satisfy later steps; argv is the point
    }
    for (const { args } of mock.calls) {
      for (const a of args) {
        assert.ok(!String(a).includes("PLANTED-evil"), `planted string leaked into argv: ${JSON.stringify(args)}`);
        assert.notEqual(a, "push");
      }
    }
    // fetch/pull argv shapes are exactly the documented conservative ones
    const fetch = mock.calls.find((c) => c.args[0] === "fetch");
    assert.ok(fetch, "fetch ran");
    assert.deepEqual(fetch.args, ["fetch", "origin"]);
    const pull = mock.calls.find((c) => c.args[0] === "pull");
    assert.ok(pull, "pull ran");
    assert.deepEqual(pull.args, ["pull", "--ff-only"]);
    assert.ok(!pull.args.includes("--rebase"));
    assert.ok(!pull.args.includes("--force"));
  });
});

test("limit validation: integer 1..500 only", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  for (const bad of [0, -1, 501, 20.5, "20", null]) {
    const r = await call("git_log", { repo, limit: bad });
    assert.equal(r.isError, true, `limit ${JSON.stringify(bad)} rejected`);
  }
  const ok = await call("git_log", { repo, limit: 10 });
  assert.equal(ok.isError, undefined);
});

test("git_diff refuses staged+base together", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const r = await call("git_diff", { repo, staged: true, base: "master" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not both/);
});

test("credential-bearing URLs are redacted from outputs — and redact stays linear on 1 MiB", () => {
  const dirty = "fetch https://alice:supersecret@github/acme/api from origin\nsee https://host/x?token=abcd1234&z=1 ghp_0123456789abcdefghijkl";
  const clean = redact(dirty);
  assert.ok(!clean.includes("supersecret"));
  assert.ok(!clean.includes("abcd1234"));
  assert.ok(!clean.includes("ghp_0123456789"));
  assert.match(clean, /\[redacted\]/);
  // plain URLs without credentials survive untouched
  assert.match(redact("see https://github.com/acme/api"), /acme\/api/);
  // regression guard: bounded quantifiers — 1 MiB hostile input must be fast
  const t0 = Date.now();
  redact("B".repeat(1_000_000));
  redact("https://" + "a".repeat(999_000));
  assert.ok(Date.now() - t0 < 2000, `redact took ${Date.now() - t0}ms on 1 MiB`);
});

// ── cancellation + bounded output ─────────────────────────────────────────

test("pre-aborted signal: process is killed, aborted=true, no hang", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "big.txt"), "B".repeat(8 * 1024 * 1024));
  sh(repo, "add", "big.txt");
  sh(repo, "commit", "-m", "big");
  const r = await git({ cwd: repo, args: ["show", "HEAD:big.txt"], signal: AbortSignal.abort() });
  assert.equal(r.aborted, true);
});

test("output is bounded: 8 MiB blob truncates at the 1 MiB cap", async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "big.txt"), "B".repeat(8 * 1024 * 1024));
  sh(repo, "add", "big.txt");
  sh(repo, "commit", "-m", "big");
  const r = await call("git_show", { repo });
  assert.equal(sc(r).truncated, true);
  assert.ok(sc(r).output.length <= 1_000_000);
});

test("tool call honors an aborted MCP signal", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const r = await call("git_log", { repo }, AbortSignal.abort());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /cancelled/);
});

// ── git_commit: staged-only, supplied message only ────────────────────────

test("commit: staged changes only; unstaged/untracked left alone; empty staging is an error", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "a.txt"), "v2-staged");
  sh(repo, "add", "a.txt");
  writeFileSync(join(repo, "b.txt"), "unstaged"); // tracked? no — new file unstaged/untracked
  writeFileSync(join(repo, "c.txt"), "untracked");

  const r = await call("git_commit", { repo, message: "fix(api): NUMDOS-1 Update a" });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /committed staged changes/);

  const st = await call("git_status", { repo });
  assert.match(sc(st).output, /\?\? b\.txt/);
  assert.match(sc(st).output, /\?\? c\.txt/);
  assert.ok(!/M {2}|^M/m.test(sc(st).output.replace(/## .*/s, "").trim()), "a.txt fully committed");

  const again = await call("git_commit", { repo, message: "nope" });
  assert.equal(again.isError, true);
  assert.match(again.content[0].text, /nothing staged/);
  assert.match(again.content[0].text, /never runs git add/);
});

test("commit refuses empty messages and never amends or adds flags", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  stage(repo, "a.txt", "y");
  const bad = await call("git_commit", { repo, message: "   " });
  assert.equal(bad.isError, true);
  const r = await call("git_commit", { repo, message: "fix: only message" });
  assert.equal(r.isError, undefined);
  // the commit before HEAD is 'add a.txt' — nothing was amended
  const log = await call("git_log", { repo, limit: 2 });
  assert.match(sc(log).output, /add a\.txt/);
});

test("commit preflight blocks oversized staged text before git commit", async () => {
  const repo = makeRepo();
  commitFile(repo, "base.txt", "base");
  const before = sh(repo, "rev-parse", "HEAD").stdout;
  writeFileSync(join(repo, "too-large.ts"), "x".repeat(20_001));
  sh(repo, "add", "too-large.ts");
  const r = await call("git_commit", { repo, message: "feat: add large file" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /staged file-size policy violation/);
  assert.match(r.content[0].text, /too-large\.ts/);
  assert.equal(sh(repo, "rev-parse", "HEAD").stdout, before);
  assert.match(sh(repo, "status", "--porcelain=v1").stdout, /A  too-large\.ts/);
});

test("commit preflight ignores an oversized existing source file", async () => {
  const repo = makeRepo();
  const large = "x".repeat(20_001);
  commitFile(repo, "legacy.ts", large);
  const changed = "y" + large.slice(1) + "z";
  writeFileSync(join(repo, "legacy.ts"), changed);
  sh(repo, "add", "legacy.ts");
  const r = await call("git_commit", { repo, message: "fix: edit legacy file" });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("commit preflight honors generated-file ignore rules", async () => {
  const repo = makeRepo();
  commitFile(repo, "base.txt", "base");
  writeFileSync(join(repo, ".agent-file-size.conf"), "ignore=fixtures/file[0-9].generated\n");
  mkdirSync(join(repo, "fixtures"), { recursive: true });
  writeFileSync(join(repo, "fixtures", "file1.generated"), "x".repeat(20_001));
  sh(repo, "add", ".agent-file-size.conf", "fixtures/file1.generated");
  const r = await call("git_commit", { repo, message: "chore: update generated fixture" });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("commit preflight ignores oversized blog posts and text files", async () => {
  const repo = makeRepo();
  commitFile(repo, "base.ts", "base");
  writeFileSync(join(repo, "post.md"), "x".repeat(20_001));
  writeFileSync(join(repo, "notes.txt"), "x".repeat(20_001));
  sh(repo, "add", "post.md", "notes.txt");
  const r = await call("git_commit", { repo, message: "docs: add long text" });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("commit preflight ignores unstaged config changes", async () => {
  const repo = makeRepo();
  commitFile(repo, "base.txt", "base");
  writeFileSync(join(repo, ".agent-file-size.conf"), "max_tokens=5000\n");
  sh(repo, "add", ".agent-file-size.conf");
  writeFileSync(join(repo, "too-large.ts"), "x".repeat(20_001));
  sh(repo, "add", "too-large.ts");
  writeFileSync(join(repo, ".agent-file-size.conf"), "ignore=*\n");
  const r = await call("git_commit", { repo, message: "feat: block unstaged policy bypass" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /too-large\.ts/);
});

test("commit preflight rejects a symlinked policy config", async () => {
  const repo = makeRepo();
  commitFile(repo, "base.txt", "base");
  const external = join(fixtureRoot, `external-config-${seq}.conf`);
  writeFileSync(external, "ignore=*\n");
  symlinkSync(external, join(repo, ".agent-file-size.conf"));
  sh(repo, "add", ".agent-file-size.conf");
  const r = await call("git_commit", { repo, message: "chore: reject symlink config" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /regular staged file/);
});

// ── two-step approvals ────────────────────────────────────────────────────

function previewOk(r) {
  assert.equal(r.isError, undefined, JSON.stringify(r.content[0].text));
  const s = sc(r);
  assert.equal(s.requiresConfirmation, true);
  assert.match(typeof s.token, /./);
  assert.ok(s.token.length >= 32, "opaque random token");
  return s;
}

test("merge approval: preview shows exact quoted command; confirm executes exactly it", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  // build a real second branch through the tools themselves
  const bp = previewOk(await call("branch_create", { repo, name: "bugfix/m", base: "master" }));
  const bpDone = await call("branch_create", { repo, name: "bugfix/m", base: "master", confirm: true, token: bp.token });
  assert.match(bpDone.content[0].text, /executed/);
  commitFile2(repo, "n.txt", "new");
  const sw = previewOk(await call("switch", { repo, branch: "master" }));
  const swRes = await call("switch", { repo, branch: "master", confirm: true, token: sw.token });
  assert.match(swRes.content[0].text, /executed/);

  const prev = await call("merge", { repo, ref: "bugfix/m" });
  const s = previewOk(prev);
  assert.match(prev.content[0].text, /PREVIEW — nothing executed/);
  assert.match(prev.content[0].text, /must show this exact preview to the user/i);
  assert.equal(s.command, "git 'merge' '--no-edit' 'bugfix/m'");
  assert.match(prev.content[0].text, /'merge' '--no-edit' 'bugfix\/m'/);

  const done = await call("merge", { repo, ref: "bugfix/m", confirm: true, token: s.token });
  assert.equal(done.isError, undefined, done.content[0].text);
  assert.match(done.content[0].text, /executed \(approved\)/);
  assert.match(done.content[0].text, /trust boundary/i);
  // fast-forward merge: n.txt from bugfix/m is now on master
  const log = await call("git_log", { repo, limit: 3 });
  assert.match(sc(log).output, /add n\.txt/);
  assert.match(sc(log).output, /master/);
});

function commitFile2(repo, file, content) {
  writeFileSync(join(repo, file), content);
  sh(repo, "add", file);
  sh(repo, "commit", "-m", `add ${file}`);
}

test("approval tokens: wrong token, argument mismatch burns the token, replay after success", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");

  const wrong = await call("merge", { repo, ref: "master", confirm: true, token: "deadbeef" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /unknown, expired, or already-used/);

  // a mismatched confirm attempt CONSUMES the token (no probing with altered args)
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  const mismatch = await call("merge", { repo, ref: "HEAD", confirm: true, token: s.token });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /arguments differ/);
  const burned = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(burned.isError, true);
  assert.match(burned.content[0].text, /unknown, expired, or already-used/);

  // fresh token: one successful execution, then the token is dead
  const s2 = previewOk(await call("merge", { repo, ref: "master" }));
  const first = await call("merge", { repo, ref: "master", confirm: true, token: s2.token });
  assert.equal(first.isError, undefined, first.content[0].text);

  const replay = await call("merge", { repo, ref: "master", confirm: true, token: s2.token });
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /unknown, expired, or already-used/);
});

test("approval token expiry (TTL 5 min, virtual clock)", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const s = previewOk(await call("rebase", { repo, base: "master" }));
  setClock(() => Date.now() + 6 * 60_000);
  try {
    const r = await call("rebase", { repo, base: "master", confirm: true, token: s.token });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /expired/);
  } finally {
    setClock(null);
  }
});

test("expired tokens are pruned on issuance — the cache cannot grow without bound", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const before = pendingCount();
  previewOk(await call("merge", { repo, ref: "master" }));
  assert.equal(pendingCount(), before + 1);
  setClock(() => Date.now() + 10 * 60_000); // every token issued so far is now definitely expired
  const s2 = previewOk(await call("merge", { repo, ref: "master" }));
  assert.equal(pendingCount(), 1, "expired entries pruned during issuance, exactly the fresh token remains");
  setClock(null);
  const ok = await call("merge", { repo, ref: "master", confirm: true, token: s2.token });
  assert.equal(ok.isError, undefined, ok.content[0].text); // fresh token unaffected by pruning
});

test("approval staleness: HEAD moved or working tree changed invalidates the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  const s1 = previewOk(await call("reset", { repo, mode: "mixed", ref: "master" }));
  commitFile(repo, "b.txt", "new commit moves HEAD");
  const r1 = await call("reset", { repo, mode: "mixed", ref: "master", confirm: true, token: s1.token });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0].text, /HEAD moved/);

  const s2 = previewOk(await call("reset", { repo, mode: "mixed", ref: "master" }));
  writeFileSync(join(repo, "dirty.txt"), "working tree digest changes");
  const r2 = await call("reset", { repo, mode: "mixed", ref: "master", confirm: true, token: s2.token });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /working tree changed/);
});

// ── content-binding regressions: porcelain-shape-identical edits must refuse ─

test("digest binds CONTENT: re-editing an already-modified file (constant ' M' status) refuses the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "a.txt"), "v2");
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  writeFileSync(join(repo, "a.txt"), "v3 — same ' M a.txt' porcelain, different bytes");
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("digest binds STAGED content: re-staging different bytes (constant 'M ' status) refuses the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "a.txt"), "v2");
  sh(repo, "add", "a.txt");
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  writeFileSync(join(repo, "a.txt"), "v3 staged differently");
  sh(repo, "add", "a.txt"); // index blob sha changes, porcelain stays 'M  a.txt'
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("digest binds UNTRACKED content: rewriting an untracked file (constant '??' status) refuses the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "u.txt"), "one");
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  writeFileSync(join(repo, "u.txt"), "two — same '?? u.txt' porcelain, different bytes");
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("digest binds untracked file content inside untracked DIRECTORIES (clean -d targets)", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  mkdirSync(join(repo, "junkdir"), { recursive: true });
  writeFileSync(join(repo, "junkdir", "deep.txt"), "payload-1");
  const s = previewOk(await call("destructive_local", { repo, action: "clean", paths: ["junkdir"] }));
  writeFileSync(join(repo, "junkdir", "deep.txt"), "payload-2 — status shape unchanged");
  const r = await call("destructive_local", { repo, action: "clean", paths: ["junkdir"], confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("digest binds symlink targets: retargeting an untracked symlink (constant '??' status) refuses the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  commitFile(repo, "b.txt", "v1");
  symlinkSync(join(repo, "a.txt"), join(repo, "link.txt"));
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  rmSync(join(repo, "link.txt"));
  symlinkSync(join(repo, "b.txt"), join(repo, "link.txt")); // '?? link.txt' unchanged, target changed
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("digest binds BINARY content: same-length untracked rewrite refuses the token", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]));
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 253, 0, 0])); // same length, same status
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /working tree changed/);
});

test("fingerprint fails CLOSED on oversized and unreadable inputs (token refused, not weakened)", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");

  // oversized untracked file (> 4 MiB per-file bound)
  writeFileSync(join(repo, "huge.bin"), Buffer.alloc(5 * 1024 * 1024, 7));
  const big = await call("merge", { repo, ref: "master" });
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /cannot fingerprint.*fail closed/);

  // unreadable file — chmod 000 (skipped when running as root)
  rmSync(join(repo, "huge.bin"));
  writeFileSync(join(repo, "locked.txt"), "secret");
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    chmodSync(join(repo, "locked.txt"), 0o000);
    try {
      const locked = await call("merge", { repo, ref: "master" });
      assert.equal(locked.isError, true);
      assert.match(locked.content[0].text, /cannot fingerprint.*locked\.txt.*fail closed/);
    } finally {
      chmodSync(join(repo, "locked.txt"), 0o644);
    }
  }
});

test("confirm recomputes the same content-bound digest: untouched worktree still confirms fine", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "mod.txt"), "modified-but-stable");
  writeFileSync(join(repo, "untracked.txt"), "untracked-but-stable");
  mkdirSync(join(repo, "dir"), { recursive: true });
  writeFileSync(join(repo, "dir", "x.bin"), Buffer.from([1, 2, 3]));
  symlinkSync("a.txt", join(repo, "stable-link"));
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  const r = await call("merge", { repo, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, undefined, r.content[0].text);
});

test("approval token is bound to its repository", async () => {
  const repoA = makeRepo("bindA");
  const repoB = makeRepo("bindB");
  commitFile(repoA, "a.txt", "x");
  commitFile(repoB, "a.txt", "x");
  const s = previewOk(await call("merge", { repo: repoA, ref: "master" }));
  const r = await call("merge", { repo: repoB, ref: "master", confirm: true, token: s.token });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /issued for repository/);
});

test("concurrent replay: exactly one of two racing confirms executes", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const s = previewOk(await call("merge", { repo, ref: "master" }));
  const args = { repo, ref: "master", confirm: true, token: s.token };
  const before = pendingCount();
  const [r1, r2] = await Promise.all([call("merge", args), call("merge", args)]);
  const oks = [r1, r2].filter((r) => !r.isError);
  assert.equal(oks.length, 1, `exactly one wins: ${[r1, r2].map((r) => r.content[0].text)}`);
  const loser = [r1, r2].find((r) => r.isError);
  assert.match(loser.content[0].text, /unknown, expired, or already-used/);
  assert.equal(pendingCount(), before - 1); // the shared token was consumed exactly once
});

test("reset --hard (approved) restores tracked file content", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "original");
  writeFileSync(join(repo, "a.txt"), "clobbered");
  const s = previewOk(await call("reset", { repo, mode: "hard" }));
  const r = await call("reset", { repo, mode: "hard", confirm: true, token: s.token });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original");
});

test("restore (approved) discards changes only for supplied paths", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "A1");
  commitFile(repo, "b.txt", "B1");
  writeFileSync(join(repo, "a.txt"), "A2");
  writeFileSync(join(repo, "b.txt"), "B2");
  const s = previewOk(await call("restore", { repo, paths: ["a.txt"] }));
  assert.match(s.command, /'restore' '--' ':\(literal\)a\.txt'/);
  const r = await call("restore", { repo, paths: ["a.txt"], confirm: true, token: s.token });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "A1");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "B2");
});

test("destructive_local clean: dry-run preview, then exact-path execution", async () => {
  const repo = makeRepo();
  commitFile(repo, "kept.txt", "tracked");
  mkdirSync(join(repo, "junkdir"), { recursive: true });
  writeFileSync(join(repo, "junk1.txt"), "junk");
  writeFileSync(join(repo, "junkdir/j2.txt"), "junk");

  const prev = await call("destructive_local", { repo, action: "clean", paths: ["junk1.txt", "junkdir"] });
  const s = previewOk(prev);
  assert.match(prev.content[0].text, /Would remove junk1\.txt/);
  assert.match(prev.content[0].text, /Would remove junkdir\//);
  assert.equal(s.command, "git 'clean' '-f' '-d' '--' ':(literal)junk1.txt' ':(literal)junkdir'");
  assert.ok(!s.command.includes("-x"), "ignored files are never -x cleaned");

  const r = await call("destructive_local", { repo, action: "clean", paths: ["junk1.txt", "junkdir"], confirm: true, token: s.token });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.ok(!existsSync(join(repo, "junk1.txt")));
  assert.ok(!existsSync(join(repo, "junkdir")));
  assert.ok(existsSync(join(repo, "kept.txt")), "tracked file untouched");
});

test("destructive_local branch_delete_force: exact validated name only", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const s = previewOk(await call("destructive_local", { repo, action: "branch_delete_force", name: "bugfix/gone" }));
  assert.equal(s.command, "git 'branch' '-D' 'bugfix/gone'");
  for (const bad of ["bugfix/*", "refs/heads/master", "-D", "a b"]) {
    const r = await call("destructive_local", { repo, action: "branch_delete_force", name: bad });
    assert.equal(r.isError, true, `name ${bad} rejected`);
  }
});

test("branch_create uses detected default or explicit base; refuses name==base", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  const s = previewOk(await call("branch_create", { repo, name: "bugfix/1", base: "master" }));
  assert.equal(s.command, "git 'switch' '--no-overwrite-ignore' '-c' 'bugfix/1' 'master'");
  const r = await call("branch_create", { repo, name: "bugfix/1", base: "master", confirm: true, token: s.token });
  assert.equal(r.isError, undefined, r.content[0].text);

  const same = await call("branch_create", { repo, name: "master", base: "master" });
  assert.equal(same.isError, true);
  assert.match(same.content[0].text, /same name as its base/);
});

// ── fetch / pull (mocked — no network, no remotes) ────────────────────────

test("git_fetch: plain fetch of a configured remote name; no prune/tags/config", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  await withMock(mockRunner(({ cwd, args }) => (args[0] === "rev-parse" ? { stdout: cwd + "\n" } : null)), async (mock) => {
    const r = await call("git_fetch", { repo, remote: "upstream" });
    assert.equal(r.isError, undefined);
    const fetch = mock.calls.find((c) => c.args[0] === "fetch");
    assert.deepEqual(fetch.args, ["fetch", "upstream"]);
    for (const forbidden of ["--prune", "--tags", "-t", "-p", "config", "-c"]) {
      assert.ok(!fetch.args.includes(forbidden), `fetch must not carry ${forbidden}`);
    }
  });
});

test("git_pull: --ff-only always; remote+branch validated; branch alone refused", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  await withMock(mockRunner(({ cwd, args }) => (args[0] === "rev-parse" ? { stdout: cwd + "\n" } : null)), async (mock) => {
    const r = await call("git_pull", { repo, remote: "origin", branch: "master" });
    assert.equal(r.isError, undefined);
    const pull = mock.calls.find((c) => c.args[0] === "pull");
    assert.deepEqual(pull.args, ["pull", "--ff-only", "origin", "master"]);
  });
  const noRemote = await call("git_pull", { repo, branch: "master" });
  assert.equal(noRemote.isError, true);
  assert.match(noRemote.content[0].text, /pass remote together with branch/);
});

// ── generation ────────────────────────────────────────────────────────────

test("branch_plan: jira key verbatim, no suffix; ado id + 2-5 kebab words; explicit base", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");

  const jira = await call("branch_plan", { repo, tracker: "jira", type: "bugfix", ticket: "PROJ-123", base: "master" });
  assert.equal(sc(jira).branch, "bugfix/PROJ-123");
  assert.match(sc(jira).command, /'switch' '--no-overwrite-ignore' '-c' 'bugfix\/PROJ-123' 'master'/);

  const withDesc = await call("branch_plan", { repo, tracker: "jira", type: "feature", ticket: "NUMDOS-9", description: "x", base: "master" });
  assert.equal(withDesc.isError, true);
  assert.match(withDesc.content[0].text, /only the key/);

  const ado = await call("branch_plan", { repo, tracker: "ado", type: "feature", ticket: "181874", description: "Editable Instrument Type!", base: "master" });
  assert.equal(sc(ado).branch, "feature/181874-editable-instrument-type");

  const oneWord = await call("branch_plan", { repo, tracker: "ado", type: "bugfix", ticket: "181874", description: "fix", base: "master" });
  assert.equal(oneWord.isError, true);
  assert.match(oneWord.content[0].text, /2–5 kebab words/);

  const sixWords = await call("branch_plan", { repo, tracker: "ado", type: "bugfix", ticket: "181874", description: "one two three four five six", base: "master" });
  assert.equal(sixWords.isError, true);

  const badKey = await call("branch_plan", { repo, tracker: "jira", type: "bugfix", ticket: "proj123", base: "master" });
  assert.equal(badKey.isError, true);

  const noBase = await call("branch_plan", { repo, tracker: "jira", type: "bugfix", ticket: "PROJ-1" });
  assert.equal(noBase.isError, true);
  assert.match(noBase.content[0].text, /could not determine the default branch.*pass base explicitly/s);
});

test("branch_plan executes nothing (mocked runner sees only reads)", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "x");
  await withMock(mockRunner(({ cwd, args }) => (args[0] === "rev-parse" ? { stdout: cwd + "\n" } : null)), async (mock) => {
    await call("branch_plan", { repo, tracker: "ado", type: "bugfix", ticket: "42", description: "two words", base: "master" });
    for (const { args } of mock.calls) {
      assert.notEqual(args[0], "switch");
      assert.notEqual(args[0], "checkout");
    }
  });
});

test("slugifyWords and stagedFromPorcelain units", () => {
  assert.deepEqual(slugifyWords("Editable Instrument Type!"), ["editable", "instrument", "type"]);
  assert.deepEqual(slugifyWords("--Weird  spacing--"), ["weird", "spacing"]);
  const staged = stagedFromPorcelain("## master\nM  a.txt\n M b.txt\n?? c.txt\nA  d.txt\nR  old -> new\n");
  assert.deepEqual(staged, ["a.txt", "d.txt", "new"]);
});

test("commit_message: staged scope first, unstaged fallback reported, ticket from branch, deterministic format", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  // hop onto a ticket branch via the approval flow (no direct git branch use)
  const s = previewOk(await call("branch_create", { repo, name: "bugfix/NUMDOS-9", base: "master" }));
  await call("branch_create", { repo, name: "bugfix/NUMDOS-9", base: "master", confirm: true, token: s.token });

  writeFileSync(join(repo, "a.txt"), "v2");
  sh(repo, "add", "a.txt");
  writeFileSync(join(repo, "b.txt"), "untracked-later");

  const r = await call("commit_message", {
    repo,
    type: "fix",
    scope: "api",
    summary: "Prevent token replay",
    body: ["Tokens are consumed before the child spawns", "A stale HEAD invalidates the preview"],
  });
  const out = sc(r);
  assert.equal(out.scopeUsed, "staged");
  assert.equal(out.ticket, "NUMDOS-9");
  assert.equal(out.ticketSource, "branch");
  assert.equal(
    out.message,
    "fix(api): NUMDOS-9 Prevent token replay\n\n- Tokens are consumed before the child spawns\n- A stale HEAD invalidates the preview",
  );
  assert.match(r.content[0].text, /limitation:/);
  assert.match(r.content[0].text, /cannot infer/);

  // commit the staged change through the tool, leave a tracked file modified
  const cm = await call("git_commit", { repo, message: "fix(api): NUMDOS-9 Prevent token replay" });
  assert.equal(cm.isError, undefined, cm.content[0].text);
  writeFileSync(join(repo, "a.txt"), "v3-unstaged");

  // nothing staged → unstaged fallback, explicitly reported
  const r2 = await call("commit_message", { repo, type: "docs", summary: "Explain ff-only default" });
  assert.equal(sc(r2).scopeUsed, "unstaged");
  assert.match(r2.content[0].text, /scope=unstaged/);

  // explicit ticket wins over branch
  const r3 = await call("commit_message", { repo, type: "chore", summary: "Bump toolchain", ticket: "181874" });
  assert.equal(sc(r3).ticket, "181874");
  assert.equal(sc(r3).ticketSource, "supplied");
});

test("commit_message hygiene: attribution rejected, body capped at 3 bullets", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "a.txt"), "v2");
  sh(repo, "add", "a.txt");
  const co = await call("commit_message", { repo, type: "fix", summary: "X", body: ["Co-authored-by: bot <b@x>"] });
  assert.equal(co.isError, true);
  const four = await call("commit_message", { repo, type: "fix", summary: "X", body: ["1", "2", "3", "4"] });
  assert.equal(four.isError, true);
  const clean = makeRepo();
  commitFile(clean, "only.txt", "clean tree");
  const none = await call("commit_message", { repo: clean, type: "fix", summary: "Nothing to describe" });
  assert.equal(none.isError, true); // clean tree, nothing staged/unstaged
});

test("commit_message reads repo instructions and history sample as context only", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "v1");
  writeFileSync(join(repo, "AGENTS.md"), "# instructions\ncommit style: whatever\n");
  writeFileSync(join(repo, "a.txt"), "v2");
  const r = await call("commit_message", { repo, type: "refactor", summary: "Split runner seam" });
  assert.ok(sc(r).repoInstructionFiles.includes("AGENTS.md"));
  assert.ok(Array.isArray(sc(r).historySample) && sc(r).historySample.length >= 1);
  assert.match(sc(r).historyConvention, /no dominant conventional-commits pattern/);
});

// ── repo_status doctor ────────────────────────────────────────────────────

test("repo_status: git presence + install hints, gh listed as unused, policy summary", async () => {
  const r = await call("repo_status", {});
  const s = sc(r);
  assert.equal(s.git.present, true);
  assert.match(r.content[0].text, /git: ok:/);
  assert.equal(s.gh.usedByTools, false);
  assert.match(s.gh.installHint, /brew install gh/);
  assert.equal(s.policy.pull, "--ff-only");
  assert.equal(s.policy.pushTool, "absent");
  assert.equal(s.policy.approvalTtlSeconds, 300);
  assert.match(r.content[0].text, /trust boundary/i);
  assert.ok(!r.content[0].text.includes(process.env.GIT_AUTHOR_EMAIL));
});
