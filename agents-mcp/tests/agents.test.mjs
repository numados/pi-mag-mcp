/** agents-mcp unit tests, run against dist/ with a FAKE CLI injected via
 *  config (command: node …) — no real subscriptions are spent. The protocol
 *  layer is covered separately in pi-client.test.mjs over the real Pi
 *  client. Ported from agent-toolkit/mcp/agents-mcp at 7cdf230 with the
 *  builtin-alias hygiene removal carried through the fixtures. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_CONFIG, deepMerge, expandValue, loadEffectiveConfig, loadRepoContext,
} from "../dist/config.js";
import { runProcess } from "../dist/exec.js";
import { composeTask, cleanCodexOutput, parseFindings } from "../dist/modes.js";
import { resolveCall } from "../dist/adapters.js";
import { routeTask } from "../dist/route.js";
import { dispatch, setClassifier } from "../dist/tools.js";

const fixture = mkdtempSync(join(tmpdir(), "agents-mcp-test-"));
process.on("exit", () => rmSync(fixture, { recursive: true, force: true }));

// Hermetic: pin the global config to an empty file so tests assert built-in
// defaults instead of whatever the machine config contains.
const globalConfig = join(fixture, "global-config.json");
writeFileSync(globalConfig, "{}");
process.env.AGENTS_MCP_CONFIG = globalConfig;

/** Fake CLI: echoes stdin back inside OUT[...]. The trailing "--" ends
 *  node's own option parsing, so the adapter-appended CLI flags (-p --model …)
 *  land in process.argv instead of breaking node. */
const FAKE = `const c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>process.stdout.write("OUT["+c.join("")+"]"))`;

function fakeAlias() {
  return { command: process.execPath, args: ["-e", FAKE, "--"] };
}

function fakeConfig() {
  return {
    aliases: { fake: fakeAlias() },
    defaults: { claude: { alias: "fake", model: "fake-model", effort: "low" } },
  };
}

// ── config ────────────────────────────────────────────────────────────────

test("deepMerge: repo layer overrides per key, keeps others", () => {
  const merged = deepMerge(BUILTIN_CONFIG, { defaults: { claude: { alias: "example" } } });
  assert.equal(merged.defaults.claude.alias, "example");
  assert.equal(merged.defaults.claude.model, "claude-opus-4-8[1m]"); // kept
  assert.equal(merged.aliases.numados.command, "claude"); // kept
});

test("expandValue: ~, env:VAR, literal, missing env throws", () => {
  process.env.AGENTS_TEST_VAR = "secret-value";
  assert.equal(expandValue("~/x/y").endsWith("/x/y"), true);
  assert.equal(expandValue("env:AGENTS_TEST_VAR"), "secret-value");
  assert.equal(expandValue("literal"), "literal");
  delete process.env.AGENTS_TEST_VAR;
  assert.throws(() => expandValue("env:AGENTS_TEST_VAR"), /not set/);
});

test("loadRepoContext: walks up to .agents-mcp.json at repo root", () => {
  const repo = join(fixture, "repo");
  const nested = join(repo, "a", "b");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(repo, ".agents-mcp.json"), JSON.stringify({ defaults: { claude: { alias: "example" } } }));
  const ctx = loadRepoContext(nested);
  assert.equal(ctx.repoRoot, repo);
  assert.equal(ctx.config.defaults?.claude?.alias, "example");
});

test("loadEffectiveConfig: repo default alias and agy model win over global", () => {
  const repo = join(fixture, "repo2");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".agents-mcp.json"), JSON.stringify({
    defaults: { claude: { alias: "work" } },
    agents: { agy: { model: "example-4-argon" } },
  }));
  const eff = loadEffectiveConfig(repo);
  const spec = resolveCall({ mode: "opinion", agent: "claude", task: "t" }, eff);
  assert.equal(spec.meta.alias, "work");
  assert.equal(spec.meta.model, "claude-opus-4-5"); // alias pin beats defaults
  const agy = resolveCall({ mode: "opinion", agent: "agy", task: "t" }, eff);
  assert.equal(agy.meta.model, "example-4-argon");
});

// ── adapters (built-in config, no repo file) ──────────────────────────────

const eff = loadEffectiveConfig(fixture);

test("claude/cc: exact argv, task on stdin, no env changes", () => {
  const spec = resolveCall({ mode: "opinion", agent: "claude", alias: "cc", task: "hello" }, eff);
  assert.equal(spec.command, "claude");
  assert.deepEqual(spec.args, ["-p", "--model", "claude-opus-4-8[1m]", "--effort", "high"]);
  assert.ok(spec.stdin.startsWith("SAFETY RULES:"));
  assert.ok(spec.stdin.includes("TASK:\nhello"));
  assert.deepEqual(spec.envSet, {});
  assert.deepEqual(spec.envClear, []);
});

test("claude alias env: ~ values expand at resolution time", async () => {
  const cfgPath = join(fixture, "env-alias-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    aliases: { envtest: { command: "claude", env: { EXAMPLE_CONFIG_DIR: "~/agents-example" } } },
    defaults: { claude: { alias: "envtest" } },
  }));
  const prev = process.env.AGENTS_MCP_CONFIG;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  try {
    const spec = resolveCall({ mode: "research", agent: "claude", task: "t" }, loadEffectiveConfig(fixture));
    assert.ok(spec.envSet.EXAMPLE_CONFIG_DIR.endsWith("agents-example"));
  } finally {
    if (prev === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prev;
  }
});

test("claude/numados (default alias): skip-permissions arg + envClear + effort pin", () => {
  const spec = resolveCall({ mode: "research", agent: "claude", task: "t" }, eff);
  assert.equal(spec.meta.alias, "numados");
  assert.equal(spec.args[0], "--dangerously-skip-permissions");
  assert.ok(spec.envClear.includes("ANTHROPIC_BASE_URL"));
  assert.equal(spec.meta.effort, "low"); // alias pin beats global default high
});

test("claude: request overrides > alias pin > defaults", () => {
  const spec = resolveCall({ mode: "opinion", agent: "claude", alias: "numados", model: "claude-sonnet-4-5", effort: "medium", task: "t" }, eff);
  assert.equal(spec.meta.model, "claude-sonnet-4-5");
  assert.equal(spec.meta.effort, "medium");
  assert.deepEqual(spec.args, ["--dangerously-skip-permissions", "-p", "--model", "claude-sonnet-4-5", "--effort", "medium"]);
});

test("codex: argv + sandbox follows effort", () => {
  const low = resolveCall({ mode: "research", agent: "codex", task: "t" }, eff);
  assert.equal(low.meta.sandbox, "read-only");
  assert.deepEqual(low.args, ["--sandbox", "read-only", "--ask-for-approval", "never", "exec", "--skip-git-repo-check", "-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="low"', "--ephemeral"]);
  const high = resolveCall({ mode: "review", agent: "codex", effort: "high", task: "t" }, eff);
  assert.equal(high.meta.sandbox, "workspace-write");
});

test("agy: default and selectable model, task LAST arg, add-dir cwd, extra_dirs", () => {
  const spec = resolveCall({ mode: "research", agent: "agy", task: "do things", extra_dirs: ["/tmp/extra"] }, eff);
  assert.equal(spec.command, "agy");
  assert.deepEqual(spec.args.slice(0, 6), ["--model", "Gemini 3.8 Flash (High)", "--add-dir", process.cwd(), "--add-dir", "/tmp/extra"]);
  const custom = resolveCall({ mode: "research", agent: "agy", model: "example-4-argon", task: "use argon" }, eff);
  assert.equal(custom.meta.model, "example-4-argon");
  assert.equal(custom.args[1], "example-4-argon");
  const prompt = spec.args[spec.args.length - 1];
  assert.ok(prompt.includes("TASK:\ndo things"), "prompt must be the last arg");
  assert.ok(spec.args.includes("--print"));
  assert.equal(spec.stdin, "");
});

test("errors: unknown alias/agent/mode/effort, agy effort, extra_dirs scope, empty task", () => {
  assert.throws(() => resolveCall({ mode: "opinion", agent: "claude", alias: "nope", task: "t" }, eff), /unknown claude alias "nope"/);
  assert.throws(() => resolveCall({ mode: "opinion", agent: "gpt", task: "t" }, eff), /unknown agent "gpt"/);
  assert.throws(() => resolveCall({ mode: "guess", agent: "codex", task: "t" }, eff), /unknown mode "guess"/);
  assert.throws(() => resolveCall({ mode: "opinion", agent: "codex", effort: "xhigh", task: "t" }, eff), /unknown effort "xhigh"/);
  assert.throws(() => resolveCall({ mode: "opinion", agent: "agy", effort: "low", task: "t" }, eff), /no effort parameter/);
  assert.throws(() => resolveCall({ mode: "opinion", agent: "claude", task: "t", extra_dirs: ["/x"] }, eff), /extra_dirs is supported for agy only/);
  assert.throws(() => resolveCall({ mode: "opinion", agent: "claude", task: "  " }, eff), /task is required/);
});

// ── modes ─────────────────────────────────────────────────────────────────

test("composeTask: safety rules + mode instruction + task", () => {
  const p = composeTask("review", "check X");
  assert.ok(p.startsWith("SAFETY RULES:"));
  assert.ok(p.includes("MODE: review"));
  assert.ok(p.includes("NO FINDINGS"));
  assert.ok(p.endsWith("TASK:\ncheck X"));
});

test("cleanCodexOutput: fence unwrap + token footer cutoff", () => {
  assert.equal(cleanCodexOutput("```\nreal answer\n```\n---\n42 tokens used"), "real answer");
  assert.equal(cleanCodexOutput("plain\n---\n**Tokens used: 12**"), "plain");
  assert.equal(cleanCodexOutput("untouched"), "untouched");
});

test("parseFindings: bullets, severity map, em-dash and -- splits", () => {
  const f = parseFindings(
    "intro\n- [critical] src/a.ts:12 — null deref — x.foo() when x undefined\n- [minor] src/b.ts:3 -- dead code\n- not a finding\n- [weird] shape mismatch ignored\n",
  );
  assert.equal(f.length, 2);
  assert.equal(f[0].severity, "blocker"); // critical → blocker
  assert.equal(f[0].location, "src/a.ts:12");
  assert.equal(f[0].issue, "null deref");
  assert.equal(f[0].evidence, "x.foo() when x undefined");
  assert.equal(f[1].severity, "minor");
  assert.equal(f[1].location, "src/b.ts:3");
  assert.equal(f[1].issue, "dead code");
});

// ── exec ──────────────────────────────────────────────────────────────────

test("runProcess: stdin passthrough, envSet applies, envClear removes", async () => {
  process.env.AGENTS_EXEC_TEST = "inherited";
  try {
    const r = await runProcess({
      command: process.execPath,
      args: ["-e", "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>process.stdout.write(process.env.AGENTS_EXEC_TEST+'|'+(process.env.AGENTS_EXEC_TEST2||'-')+'|'+c.join('')))"],
      stdin: "payload",
      envSet: { AGENTS_EXEC_TEST2: "set" },
      envClear: ["AGENTS_EXEC_TEST"],
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "undefined|set|payload");
  } finally {
    delete process.env.AGENTS_EXEC_TEST;
  }
});

test("runProcess: non-zero exit surfaces code + output", async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stderr.write('boom');process.exit(3)"],
    stdin: "",
  });
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "boom");
});

test("runProcess: abort escalates SIGTERM quickly", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const r = await runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    stdin: "",
    signal: ac.signal,
  });
  assert.equal(r.aborted, true);
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 4000, "should die via SIGTERM, not wait for SIGKILL");
});

// ── tools end-to-end via fake CLI injected through AGENTS_MCP_CONFIG ──────

test("agent_call handler: fake claude alias returns typed envelope", async () => {
  const cfgPath = join(fixture, "fake-config.json");
  writeFileSync(cfgPath, JSON.stringify(fakeConfig()));
  const prev = process.env.AGENTS_MCP_CONFIG;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  try {
    const res = await dispatch("agent_call", { mode: "opinion", agent: "claude", task: "say pong" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.alias, "fake");
    assert.equal(res.structuredContent.model, "fake-model");
    assert.match(res.structuredContent.result, /^OUT\[/);
    assert.match(res.structuredContent.result, /say pong/);
    // default alias comes from the injected config (repo-independent layer)
    const defaulted = await dispatch("agent_call", { mode: "research", agent: "claude", task: "x" });
    assert.equal(defaulted.structuredContent.alias, "fake");
  } finally {
    if (prev === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prev;
  }
});

test("agent_call handler: review mode parses findings from fake output", async () => {
  const findingScript = `const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>process.stdout.write('- [major] fake.ts:1 -- broken thing -- evidence here'))`;
  const cfgPath = join(fixture, "finding-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    aliases: { fake: { command: process.execPath, args: ["-e", findingScript, "--"] } },
    defaults: { claude: { alias: "fake" } },
  }));
  const prev = process.env.AGENTS_MCP_CONFIG;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  try {
    const res = await dispatch("agent_call", { mode: "review", agent: "claude", task: "review this" });
    assert.equal(res.isError, undefined);
    const findings = res.structuredContent.findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, "major");
    assert.equal(findings[0].location, "fake.ts:1");
    assert.equal(findings[0].evidence, "evidence here");
  } finally {
    if (prev === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prev;
  }
});

test("agents_status handler: envelope with agents + aliases + repo override", async () => {
  const res = await dispatch("agents_status", {});
  assert.equal(res.isError, undefined);
  assert.ok(Array.isArray(res.structuredContent.agents));
  assert.ok(Array.isArray(res.structuredContent.aliases));
  assert.ok((res.structuredContent.aliases).some((a) => a.name === "numados"));
  assert.ok(Array.isArray(res.structuredContent.sources));
});

// ── stage 2: Jev routing (routeTask + agent:auto) ─────────────────────────

test("routeTask: jev picks agent + complexity → effort from candidate map", async () => {
  const d = await routeTask({
    mode: "review",
    task: "hard thing",
    routing: BUILTIN_CONFIG.routing,
    apiKeyPresent: true,
    classifier: async (state, questions) => {
      assert.equal(state.mode, "review");
      assert.ok(state.task.includes("hard thing"));
      assert.ok(Object.keys(questions.agent.criteria).includes("agy"));
      return {
        agent: { type: "choice", probabilities: { agy: 0.1, codex: 0.7, claude: 0.2 } },
        complexity: { type: "choice", probabilities: { standard: 0.2, complex: 0.8 } },
      };
    },
  });
  assert.equal(d.by, "jev");
  assert.equal(d.agent, "codex");
  assert.equal(d.complexity, "complex");
  assert.equal(d.effort, "medium"); // codex complex → medium
  assert.equal(d.probabilities.agent.codex, 0.7);
});

test("routeTask: fallbacks — disabled, no API key, classifier throw, junk answer, no candidates", async () => {
  const good = async () => ({ agent: { type: "choice", probabilities: { codex: 1 } } });
  const base = { mode: "research", task: "t", classifier: good, apiKeyPresent: true };

  let d = await routeTask({ ...base, routing: { ...BUILTIN_CONFIG.routing, enabled: false } });
  assert.deepEqual([d.by, d.agent, d.reason], ["fallback", "agy", "routing disabled in config"]);

  d = await routeTask({ ...base, routing: BUILTIN_CONFIG.routing, apiKeyPresent: false });
  assert.deepEqual([d.by, d.agent, d.reason], ["fallback", "agy", "TYPESAFE_API_KEY not set"]);

  d = await routeTask({ ...base, routing: BUILTIN_CONFIG.routing, classifier: async () => { throw new Error("HTTP 500"); } });
  assert.equal(d.by, "fallback");
  assert.match(d.reason, /classifier failed: HTTP 500/);

  d = await routeTask({ ...base, routing: BUILTIN_CONFIG.routing, classifier: async () => ({ agent: { type: "choice", probabilities: { gpt: 0.9 } } }) });
  assert.equal(d.by, "fallback");
  assert.match(d.reason, /no usable agent choice/);

  d = await routeTask({ ...base, routing: { candidates: {} } });
  assert.match(d.reason, /no routing candidates/);
});

test("routeTask: configured fallback agent is used", async () => {
  const d = await routeTask({
    mode: "research", task: "t", apiKeyPresent: true,
    routing: { enabled: true, fallback: "codex", candidates: BUILTIN_CONFIG.routing.candidates },
    classifier: async () => { throw new Error("down"); },
  });
  assert.equal(d.agent, "codex");
  assert.equal(d.by, "fallback");
});

test("adapters: jevEffort ranks below request effort and claude alias pin, above defaults", () => {
  const claude = resolveCall({ mode: "opinion", agent: "claude", alias: "numados", task: "t", jevEffort: "high" }, eff);
  assert.equal(claude.meta.effort, "low"); // alias pin beats jevEffort
  const req = resolveCall({ mode: "opinion", agent: "claude", alias: "numados", task: "t", effort: "medium", jevEffort: "high" }, eff);
  assert.equal(req.meta.effort, "medium"); // request beats everything
  const codex = resolveCall({ mode: "review", agent: "codex", task: "t", jevEffort: "medium" }, eff);
  assert.equal(codex.meta.effort, "medium"); // jevEffort beats config default low
  assert.equal(codex.meta.sandbox, "workspace-write");
});

test("agent_call agent:auto — jev route executes and reports routing", async () => {
  const cfgPath = join(fixture, "auto-config.json");
  writeFileSync(cfgPath, JSON.stringify(fakeConfig()));
  const prev = process.env.AGENTS_MCP_CONFIG;
  const prevApiKey = process.env.TYPESAFE_API_KEY;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  process.env.TYPESAFE_API_KEY = "test-key";
  setClassifier(async () => ({
    agent: { type: "choice", probabilities: { claude: 0.9, codex: 0.1 } },
    complexity: { type: "choice", probabilities: { complex: 0.8, standard: 0.2 } },
  }));
  try {
    const res = await dispatch("agent_call", { mode: "opinion", agent: "auto", task: "weigh this design" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.agent, "claude");
    assert.equal(res.structuredContent.alias, "fake");
    assert.equal(res.structuredContent.routing.by, "jev");
    assert.equal(res.structuredContent.routing.complexity, "complex");
    // fake alias has no effort pin → jev effort (claude complex → high) beats config default low
    assert.equal(res.structuredContent.effort, "high");
    assert.match(res.structuredContent.result, /weigh this design/);

    // explicit request effort still wins over the jev-chosen one
    const override = await dispatch("agent_call", { mode: "opinion", agent: "auto", effort: "low", task: "x" });
    assert.equal(override.structuredContent.effort, "low");
  } finally {
    setClassifier(null);
    if (prev === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prev;
    if (prevApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prevApiKey;
  }
});

test("agent_call agent:auto — routing disabled falls back without a classifier call", async () => {
  const cfgPath = join(fixture, "auto-off-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    ...fakeConfig(),
    routing: { enabled: false, fallback: "claude" },
  }));
  const prev = process.env.AGENTS_MCP_CONFIG;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  setClassifier(async () => { throw new Error("must not be called"); });
  try {
    const res = await dispatch("agent_call", { mode: "research", agent: "auto", task: "t" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.agent, "claude");
    assert.equal(res.structuredContent.routing.by, "fallback");
    assert.equal(res.structuredContent.routing.reason, "routing disabled in config");
  } finally {
    setClassifier(null);
    if (prev === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prev;
  }
});

import {
  detectCooldownKind, firstAvailable, loadCooldowns, nextAvailable, recordCooldown,
} from "../dist/cooldown.js";

const COOL_FILE = join(fixture, "cooldowns.json");
process.env.AGENTS_MCP_COOLDOWNS = COOL_FILE;

// ── cooldowns ─────────────────────────────────────────────────────────────

test("cooldown: detect kinds, record/load prunes expired, first/next available", () => {
  assert.equal(detectCooldownKind("HTTP 429: rate limit exceeded"), "rateLimit");
  assert.equal(detectCooldownKind("Error 529: model overloaded"), "overload");
  assert.equal(detectCooldownKind("plain crash"), null);

  recordCooldown("m-bad", "rateLimit", 1800, "429", COOL_FILE);
  recordCooldown("m-old", "overload", -1, "expired already", COOL_FILE); // negative ttl = expired
  const table = loadCooldowns(Date.now(), COOL_FILE);
  assert.ok(table["m-bad"]);
  assert.equal(table["m-old"], undefined); // expired pruned

  assert.equal(firstAvailable(["m-bad", "m-good"], table), "m-good");
  assert.equal(firstAvailable(["m-bad"], table), null);
  assert.equal(nextAvailable(["m-a", "m-bad", "m-good"], "m-a", table), "m-good");
  assert.equal(nextAvailable(["m-a", "m-bad"], "m-a", table), null);
});

test("routeTask: jev model question asked only for multi-model candidates, cooldown models hidden", async () => {
  const routing = {
    enabled: true,
    fallback: "agy",
    candidates: {
      claude: { note: "n", models: ["opus", "sonnet"] },
      codex: { note: "n", models: ["solo"] }, // single model: no question
    },
  };
  let asked = [];
  const d = await routeTask({
    mode: "research", task: "t", routing, apiKeyPresent: true,
    cooldowns: { sonnet: { until: Date.now() + 60_000, kind: "rateLimit", reason: "429" } },
    classifier: async (_state, questions) => {
      asked = Object.keys(questions);
      return {
        agent: { type: "choice", probabilities: { claude: 0.9 } },
        complexity: { type: "choice", probabilities: { standard: 1 } },
      };
    },
  });
  // sonnet parked → only opus routable → no model question needed, deterministic opus
  assert.ok(!asked.includes("model_claude"));
  assert.ok(!asked.includes("model_codex"));
  assert.equal(d.agent, "claude");
  assert.equal(d.model, "opus");
});

test("routeTask: jev model choice used when answered; fallback picks first available", async () => {
  const routing = {
    enabled: true,
    fallback: "claude",
    candidates: { claude: { note: "n", models: ["opus", "sonnet"] } },
  };
  const d = await routeTask({
    mode: "research", task: "t", routing, apiKeyPresent: true, cooldowns: {},
    classifier: async () => ({
      agent: { type: "choice", probabilities: { claude: 1 } },
      model_claude: { type: "choice", probabilities: { sonnet: 0.8, opus: 0.2 } },
    }),
  });
  assert.equal(d.model, "sonnet"); // jev choice beats list order

  const fb = await routeTask({
    mode: "research", task: "t", routing, apiKeyPresent: false,
    cooldowns: { opus: { until: Date.now() + 60_000, kind: "rateLimit", reason: "429" } },
  });
  assert.equal(fb.by, "fallback");
  assert.equal(fb.model, "sonnet"); // deterministic first-available, opus parked
});

test("agent_call: rate limit on first model parks it and retries on the next candidate model", async () => {
  const switchScript =
    'const m=process.argv[process.argv.indexOf("--model")+1];' +
    'if(m==="m-a"){process.stderr.write("HTTP 429 rate limit exceeded");process.exit(1)}' +
    'const c=[];process.stdin.on("data",d=>c.push(d));process.stdin.on("end",()=>process.stdout.write("OUT["+m+"|"+c.join("")+"]"))';
  const cfgPath = join(fixture, "retry-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    aliases: { fake: { command: process.execPath, args: ["-e", switchScript, "--"] } },
    defaults: { claude: { alias: "fake", model: "m-a" } },
    routing: { enabled: false, candidates: { claude: { models: ["m-a", "m-b"] } } },
  }));
  const prevCfg = process.env.AGENTS_MCP_CONFIG;
  const prevCool = process.env.AGENTS_MCP_COOLDOWNS;
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  process.env.AGENTS_MCP_COOLDOWNS = join(fixture, "retry-cooldowns.json");
  try {
    const res = await dispatch("agent_call", { mode: "research", agent: "claude", task: "ping" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent.ok, true);
    assert.equal(res.structuredContent.model, "m-b");
    assert.deepEqual(res.structuredContent.retried, { from: "m-a", to: "m-b", kind: "rateLimit" });
    assert.match(res.structuredContent.result, /OUT\[m-b\|/);
    // the failed model is now parked in the shared cache
    assert.ok(loadCooldowns(Date.now(), process.env.AGENTS_MCP_COOLDOWNS)["m-a"]);
  } finally {
    if (prevCfg === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prevCfg;
    if (prevCool === undefined) delete process.env.AGENTS_MCP_COOLDOWNS;
    else process.env.AGENTS_MCP_COOLDOWNS = prevCool;
  }
});

test("agent_call: non-rate-limit failure does NOT retry or park", async () => {
  const crashScript = 'process.stderr.write("segfault in parser");process.exit(2)';
  const cfgPath = join(fixture, "crash-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    aliases: { fake: { command: process.execPath, args: ["-e", crashScript, "--"] } },
    defaults: { claude: { alias: "fake", model: "m-x" } },
    routing: { enabled: false, candidates: { claude: { models: ["m-x", "m-y"] } } },
  }));
  const prevCfg = process.env.AGENTS_MCP_CONFIG;
  const prevCool = process.env.AGENTS_MCP_COOLDOWNS;
  const coolFile = join(fixture, "crash-cooldowns.json");
  process.env.AGENTS_MCP_CONFIG = cfgPath;
  process.env.AGENTS_MCP_COOLDOWNS = coolFile;
  try {
    const res = await dispatch("agent_call", { mode: "research", agent: "claude", task: "t" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.retried, undefined);
    assert.equal(loadCooldowns(Date.now(), coolFile)["m-x"], undefined);
  } finally {
    if (prevCfg === undefined) delete process.env.AGENTS_MCP_CONFIG;
    else process.env.AGENTS_MCP_CONFIG = prevCfg;
    if (prevCool === undefined) delete process.env.AGENTS_MCP_COOLDOWNS;
    else process.env.AGENTS_MCP_COOLDOWNS = prevCool;
  }
});
