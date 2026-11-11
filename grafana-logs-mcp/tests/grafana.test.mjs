import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("grafanaFetch refuses cross-origin redirects", async (t) => {
  let targetRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.end("unexpected");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    target.closeAllConnections?.();
    await new Promise((resolve) => target.close(resolve));
  });
  const targetAddress = target.address();

  const redirect = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/capture` });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    redirect.closeAllConnections?.();
    await new Promise((resolve) => redirect.close(resolve));
  });
  const redirectAddress = redirect.address();

  await assert.rejects(
    grafanaFetch(`http://127.0.0.1:${redirectAddress.port}/api/test`, { method: "POST", body: "sensitive" }),
    { name: "TypeError" },
  );
  assert.equal(targetRequests, 0);
});

test("grafanaFetch attaches the auth header only when configured", async (t) => {
  let seen = {};
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    seen = { authorization: req.headers.authorization };
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/test`;

  await grafanaFetch(url, { method: "POST", authHeader: "Bearer test-token" });
  assert.equal(requests, 1);
  assert.equal(seen.authorization, "Bearer test-token");

  await grafanaFetch(url, { method: "POST" });
  assert.equal(requests, 2);
  assert.equal(seen.authorization, undefined);
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

  assert.throws(() => loadConfig({}), /GRAFANA_URL and GRAFANA_DATASOURCE_UID must be set/);
});
