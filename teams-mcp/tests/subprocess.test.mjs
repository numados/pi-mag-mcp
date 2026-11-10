/**
 * Subprocess layer: argv-only execution, secret-free child environment,
 * bounded output, timeout and cancellation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, sanitizedEnv, SubprocessError } from "../dist/subprocess.js";

const node = process.execPath;

test("arguments are passed literally, never through a shell", async () => {
  const dangerous = "a; rm -rf /tmp/office-mcp-should-not-exist $(id) `id`";
  const { stdout } = await runCommand(node, ["-e", "console.log(process.argv[1])", dangerous], { timeoutMs: 10_000 });
  assert.equal(stdout.trim(), dangerous);
});

test("the child environment is an allowlist, not an inheritance", async () => {
  const env = sanitizedEnv({ PATH: "/usr/bin", HOME: "/tmp", CONFLUENCE_API_TOKEN: "secret", TEAMS_ACCESS_TOKEN: "secret" });
  assert.equal(env.CONFLUENCE_API_TOKEN, undefined);
  assert.equal(env.TEAMS_ACCESS_TOKEN, undefined);

  const { stdout } = await runCommand(
    node,
    ["-e", "console.log(process.env.CONFLUENCE_API_TOKEN ?? 'absent', process.env.TEAMS_ACCESS_TOKEN ?? 'absent')"],
    { timeoutMs: 10_000, env },
  );
  assert.equal(stdout.trim(), "absent absent");
});

test("a missing executable is reported as not-found", async () => {
  await assert.rejects(
    () => runCommand("definitely-not-a-real-binary-xyz", [], { timeoutMs: 5_000 }),
    (error) => error instanceof SubprocessError && error.kind === "not-found",
  );
});

test("a non-zero exit carries a bounded stderr tail", async () => {
  await assert.rejects(
    () => runCommand(node, ["-e", "console.error('boom'); process.exit(3)"], { timeoutMs: 10_000 }),
    (error) => error instanceof SubprocessError && error.kind === "exit" && /boom/.test(error.stderr),
  );
});

test("a timeout kills the process instead of waiting for it", async () => {
  const started = Date.now();
  await assert.rejects(
    () => runCommand(node, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 300 }),
    (error) => error instanceof SubprocessError && error.kind === "timeout",
  );
  assert.ok(Date.now() - started < 10_000, "the call returned after the timeout, not after the child finished");
});

test("cancellation is reported as cancelled", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => runCommand(node, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 30_000, signal: controller.signal }),
    (error) => error instanceof SubprocessError && error.kind === "cancelled",
  );
});

test("stdout larger than the budget aborts the call", async () => {
  await assert.rejects(
    () => runCommand(node, ["-e", "process.stdout.write('x'.repeat(200000))"], { timeoutMs: 15_000, maxOutputBytes: 1_000 }),
    (error) => error instanceof SubprocessError && error.kind === "output-overflow",
  );
});
