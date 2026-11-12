import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryPayload,
  grafanaApiUrl,
  grafanaFetch,
} from "../dist/grafana.js";
import {
  countResults,
  extractRawFrameInfo,
  formatResults,
  formatSeverity,
  formatTimestamp,
} from "../dist/format.js";
import { loadConfig } from "../dist/config.js";

const payload = {
  results: {
    A: {
      frames: [
        {
          schema: { fields: [{ name: "timestamp", type: "time" }, { name: "severity", type: "string" }, { name: "serviceName", type: "string" }, { name: "body", type: "string" }] },
          data: { values: [[1760000000000], ["ERROR"], ["svc-a"], ["boom"]] },
        },
      ],
    },
  },
};

test("formatSeverity maps levels to emoji", () => {
  assert.equal(formatSeverity("ERROR"), "🔴");
  assert.equal(formatSeverity("Warn"), "🟡");
  assert.equal(formatSeverity("INFO"), "ℹ️");
  assert.equal(formatSeverity("None"), "");
  assert.equal(formatSeverity("weird"), "[weird]");
});

test("formatTimestamp parses epoch ms", () => {
  assert.match(formatTimestamp("1760000000000"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTimestamp("None"), "");
  assert.equal(formatTimestamp("2026-11-11T12:34:56.789Z"), "2026-11-11 12:34:56");
  assert.equal(formatTimestamp("2026-11-11T14:34:56+02:00"), "2026-11-11 12:34:56");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
  assert.equal(formatTimestamp("1760000000000garbage"), "1760000000000garbage");
});

test("formatResults renders entries", () => {
  const out = formatResults(payload);
  assert.ok(out.includes("1 log entries"));
  assert.ok(out.includes("[svc-a]"));
  assert.ok(out.includes("boom"));
  assert.ok(out.includes("🔴"));
});

test("countResults and extractRawFrameInfo", () => {
  assert.equal(countResults(payload), 1);
  assert.match(extractRawFrameInfo(payload), /Available fields \(A\): timestamp, severity, serviceName, body/);
});

test("grafanaApiUrl keeps raw requests on the configured API origin", () => {
  assert.equal(
    grafanaApiUrl("https://grafana.example/base/", "/api/datasources"),
    "https://grafana.example/base/api/datasources",
  );
  assert.throws(() => grafanaApiUrl("https://grafana.example", "@attacker.example/path"), /relative|\/api/);
  assert.throws(() => grafanaApiUrl("https://grafana.example", "//attacker.example/api"), /\/api/);
  assert.throws(() => grafanaApiUrl("https://grafana.example", "https://attacker.example/api"), /\/api/);
  assert.throws(() => grafanaApiUrl("https://grafana.example", "/admin/users"), /\/api/);
  for (const endpoint of ["/api/../admin", "/api/%2e%2e/admin", "/api/..\\admin"]) {
    assert.throws(() => grafanaApiUrl("https://grafana.example/base", endpoint), /\/api/);
  }
  assert.throws(
    // Bare host so the fixture itself does not shape-match an e-mail address;
    // the guard is about userinfo, not about the domain.
    () => grafanaApiUrl("https://user:secret@grafana", "/api/datasources"),
    /embedded credentials/,
  );
});

test("grafanaFetch fixes redirect policy and preserves cancellation", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "error");
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new TypeError("dummy fetch failure");
  });
  await assert.rejects(
    grafanaFetch("https://grafana.example/api/test", { method: "POST" }, controller.signal),
    /request failed/,
  );
});

test("grafanaFetch attaches optional auth on HTTPS and preserves other headers", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls.push(new Headers(options.headers));
    return new Response("ok");
  });
  await grafanaFetch("https://grafana.example/api/test", {
    method: "POST", authHeader: "Bearer test-token", headers: { Accept: "application/json" },
  });
  assert.equal(calls[0].get("Authorization"), "Bearer test-token");
  assert.equal(calls[0].get("Accept"), "application/json");
  await grafanaFetch("http://grafana.example/api/test");
  assert.equal(calls[1].has("Authorization"), false);
});

test("grafanaFetch refuses credentials over HTTP before making any request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("unexpected"); });
  for (const options of [
    { authHeader: "Bearer dummy-secret" },
    { headers: { authorization: "Bearer dummy-secret" } },
  ]) {
    await assert.rejects(grafanaFetch("http://grafana.example/api/test", options), /HTTPS/);
  }
  assert.equal(calls, 0);
});

test("grafanaFetch never exposes a malformed credential or a fetch exception", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("echoed dummy-secret"); });
  for (const authHeader of ["Bearer dummy-secret", "Bearer dummy-secret\nwrapped"]) {
    await assert.rejects(grafanaFetch("https://grafana.example/api/test", { authHeader }), (error) => {
      assert.ok(!error.message.includes("dummy-secret"));
      return true;
    });
  }
});

test("counts all successful frames and queries, matching the formatted header", () => {
  const frame = (count) => ({ schema: { fields: [{ name: "body", type: "string" }] },
    data: { values: [Array.from({ length: count }, (_,i) => `row-${i}`)] } });
  const data = { results: {
    A: { frames: [frame(2), frame(3)] },
    B: { frames: [frame(1)] },
    C: { status: 500, frames: [frame(8)] },
  } };
  assert.equal(countResults(data), 6);
  assert.match(formatResults(data), /6 log entries/);
  assert.equal(countResults({ results: {} }), 0);
  assert.equal(countResults(null), 0);
});

test("buildQueryPayload shape", () => {
  const p = buildQueryPayload('serviceName:"x"', "quickwit-quickwit-datasource", "UID", "now-1h", 50);
  assert.equal(p.queries[0]?.datasource.uid, "UID");
  assert.equal(p.queries[0]?.query, 'serviceName:"x"');
  assert.equal(p.from, "now-1h");
  assert.equal(p.to, "now");
  assert.deepEqual(p.queries[0]?.metrics, [{ id: "3", type: "logs" }]);
});

test("malformed responses surface the parse-error path like the source", () => {
  // Source parity: non-object payloads and malformed frames reached the
  // ⚠️ Error parsing results path (via TypeError in the source).
  assert.match(formatResults(null), /Error parsing results/);
  assert.match(formatResults(undefined), /Error parsing results/);
  const nullColumn = { results: { A: { frames: [{ schema: { fields: [{ name: "a", type: "string" }] }, data: { values: [null] } }] } } };
  assert.match(formatResults(nullColumn), /Error parsing results/);
  // An object without a results object is still rendered as JSON, not an error.
  assert.equal(formatResults({}), "{}");
});

test("loadConfig trims the URL and defaults the datasource type", () => {
  const config = loadConfig({
    GRAFANA_URL: "https://grafana.example.net///",
    GRAFANA_DATASOURCE_UID: "uid-1",
  });
  assert.equal(config.url, "https://grafana.example.net");
  assert.equal(config.datasourceUid, "uid-1");
  assert.equal(config.datasourceType, "quickwit-quickwit-datasource");

  const typed = loadConfig({
    GRAFANA_URL: "https://grafana.example.net",
    GRAFANA_DATASOURCE_UID: "uid-1",
    GRAFANA_DATASOURCE_TYPE: "other-datasource",
  });
  assert.equal(typed.datasourceType, "other-datasource");

  const withToken = loadConfig({
    GRAFANA_URL: "https://grafana.example.net",
    GRAFANA_DATASOURCE_UID: "uid-1",
    GRAFANA_API_TOKEN: "  test-token  ",
  });
  assert.equal(withToken.authHeader, "Bearer test-token");

  const withoutToken = loadConfig({
    GRAFANA_URL: "https://grafana.example.net",
    GRAFANA_DATASOURCE_UID: "uid-1",
  });
  assert.equal(withoutToken.authHeader, undefined);
  assert.equal(loadConfig({ GRAFANA_URL: "https://grafana.example", GRAFANA_DATASOURCE_UID: "example",
    GRAFANA_API_TOKEN: "   " }).authHeader, undefined);
  for (const token of ["dummy-secret\nwrapped", "dummy-secret\rwrapped", "dummy secret", "dummy\u0001secret"]) {
    assert.throws(() => loadConfig({ GRAFANA_URL: "https://grafana.example", GRAFANA_DATASOURCE_UID: "example",
      GRAFANA_API_TOKEN: token }), (error) => {
      assert.match(error.message, /GRAFANA_API_TOKEN/);
      assert.ok(!error.message.includes("dummy"));
      return true;
    });
  }
  assert.throws(() => loadConfig({ GRAFANA_URL: "http://grafana.example", GRAFANA_DATASOURCE_UID: "example",
    GRAFANA_API_TOKEN: "dummy-secret" }), /HTTPS/);

  assert.throws(() => loadConfig({}), /GRAFANA_URL and GRAFANA_DATASOURCE_UID must be set/);
});
