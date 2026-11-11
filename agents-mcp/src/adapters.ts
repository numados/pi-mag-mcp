/** Adapters: turn an agent_call request + effective config into a concrete
 *  CLI invocation. One adapter per agent; the flags are the proven live
 *  surface, only resolution moved into config.
 *
 *  claude: `claude [-p] --model M --effort E` — task on stdin; alias selects
 *          the subscription (command + args + env + envClear).
 *  codex:  `codex --sandbox S --ask-for-approval never exec -m M -c
 *          model_reasoning_effort="E" --ephemeral` — task on stdin; sandbox
 *          follows effort (low → read-only, medium/high → workspace-write).
 *  agy:    `agy --model M --add-dir … --dangerously-skip-permissions
 *          --sandbox --print TASK` — task as the LAST arg (print mode drops
 *          it otherwise), stdin is ignored; model is selectable. */

import { expandValue, type AliasDef, type EffectiveConfig } from "./config.js";
import { composeTask, EFFORTS, MODES, type Effort, type Mode } from "./modes.js";

export class AgentError extends Error {}

export interface CallRequest {
  mode: string;
  agent: string;
  task: string;
  model?: string;
  effort?: string;
  alias?: string;
  extra_dirs?: string[];
  /** Jev-routed effort (agent:"auto"); ranks BELOW request effort and the
   *  claude alias pin, above config defaults. */
  jevEffort?: string;
  /** Jev-routed model from the candidate's models[]; ranks BELOW request
   *  model and the claude alias pin, above config defaults. */
  jevModel?: string;
}

export interface CallSpec {
  command: string;
  args: string[];
  stdin: string;
  envSet: Record<string, string>;
  envClear: string[];
  /** identity metadata echoed back in the result */
  meta: {
    agent: "claude" | "codex" | "agy";
    alias?: string;
    model: string;
    effort?: Effort;
    mode: Mode;
    sandbox?: string;
  };
}

function validEffort(e: string, agent: string): Effort {
  if (!(EFFORTS as readonly string[]).includes(e)) {
    throw new AgentError(`unknown effort "${e}" for ${agent} — valid: ${EFFORTS.join(", ")}`);
  }
  return e as Effort;
}

function expandEnv(def: AliasDef): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.env || {})) out[k] = expandValue(v);
  return out;
}

// ── claude ────────────────────────────────────────────────────────────────

function resolveClaude(p: CallRequest, eff: EffectiveConfig, prompt: string): CallSpec {
  const cfg = eff.config;
  const aliasName = p.alias || cfg.defaults?.claude?.alias || "";
  if (!aliasName) {
    throw new AgentError(
      `no claude alias resolved — pass alias (available: ${Object.keys(cfg.aliases || {}).join(", ")}) or set defaults.claude.alias in ~/.config/agents-mcp/config.json or .agents-mcp.json`,
    );
  }
  const alias = cfg.aliases?.[aliasName];
  if (!alias || !alias.command) {
    throw new AgentError(
      `unknown claude alias "${aliasName}" — available: ${Object.keys(cfg.aliases || {}).join(", ") || "(none)"}`,
    );
  }
  const model = p.model || alias.model || p.jevModel || cfg.defaults?.claude?.model || "claude-opus-4-8[1m]";
  const effort = validEffort(p.effort || alias.effort || p.jevEffort || cfg.defaults?.claude?.effort || "high", "claude");
  if (p.extra_dirs?.length) throw new AgentError("extra_dirs is supported for agy only");

  return {
    command: alias.command,
    args: [...(alias.args || []), "-p", "--model", model, "--effort", effort],
    stdin: prompt,
    envSet: expandEnv(alias),
    envClear: alias.envClear || [],
    meta: { agent: "claude", alias: aliasName, model, effort, mode: p.mode as Mode },
  };
}

// ── codex ─────────────────────────────────────────────────────────────────

function resolveCodex(p: CallRequest, eff: EffectiveConfig, prompt: string): CallSpec {
  const cfg = eff.config;
  const command = cfg.agents?.codex?.command || "codex";
  const model = p.model || p.jevModel || cfg.defaults?.codex?.model || "gpt-6.1-sol";
  const effort = validEffort(p.effort || p.jevEffort || cfg.defaults?.codex?.effort || "low", "codex");
  // Same coupling as the old complexity knob: light→read-only, complex→write.
  const sandbox = effort === "low" ? "read-only" : "workspace-write";
  if (p.extra_dirs?.length) throw new AgentError("extra_dirs is supported for agy only");

  return {
    command,
    args: [
      "--sandbox", sandbox,
      "--ask-for-approval", "never",
      "exec",
      "--skip-git-repo-check",
      "-m", model,
      "-c", `model_reasoning_effort="${effort}"`,
      "--ephemeral",
    ],
    stdin: prompt,
    envSet: {},
    envClear: [],
    meta: { agent: "codex", model, effort, mode: p.mode as Mode, sandbox },
  };
}

// ── agy ───────────────────────────────────────────────────────────────────

function resolveAgy(p: CallRequest, eff: EffectiveConfig, prompt: string): CallSpec {
  const cfg = eff.config;
  const command = cfg.agents?.agy?.command || "agy";
  const model = p.model || p.jevModel || cfg.agents?.agy?.model || cfg.defaults?.agy?.model || "Gemini 3.8 Flash (High)";
  if (p.effort) throw new AgentError(`agy has no effort parameter — ${model} is always fast; use claude/codex for deeper analysis`);

  const args = ["--model", model, "--add-dir", process.cwd()];
  for (const dir of p.extra_dirs || []) args.push("--add-dir", dir);
  args.push("--dangerously-skip-permissions", "--sandbox", "--print", prompt);

  return {
    command,
    args,
    stdin: "",
    envSet: {},
    envClear: [],
    meta: { agent: "agy", model, mode: p.mode as Mode },
  };
}

// ── entry ─────────────────────────────────────────────────────────────────

export function resolveCall(p: CallRequest, eff: EffectiveConfig): CallSpec {
  if (!p.task || !p.task.trim()) throw new AgentError("task is required — the callee starts with no conversation, include all context");
  if (!(MODES as readonly string[]).includes(p.mode)) {
    throw new AgentError(`unknown mode "${p.mode}" — valid: ${MODES.join(", ")}`);
  }
  const mode = p.mode as Mode;
  const prompt = composeTask(mode, p.task);

  switch (p.agent) {
    case "claude":
      return resolveClaude(p, eff, prompt);
    case "codex":
      return resolveCodex(p, eff, prompt);
    case "agy":
      return resolveAgy(p, eff, prompt);
    default:
      throw new AgentError(`unknown agent "${p.agent}" — valid: claude, codex, agy`);
  }
}
