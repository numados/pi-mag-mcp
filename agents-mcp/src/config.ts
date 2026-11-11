/** agents-mcp config: machine-global config + per-repo `.agents-mcp.json`.
 *
 *  An alias = one CLI subscription (command + args + env). Defaults select
 *  model/effort per agent. Resolution priority:
 *    request arg > alias pin > Jev choice > defaults (repo layer over global).
 *
 *  An alias MAY pin model/effort — subscriptions are model-bound and
 *  historically defaulted to different efforts. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AliasDef {
  /** CLI binary (resolved via PATH). */
  command: string;
  /** Extra CLI args, prepended to the adapter-built args. */
  args?: string[];
  /** Env overrides applied on top of the inherited environment.
   *  Values: literal | "~/path" | "env:VAR" reference. */
  env?: Record<string, string>;
  /** Env vars removed before env applies (subscription isolation). */
  envClear?: string[];
  /** Model pinned by this subscription (alias pin). */
  model?: string;
  /** Default effort for this subscription (alias pin). */
  effort?: string;
}

export interface AgentDefaults {
  /** claude only: subscription alias used when the request does not name one. */
  alias?: string;
  model?: string;
  effort?: string;
}

export interface AgentCommandConfig {
  command?: string;
  model?: string;
}

export interface AgentCommandConfigSet {
  claude?: AgentCommandConfig;
  codex?: AgentCommandConfig;
  agy?: AgentCommandConfig;
}

export interface RepoAgentsConfig {
  defaults?: { claude?: AgentDefaults; codex?: AgentDefaults; agy?: AgentDefaults };
  agents?: AgentCommandConfigSet;
  aliases?: Record<string, AliasDef>;
  routing?: RoutingConfig;
}

export interface RouteCandidate {
  /** Cost/capability note shown to the Jev classifier as choice criteria. */
  note?: string;
  /** Complexity → effort map; adapters still rank request arg and alias pin
   *  above the Jev-chosen effort. */
  effortByComplexity?: { standard?: string; complex?: string };
  /** Models this candidate may run, in owner-preference order. Jev picks one
   *  (request arg and alias pin still rank above its choice); models on
   *  cooldown are hidden from the choice. */
  models?: string[];
}

export interface RoutingConfig {
  /** default true — Jev routing for agent_call{agent:"auto"}. */
  enabled?: boolean;
  /** Agent used when routing cannot run or fails (default "agy" — free). */
  fallback?: string;
  /** Classifier timeout, ms (default 10000). No retries: fail fast to fallback. */
  timeoutMs?: number;
  candidates?: Record<string, RouteCandidate>;
  /** Cooldown TTLs in seconds for parked models (defaults: 1800 / 300). */
  cooldowns?: { rateLimitTtlSec?: number; overloadTtlSec?: number };
}

export interface AgentsConfig extends RepoAgentsConfig {
  /** Jev complexity routing for agent_call{agent:"auto"}. */
  routing?: RoutingConfig;
  /** Install hints shown by agents_status when a CLI is missing. */
  hints?: Record<string, string>;
}

/** Built-in defaults — the proven live baseline; every entry here is also
 *  overridable per machine config or per repository. */
export const BUILTIN_CONFIG: AgentsConfig = {
  defaults: {
    claude: { alias: "numados", model: "claude-opus-4-8[1m]", effort: "high" },
    codex: { model: "gpt-6.1-sol", effort: "low" },
  },
  aliases: {
    cc: { command: "claude", effort: "high" },
    numados: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      effort: "low",
      envClear: [
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_FOUNDRY_BASE_URL",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
      ],
    },
    work: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      effort: "low",
      model: "claude-opus-4-5",
      env: {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_BASE_URL: "https://your-gateway.example/ai/anthropic",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-5",
      },
    },
  },
  agents: { agy: { command: "agy", model: "Gemini 3.8 Flash (High)" } },
  routing: {
    enabled: true,
    fallback: "agy",
    candidates: {
      agy: {
        note: "free, fastest, no subscription minutes; selectable Gemini model (default 3.8 Flash High); weakest reasoning — bounded fact-finding, simple lookups, mechanical checks",
      },
      codex: {
        note: "GPT-6.1 Sol on a Codex subscription (metered); strong general engineer; effort low runs read-only, medium/high may write to the workspace",
        effortByComplexity: { standard: "low", complex: "medium" },
        models: ["gpt-6.1-sol"],
      },
      claude: {
        note: "Claude Opus on a Claude subscription (metered, most expensive); strongest reasoning — subtle design, hard debugging, high-stakes review",
        effortByComplexity: { standard: "low", complex: "high" },
        models: ["claude-opus-4-8[1m]", "claude-sonnet-4-5"],
      },
    },
  },
  hints: {
    claude: "npm install -g @anthropic-ai/claude-code  # then: claude login (or configure the subscription env)",
    codex: "brew install codex  # then: codex login",
    agy: "install the Antigravity CLI (agy) from https://antigravity.google",
  },
};

export function deepMerge<T>(base: T, over: unknown): T {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== "object" || base === null || typeof over !== "object" || over === null) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Expand a config value: "env:VAR" → environment, "~…" → home, else literal. */
export function expandValue(v: string): string {
  if (v.startsWith("env:")) {
    const name = v.slice(4);
    const val = process.env[name];
    if (val === undefined) throw new Error(`env:${name} referenced in config is not set — export it or replace the reference`);
    return val;
  }
  if (v === "~") return homedir();
  if (v.startsWith("~/")) return join(homedir(), v.slice(2));
  return v;
}

export function findRepoRoot(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    // .git is a directory in normal checkouts, a file in worktrees/submodules
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch (e) {
    throw new Error(`malformed config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function globalConfigPath(): string {
  return process.env.AGENTS_MCP_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agents-mcp", "config.json");
}

/** Global config: built-in defaults ← ~/.config/agents-mcp/config.json. */
export function loadGlobalConfig(): { config: AgentsConfig; sources: string[] } {
  const sources: string[] = ["built-in defaults"];
  let config = BUILTIN_CONFIG;
  const path = globalConfigPath();
  const file = readJson(path);
  if (file) {
    config = deepMerge(config, file);
    sources.push(path);
  }
  return { config, sources };
}

export interface RepoContext {
  repoRoot: string | null;
  config: RepoAgentsConfig;
  configPath: string | null;
}

export function loadRepoContext(startDir = process.cwd()): RepoContext {
  const repoRoot = findRepoRoot(startDir);
  const configPath = repoRoot ? join(repoRoot, ".agents-mcp.json") : null;
  const file = configPath ? readJson(configPath) : null;
  return { repoRoot, config: (file as RepoAgentsConfig) || {}, configPath: configPath && file ? configPath : null };
}

export interface EffectiveConfig {
  config: AgentsConfig;
  repoRoot: string | null;
  repoConfigPath: string | null;
  sources: string[];
}

/** Global + repo layers merged into the resolution view:
 *  aliases and per-agent defaults from the repo override the global ones. */
export function loadEffectiveConfig(startDir = process.cwd()): EffectiveConfig {
  const { config: global, sources } = loadGlobalConfig();
  const repo = loadRepoContext(startDir);
  let config = global;
  if (repo.config.defaults) config = deepMerge(config, { defaults: repo.config.defaults });
  if (repo.config.aliases) config = deepMerge(config, { aliases: repo.config.aliases });
  if (repo.config.agents) config = deepMerge(config, { agents: repo.config.agents });
  if (repo.config.routing) config = deepMerge(config, { routing: repo.config.routing });
  return {
    config,
    repoRoot: repo.repoRoot,
    repoConfigPath: repo.configPath,
    sources: repo.configPath ? [...sources, repo.configPath] : sources,
  };
}
