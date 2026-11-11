/** Tool surface:
 *    direct:   agent_call   — the one coarse inter-agent channel
 *    codemode: agents_status — doctor: aliases, resolved defaults, CLI presence
 *
 *  agent_call carries the calling guidance inline in its description (when to
 *  seek a second opinion), because as a direct MCP tool there is no
 *  promptGuidelines slot. The tool list is fixed at build time (contract.ts);
 *  this module owns the handlers. */

import { loadEffectiveConfig } from "./config.js";
import { lookupCommand, runProcess } from "./exec.js";
import { resolveCall, type CallRequest, type CallSpec } from "./adapters.js";
import { jevClassifier, routeTask, type Classifier, type RouteDecision } from "./route.js";
import {
  DEFAULT_TTL, detectCooldownKind, loadCooldowns, nextAvailable, recordCooldown,
} from "./cooldown.js";
import { cleanCodexOutput, parseFindings, type Finding } from "./modes.js";
import { result, text, type ToolResult } from "./types.js";

/** Active classifier for agent:"auto" routing. Tests swap it via
 *  setClassifier; production always uses the Jev API client. */
let activeClassifier: Classifier = jevClassifier;
export function setClassifier(c: Classifier | null): void {
  activeClassifier = c || jevClassifier;
}

// ── agent_call ────────────────────────────────────────────────────────────

async function agentCall(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const eff = loadEffectiveConfig();
  let routing: RouteDecision | undefined;
  const req = { ...(args as unknown as CallRequest) };
  if (req.agent === "auto") {
    routing = await routeTask({
      mode: req.mode,
      task: req.task || "",
      routing: eff.config.routing,
      classifier: activeClassifier,
      apiKeyPresent: !!process.env.TYPESAFE_API_KEY,
    });
    req.agent = routing.agent;
    // Explicit request effort wins; Jev effort ranks below the alias pin too
    // (adapters.ts), so pass it on its own tier instead of req.effort.
    if (routing.effort) req.jevEffort = routing.effort;
    // Same for the model: request.model > alias pin > Jev choice > defaults.
    if (routing.model) req.jevModel = routing.model;
  }

  /** Run one attempt; on a rate-limit failure, park the model and retry ONCE
   *  on the next available model of the routing candidate — same task, same
   *  effort, no second classifier call (cooldown stickiness). */
  const attempt = async (): Promise<{
    spec: CallSpec;
    run: Awaited<ReturnType<typeof runProcess>>;
    retried?: { from: string; to: string; kind: string };
  }> => {
    const spec = resolveCall(req, eff);
    const run = await runProcess({
      command: spec.command,
      args: spec.args,
      stdin: spec.stdin,
      envSet: spec.envSet,
      envClear: spec.envClear,
      ...(signal ? { signal } : {}),
    });
    if (run.code === 0) return { spec, run };

    const kind = detectCooldownKind(`${run.stdout}\n${run.stderr}`);
    if (!kind) return { spec, run };
    const coolCfg = eff.config.routing?.cooldowns || {};
    const ttl = kind === "overload" ? (coolCfg.overloadTtlSec ?? DEFAULT_TTL.overload) : (coolCfg.rateLimitTtlSec ?? DEFAULT_TTL.rateLimit);
    recordCooldown(spec.meta.model, kind, ttl, `exit ${run.code}: ${(run.stderr || run.stdout).slice(0, 120)}`);

    const models = eff.config.routing?.candidates?.[spec.meta.agent]?.models;
    const next = models ? nextAvailable(models, spec.meta.model, loadCooldowns()) : null;
    if (!next) return { spec, run };

    // Explicit request model wins over every pin — the retry switch is the
    // one place where that is intended (same candidate list, owner-ordered).
    req.model = next;
    const spec2 = resolveCall(req, eff);
    const run2 = await runProcess({
      command: spec2.command,
      args: spec2.args,
      stdin: spec2.stdin,
      envSet: spec2.envSet,
      envClear: spec2.envClear,
      ...(signal ? { signal } : {}),
    });
    return { spec: spec2, run: run2, retried: { from: spec.meta.model, to: next, kind } };
  };

  let spec: CallSpec;
  let stdout: string, stderr: string, code: number;
  let retried: { from: string; to: string; kind: string } | undefined;
  try {
    const r = await attempt();
    spec = r.spec;
    ({ stdout, stderr, code } = r.run);
    retried = r.retried;
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }

  if (code !== 0) {
    const tail = stdout.slice(-3000) || stderr.slice(-3000) || "(no output)";
    let hint = "";
    if (/ENOENT|not found|command not found/i.test(stderr)) {
      const h = eff.config.hints?.[spec.meta.agent];
      if (h) hint = `\n\nInstall hint: ${h}`;
    }
    return result(
      `${spec.meta.agent} (${spec.meta.alias || spec.command}) exited with code ${code}.\n\nLast output:\n${tail}${hint}`,
      { error: `exit code ${code}`, mode: spec.meta.mode, agent: spec.meta.agent, ...(spec.meta.alias ? { alias: spec.meta.alias } : {}) },
      true,
    );
  }

  const cleaned = spec.meta.agent === "codex" ? cleanCodexOutput(stdout) : stdout.trim();
  const answer = cleaned || "(no output)";
  const findings: Finding[] | undefined =
    spec.meta.mode === "review" ? parseFindings(answer) : undefined;

  return result(answer, {
    mode: spec.meta.mode,
    agent: spec.meta.agent,
    ...(spec.meta.alias ? { alias: spec.meta.alias } : {}),
    ...(routing ? { routing } : {}),
    ...(retried ? { retried } : {}),
    model: spec.meta.model,
    ...(spec.meta.effort ? { effort: spec.meta.effort } : {}),
    ...(spec.meta.sandbox ? { sandbox: spec.meta.sandbox } : {}),
    result: answer,
    ...(findings ? { findings } : {}),
  });
}

// ── agents_status ─────────────────────────────────────────────────────────

async function agentsStatus(): Promise<ToolResult> {
  const eff = loadEffectiveConfig();
  const cfg = eff.config;
  const lines: string[] = [];
  const agents: Record<string, unknown>[] = [];

  const claudeCmd = cfg.aliases?.[cfg.defaults?.claude?.alias || ""]?.command || "claude";
  for (const [agent, command] of [
    ["claude", claudeCmd],
    ["codex", cfg.agents?.codex?.command || "codex"],
    ["agy", cfg.agents?.agy?.command || "agy"],
  ] as const) {
    const path = lookupCommand(command);
    const resolved = agent === "claude"
      ? cfg.defaults?.claude
      : agent === "codex"
        ? cfg.defaults?.codex
        : undefined;
    const agyModel = agent === "agy" ? (cfg.agents?.agy?.model || cfg.defaults?.agy?.model) : undefined;
    const defaults = {
      ...(resolved?.alias ? { alias: resolved.alias } : {}),
      ...(resolved?.model ? { model: resolved.model } : {}),
      ...(resolved?.effort ? { effort: resolved.effort } : {}),
      ...(agyModel ? { model: agyModel } : {}),
    };
    agents.push({
      agent,
      command,
      present: path !== null,
      ...(path ? { path } : { installHint: cfg.hints?.[agent] || "install the CLI" }),
      ...(Object.keys(defaults).length ? { defaults } : {}),
    });
    lines.push(`${agent.padEnd(6)} ${path ? "ok: " + path : "MISSING — " + (cfg.hints?.[agent] || "install the CLI")}`);
  }

  const aliases = Object.entries(cfg.aliases || {}).map(([name, a]) => ({
    name,
    command: a.command,
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.args?.length ? { args: a.args } : {}),
    ...(a.env ? { env: Object.keys(a.env) } : {}),
    ...(a.envClear?.length ? { envClear: a.envClear } : {}),
  }));

  lines.push("", `aliases: ${aliases.map((a) => a.name).join(", ") || "(none)"}`);

  const routing = cfg.routing;
  const cool = loadCooldowns();
  const candidates = Object.entries(routing?.candidates || {}).map(([name, c]) => ({
    agent: name,
    ...(c.note ? { note: c.note } : {}),
    ...(c.effortByComplexity ? { effortByComplexity: c.effortByComplexity } : {}),
    ...(c.models?.length ? { models: c.models } : {}),
  }));
  const cooling = Object.entries(cool).map(([model, e]) => ({
    model,
    kind: e.kind,
    until: new Date(e.until).toISOString(),
  }));
  lines.push(
    `routing (agent:auto): ${routing?.enabled === false ? "disabled" : "enabled"}` +
      ` — classifier: ${process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY ok" : "TYPESAFE_API_KEY MISSING (fallback only)"}` +
      `, fallback: ${routing?.fallback || "agy"}, candidates: ${candidates.map((c) => c.agent).join(", ") || "(none)"}`,
  );

  return result(
    `agents-mcp status\n${lines.join("\n")}\n\nrepo override: ${eff.repoConfigPath || "(none)"}\nconfig sources: ${eff.sources.join(" ← ")}`,
    {
      agents,
      aliases,
      routing: {
        enabled: routing?.enabled !== false,
        apiKeyPresent: !!process.env.TYPESAFE_API_KEY,
        fallback: routing?.fallback || "agy",
        candidates,
        ...(cooling.length ? { cooling } : {}),
      },
      repoOverride: eff.repoConfigPath,
      sources: eff.sources,
    },
  );
}

// ── handler registry ──────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;

const handlers: Record<string, Handler> = {
  agent_call: (args, signal) => agentCall(args, signal),
  agents_status: () => agentsStatus(),
};

export function dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) throw new Error(`no handler registered for ${name}`);
  return handler(args, signal);
}
