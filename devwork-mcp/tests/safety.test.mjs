/**
 * Write safety: the policy gate and the preview binding. The binding is what
 * stops "preview a title change, confirm a merge": a confirm must match the
 * previewed arguments, within the time limit, exactly once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviewStore, fingerprintArgs, operationArguments, requiredOperations, runWrite, writeGate } from "../dist/safety.js";

function installation(write = { policy: "read-write" }) {
  return {
    id: "example-service",
    source: "/tmp/profile.json",
    defaultBackend: "github",
    github: { apiBase: "https://api.github.com", repositories: ["acme/service-x"], auth: "token" },
    jira: { projects: [], auth: "off" },
    ado: { projects: [], requestTimeoutMs: 30_000, auth: "off" },
    write: { requirePreview: true, ...write },
    cacheTtlSeconds: 60,
    top: 20,
  };
}

test("the fingerprint ignores the approval plumbing and key order", () => {
  const a = fingerprintArgs({ ref: "7", title: "x", confirm: true, approvalToken: "t" });
  const b = fingerprintArgs({ title: "x", ref: "7" });
  const c = fingerprintArgs({ ref: "7", title: "y" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.deepEqual(operationArguments({ ref: "7", confirm: true, approvalToken: "t", skip: undefined }), { ref: "7" });
});

test("operation classes follow the call, and merge is its own class", () => {
  assert.deepEqual(requiredOperations("devwork_update", { ref: "1" }), ["update"]);
  assert.deepEqual(requiredOperations("devwork_update", { ref: "1", comment: "hi" }).sort(), ["comment"]);
  assert.deepEqual(requiredOperations("devwork_update", { ref: "1", title: "t", comment: "hi" }).sort(), ["comment", "update"]);
  assert.deepEqual(requiredOperations("devwork_pr_update", { ref: "1", status: "active" }), ["pr"]);
  assert.deepEqual(requiredOperations("devwork_pr_update", { ref: "1", status: "completed" }).sort(), ["merge", "pr"]);
  assert.deepEqual(requiredOperations("devwork_pr_vote", { ref: "1", vote: "approve" }), ["vote"]);
});

test("a read-only installation refuses every write with the reason", () => {
  const gate = writeGate(installation({ policy: "read-only" }), ["create"]);
  assert.match(gate, /write\.policy is "read-only"/);
});

test("read-write does not silently allow merge", () => {
  const gate = writeGate(installation(), ["pr", "merge"]);
  assert.match(gate, /operation merge is not allowed/);
  assert.match(gate, /write\.allow is \[create, update, comment, pr, vote\]/);
  assert.equal(writeGate(installation({ allow: ["merge"] }), ["merge"]), null);
});

test("a preview is returned and nothing executes", async () => {
  const store = new PreviewStore();
  let executed = 0;
  const outcome = await runWrite({
    installation: installation({ allow: ["pr", "merge"] }),
    store,
    tool: "devwork_pr_update",
    args: { ref: "7", status: "completed" },
    required: requiredOperations("devwork_pr_update", { status: "completed" }),
    preview: async () => ({ human: "merge PR #7", data: { op: "merge" } }),
    execute: async () => {
      executed += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(executed, 0);
  assert.equal(outcome.isError, undefined);
  assert.equal(outcome.structuredContent.requiresConfirmation, true);
  assert.match(outcome.structuredContent.approvalToken, /^[0-9a-f-]{36}$/);
  assert.equal(outcome.structuredContent.preview.op, "merge");
  assert.match(outcome.content[0].text, /PREVIEW — nothing was executed/);
});

test("confirming the previewed arguments executes exactly once", async () => {
  const store = new PreviewStore();
  const installationConfig = installation();
  const flow = (args) => ({
    installation: installationConfig,
    store,
    tool: "devwork_create",
    args,
    required: ["create"],
    preview: async () => ({ human: "create", data: {} }),
    execute: async () => ({ content: [{ type: "text", text: "created" }] }),
  });

  const previewed = await runWrite(flow({ type: "Task", title: "x" }));
  const token = previewed.structuredContent.approvalToken;

  const first = await runWrite(flow({ type: "Task", title: "x", confirm: true, approvalToken: token }));
  assert.equal(first.content[0].text, "created");

  const replay = await runWrite(flow({ type: "Task", title: "x", confirm: true, approvalToken: token }));
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /no matching preview/);
});

test("changed arguments cannot ride an old preview", async () => {
  const store = new PreviewStore();
  const installationConfig = installation();
  let executed = 0;
  const flow = (args) => ({
    installation: installationConfig,
    store,
    tool: "devwork_pr_update",
    args,
    required: ["pr"],
    preview: async () => ({ human: "update", data: {} }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "done" }] };
    },
  });

  const previewed = await runWrite(flow({ ref: "7", title: "safe title" }));
  const refused = await runWrite(flow({ ref: "7", title: "safe title", status: "completed", confirm: true, approvalToken: previewed.structuredContent.approvalToken }));
  assert.equal(executed, 0, "a merge hiding behind a title preview must not run");
  assert.match(refused.content[0].text, /no matching preview/);
});

test("a mismatched token is refused", async () => {
  const store = new PreviewStore();
  const installationConfig = installation();
  const flow = (args) => ({
    installation: installationConfig,
    store,
    tool: "devwork_create",
    args,
    required: ["create"],
    preview: async () => ({ human: "create", data: {} }),
    execute: async () => ({ content: [{ type: "text", text: "created" }] }),
  });
  await runWrite(flow({ type: "Task", title: "x" }));
  const outcome = await runWrite(flow({ type: "Task", title: "x", confirm: true, approvalToken: "not-the-token" }));
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /does not match/);
});

test("a confirm without the approval token is refused", async () => {
  const store = new PreviewStore();
  const installationConfig = installation();
  let executed = 0;
  const flow = (args) => ({
    installation: installationConfig,
    store,
    tool: "devwork_create",
    args,
    required: ["create"],
    preview: async () => ({ human: "create", data: {} }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "created" }] };
    },
  });
  await runWrite(flow({ type: "Task", title: "x" }));
  const outcome = await runWrite(flow({ type: "Task", title: "x", confirm: true }));
  assert.equal(executed, 0, "the token is part of the contract, not a decoration");
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /approvalToken is required/);
});

test("an expired preview cannot be confirmed", async () => {
  let now = 1_000_000;
  const store = new PreviewStore(() => now);
  const installationConfig = installation();
  const flow = (args, ttl) => ({
    installation: installationConfig,
    store,
    tool: "devwork_create",
    args,
    required: ["create"],
    preview: async () => ({ human: "create", data: {} }),
    execute: async () => ({ content: [{ type: "text", text: "created" }] }),
  });
  await runWrite(flow({ type: "Task", title: "x" }));
  now += 601_000;
  const outcome = await runWrite(flow({ type: "Task", title: "x", confirm: true }));
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /no matching preview/);
  assert.equal(store.size(), 0, "expired records are evicted");
});

test("ADO auto-complete is gated as a merge", () => {
  assert.deepEqual(requiredOperations("devwork_pr_create", { repository: "r", autoComplete: true }).sort(), ["merge", "pr"]);
  assert.deepEqual(requiredOperations("devwork_pr_update", { ref: "1", autoComplete: true }).sort(), ["merge", "pr"]);
  assert.deepEqual(requiredOperations("devwork_pr_create", { repository: "r" }), ["pr"], "a plain PR needs no merge right");
});

test("requirePreview:false restores the plain confirm:true shape", async () => {
  const store = new PreviewStore();
  let executed = 0;
  const outcome = await runWrite({
    installation: installation({ requirePreview: false }),
    store,
    tool: "devwork_create",
    args: { type: "Task", title: "x", confirm: true },
    required: ["create"],
    preview: async () => ({ human: "create", data: {} }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "created" }] };
    },
  });
  assert.equal(executed, 1);
  assert.equal(outcome.isError, undefined);
});

test("the policy gate runs before the preview is built", async () => {
  const outcome = await runWrite({
    installation: installation({ policy: "read-only" }),
    store: new PreviewStore(),
    tool: "devwork_create",
    args: { type: "Task", title: "x" },
    required: ["create"],
    preview: async () => {
      throw new Error("preview must not run when writes are disabled");
    },
    execute: async () => ({ content: [{ type: "text", text: "created" }] }),
  });
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /writes are disabled/);
});

test("the previewed state is handed to the mutation", async () => {
  const store = new PreviewStore();
  const installationConfig = installation({ allow: ["pr", "merge"] });
  let received;
  const flow = (args) => ({
    installation: installationConfig,
    store,
    tool: "devwork_pr_update",
    args,
    required: ["pr", "merge"],
    preview: async () => ({ human: "merge", data: {}, guard: "head-abc" }),
    execute: async (guard) => {
      received = guard;
      return { content: [{ type: "text", text: "merged" }] };
    },
  });
  const previewed = await runWrite(flow({ ref: "7", status: "completed" }));
  const outcome = await runWrite(flow({ ref: "7", status: "completed", confirm: true, approvalToken: previewed.structuredContent.approvalToken }));
  assert.equal(outcome.content[0].text, "merged");
  assert.equal(received, "head-abc", "the merge receives the SHA the user approved");
});
