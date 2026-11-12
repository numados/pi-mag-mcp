import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { doctorReport } from "../dist/doctor.js";

const serverEntry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const baseEnv = { GRAFANA_URL: "https://grafana.example", GRAFANA_DATASOURCE_UID: "example-datasource" };

function runDoctor(env) {
  return spawnSync(process.execPath, [serverEntry, "--doctor"], {
    env, encoding: "utf8", timeout: 5_000,
  });
}

test("doctor runs without the Pi client or stdin and prints presence, not values", () => {
  const env = { ...baseEnv, GRAFANA_API_TOKEN: "dummy-secret", GRAFANA_DATASOURCE_TYPE: "example-type" };
  const result = runDoctor(env);
  assert.equal(result.status, 0, result.stderr);
  for (const name of Object.keys(env)) assert.ok(result.stdout.includes(`${name}: set`));
  for (const value of Object.values(env)) assert.ok(!result.stdout.includes(value));
  assert.equal(result.stderr, "");
});

test("doctor reports missing required config and optional credentials separately", () => {
  const result = runDoctor({});
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /GRAFANA_URL: missing/);
  assert.match(result.stdout, /GRAFANA_DATASOURCE_UID: missing/);
  assert.match(result.stdout, /GRAFANA_API_TOKEN: missing \(optional\)/);
  assert.equal(runDoctor(baseEnv).status, 0);
});

test("doctor uses the same token and URL validation as runtime without exposing values", () => {
  for (const overrides of [
    { GRAFANA_API_TOKEN: "dummy-secret\nwrapped" },
    { GRAFANA_API_TOKEN: "dummy-secret", GRAFANA_URL: "http://grafana.example" },
    { GRAFANA_URL: "not-a-url" },
    { GRAFANA_URL: "https://example-user:dummy-password@grafana" },
  ]) {
    const result = runDoctor({ ...baseEnv, ...overrides });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /configuration:/);
    for (const secret of ["dummy-secret", "dummy-password", "not-a-url", "example-user"]) {
      assert.ok(!(result.stdout + result.stderr).includes(secret));
    }
  }
  const report = doctorReport({ ...baseEnv, GRAFANA_API_TOKEN: "   " });
  assert.equal(report.ok, true);
  assert.match(report.text, /GRAFANA_API_TOKEN: missing/);
});
