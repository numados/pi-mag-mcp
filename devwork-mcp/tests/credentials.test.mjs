/**
 * Credential resolution: an installation uses its own secret, and ambient CLI
 * logins are unreachable unless the profile opts in. These are the tests that
 * keep two companies from sharing one identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialResolver, resolveReference } from "../dist/credentials.js";

function installation(overrides = {}) {
  return {
    id: "example-service",
    source: "/tmp/profile.json",
    defaultBackend: "github",
    github: { apiBase: "https://api.github.com", repositories: ["acme/service-x"], auth: "token", ...overrides.github },
    jira: { projects: [], auth: "off", ...overrides.jira },
    ado: { projects: [], requestTimeoutMs: 30_000, auth: "off", ...overrides.ado },
    write: { policy: "read-only", requirePreview: true },
    cacheTtlSeconds: 60,
    top: 20,
  };
}

function fakeRun(answers) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      const answer = answers[`${command} ${args.join(" ")}`];
      if (answer === undefined) throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      return answer;
    },
  };
}

test("env: references resolve through the environment and nothing else", () => {
  assert.deepEqual(resolveReference("env:ACME_TOKEN", { ACME_TOKEN: "secret" }), { value: "secret" });
  assert.deepEqual(resolveReference("env:ACME_TOKEN", {}), { missing: "ACME_TOKEN" });
  assert.deepEqual(resolveReference("literal", {}), { value: "literal" });
  assert.deepEqual(resolveReference(undefined, {}), {});
});

test("the installation token wins and is marked as such", async () => {
  const resolver = new CredentialResolver(installation({ github: { token: "env:ACME_TOKEN" } }), { ACME_TOKEN: "secret" });
  const credential = await resolver.github();
  assert.equal(credential.mode, "token");
  assert.equal(credential.token, "secret");
  assert.match(credential.source, /installation token/);
});

test("a missing token reference does not fall back to the machine login", async () => {
  const fake = fakeRun({});
  const resolver = new CredentialResolver(installation({ github: { token: "env:ACME_TOKEN" } }), {}, { run: fake.run });
  const credential = await resolver.github();
  assert.equal(credential.mode, "none");
  assert.equal(credential.token, undefined);
  assert.equal(fake.calls.length, 0, "`gh auth token` must never run without auth:ambient");
  assert.ok(credential.notes.some((note) => /ACME_TOKEN is unset/.test(note)));
  assert.ok(credential.notes.some((note) => /github\.auth:"ambient"/.test(note)));
});

test("ambient mode may use GH_TOKEN, and records where it came from", async () => {
  const resolver = new CredentialResolver(installation({ github: { auth: "ambient" } }), { GH_TOKEN: "ambient-token" });
  const credential = await resolver.github();
  assert.equal(credential.mode, "ambient");
  assert.equal(credential.source, "ambient GH_TOKEN");
});

test("ambient mode falls back to the gh CLI and caches the token", async () => {
  const fake = fakeRun({ "gh auth token": "cli-token\n" });
  const resolver = new CredentialResolver(installation({ github: { auth: "ambient" } }), {}, { run: fake.run });
  assert.equal((await resolver.github()).token, "cli-token");
  assert.equal((await resolver.github()).token, "cli-token");
  assert.equal(fake.calls.length, 1, "one CLI call per resolver instance");
});

test("Jira needs domain, email and token together", async () => {
  const incomplete = new CredentialResolver(installation({ jira: { domain: "https://example.atlassian.net", auth: "token" } }), {});
  const missing = incomplete.jira();
  assert.equal(missing.mode, "none");
  assert.ok(missing.notes.some((note) => /incomplete/.test(note)));

  const complete = new CredentialResolver(
    installation({ jira: { domain: "https://example.atlassian.net", email: "dev-login", token: "env:JIRA_TOKEN", projects: ["ABC"], auth: "token" } }),
    { JIRA_TOKEN: "jira-secret" },
  );
  const ok = complete.jira();
  assert.equal(ok.mode, "token");
  assert.equal(ok.email, "dev-login");
  assert.equal(ok.token, "jira-secret");
  assert.equal(ok.domain, "https://example.atlassian.net");
});

test("ADO PAT becomes a basic header; ambient az needs an explicit opt-in", async () => {
  const pat = new CredentialResolver(installation({ ado: { pat: "env:ADO_PAT", org: "https://dev.azure.com/acme", projects: ["Service X"], auth: "token" } }), {
    ADO_PAT: "pat-value",
  });
  const withPat = await pat.ado();
  assert.equal(withPat.mode, "token");
  assert.equal(withPat.header, `Basic ${Buffer.from(":pat-value").toString("base64")}`);

  const fake = fakeRun({});
  const isolated = new CredentialResolver(
    installation({ ado: { org: "https://dev.azure.com/acme", projects: ["Service X"], auth: "token" } }),
    {},
    { run: fake.run },
  );
  const refused = await isolated.ado();
  assert.equal(refused.mode, "none");
  assert.equal(fake.calls.length, 0, "`az` must not be asked without auth:ambient");

  const ambientRun = fakeRun({
    "az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken --output tsv": "aad-token\n",
  });
  const ambient = new CredentialResolver(
    installation({ ado: { org: "https://dev.azure.com/acme", projects: ["Service X"], auth: "ambient" } }),
    {},
    { run: ambientRun.run },
  );
  const withAz = await ambient.ado();
  assert.equal(withAz.mode, "ambient");
  assert.equal(withAz.header, "Bearer aad-token");
});

test("a disabled backend resolves to none without a note about credentials", async () => {
  const resolver = new CredentialResolver(installation({ github: { auth: "off" } }), {});
  const credential = await resolver.github();
  assert.equal(credential.mode, "none");
  assert.match(credential.source, /auth:off/);
  assert.deepEqual(credential.notes, []);
});
