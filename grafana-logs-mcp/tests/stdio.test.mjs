import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

const serverUrl = new URL("../dist/server.js", import.meta.url).href;
const baseEnv = { GRAFANA_URL: "https://grafana.example", GRAFANA_DATASOURCE_UID: "example", GRAFANA_API_TOKEN: "dummy-secret" };
const calls = [
  ["grafana_logs_query", { query: "*" }],
  ["grafana_logs_raw", { method: "GET", endpoint: "/api/test" }],
];

/** JSON-RPC harness independent of the optional Pi client. All fetches are fake. */
async function startServer(t, env, fetchSource) {
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `globalThis.fetch = ${fetchSource}; await import(${JSON.stringify(serverUrl)});`], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => { stderr += text; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    buffer += text;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  function fail(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  child.on("error", fail);
  child.on("exit", () => fail(new Error("stdio server exited before its response")));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 5_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { call: (name, args) => rpc("tools/call", { name, arguments: args }), stderr: () => stderr };
}

test("both tools reject invalid auth configuration without leaking secrets or making a request", async (t) => {
  for (const overrides of [
    { GRAFANA_API_TOKEN: "dummy-secret\nwrapped" },
    { GRAFANA_URL: "http://grafana.example" },
    { GRAFANA_URL: "https://example-user:dummy-password@grafana" },
  ]) {
    const server = await startServer(t, { ...baseEnv, ...overrides },
      'async () => { console.error("UNEXPECTED_FETCH"); return new Response("unexpected"); }');
    for (const [name, args] of calls) {
      const result = await server.call(name, args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /configuration is unavailable/);
      for (const secret of ["dummy-secret", "dummy-password", "example-user"]) {
        assert.ok(!JSON.stringify(result).includes(secret));
        assert.ok(!server.stderr().includes(secret));
      }
    }
    assert.ok(!server.stderr().includes("UNEXPECTED_FETCH"));
  }
});

test("both tools mask credential-bearing fetch exceptions", async (t) => {
  const server = await startServer(t, baseEnv,
    'async () => { throw new TypeError("Bearer " + process.env.GRAFANA_API_TOKEN); }');
  for (const [name, args] of calls) {
    const result = await server.call(name, args);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(baseEnv.GRAFANA_API_TOKEN));
    assert.ok(!server.stderr().includes(baseEnv.GRAFANA_API_TOKEN));
  }
});

test("both tools send bearer auth over HTTPS; query output sums frames and formats ISO dates", async (t) => {
  const server = await startServer(t, baseEnv, `async (url, options) => {
    if (new URL(url).protocol !== "https:" || new Headers(options.headers).get("Authorization") !== "Bearer dummy-secret") {
      return new Response("auth failed", { status: 401 });
    }
    if (options.method === "GET") return new Response(JSON.stringify({ authorized: true }));
    const frame = (n) => ({ schema: { fields: [{ name: "timestamp", type: "time" }, { name: "body", type: "string" }] },
      data: { values: [Array(n).fill("2026-11-11T12:34:56Z"), Array(n).fill("dummy log")] } });
    return new Response(JSON.stringify({ results: { A: { frames: [frame(2), frame(3)] } } }));
  }`);
  const query = await server.call(...calls[0]);
  assert.notEqual(query.isError, true);
  assert.equal(query.structuredContent.rowCount, 5);
  assert.match(query.content[0].text, /5 log entries/);
  assert.match(query.content[0].text, /2026-11-11 12:34:56/);
  const raw = await server.call(...calls[1]);
  assert.notEqual(raw.isError, true);
  assert.equal(raw.structuredContent.status, 200);
  assert.match(raw.content[0].text, /"authorized": true/);
});
