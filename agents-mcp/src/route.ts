/** Jev complexity routing.
 *
 *  When agent_call gets agent:"auto", a Jev classifier picks the executor
 *  and rates the task complexity ONCE per call — inside the server, the
 *  harness never sees it (not a pre-turn gate). The candidate registry
 *  (cost/capability notes, complexity → effort mapping) lives in config
 *  under `routing`.
 *
 *  Priority: explicit request model/effort > alias pin (claude) > Jev choice
 *  > config defaults. Any failure — routing disabled, no API key, timeout,
 *  malformed or off-registry answer — degrades to the configured fallback
 *  agent. Routing never blocks a call. */

import type { RoutingConfig } from "./config.js";
import { firstAvailable, loadCooldowns, type CooldownTable } from "./cooldown.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

export const KNOWN_AGENTS = ["claude", "codex", "agy"] as const;

export interface ClassifyAnswer {
  type?: string;
  probabilities?: Record<string, number>;
}

export type Classifier = (
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  timeoutMs: number,
) => Promise<Record<string, ClassifyAnswer>>;

/** Production classifier: one fan-out request to the Jev API.
 *  No retries — routing must fail fast into the fallback, not stall a call. */
export const jevClassifier: Classifier = async (state, questions, timeoutMs) => {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY not set");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: MODEL, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`routing API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { answers?: Record<string, ClassifyAnswer> };
  return data.answers ?? {};
};

export interface RouteDecision {
  agent: string;
  by: "jev" | "fallback";
  complexity?: "standard" | "complex";
  /** Effort from the candidate's complexity→effort map (adapters still rank
   *  request arg and alias pin above it). */
  effort?: string;
  /** Model from the candidate's models[] (adapters rank request arg and the
   *  claude alias pin above it). Deterministic first-available on fallback. */
  model?: string;
  /** Why the fallback fired (by="fallback" only). */
  reason?: string;
  probabilities?: {
    agent?: Record<string, number>;
    complexity?: Record<string, number>;
  };
}

function argmax(probabilities: Record<string, number>, allowed: readonly string[]): string | null {
  let best: string | null = null;
  let bestP = -1;
  for (const [k, p] of Object.entries(probabilities)) {
    if (!allowed.includes(k)) continue;
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

export async function routeTask(opts: {
  mode: string;
  task: string;
  routing: RoutingConfig | undefined;
  classifier: Classifier;
  apiKeyPresent: boolean;
  /** Cooldown table override for tests; production loads the cache file. */
  cooldowns?: CooldownTable;
}): Promise<RouteDecision> {
  const cfg = opts.routing || {};
  const fallbackAgent = cfg.fallback || "agy";
  const cool = opts.cooldowns ?? loadCooldowns();
  /** Deterministic model for a fallback decision: first non-cooldown model
   *  of the fallback candidate (list head when all are parked). */
  const fallbackModel = (): string | undefined => {
    const models = cfg.candidates?.[fallbackAgent]?.models;
    if (!models?.length) return undefined;
    return firstAvailable(models, cool) ?? models[0];
  };
  const fallback = (reason: string): RouteDecision => {
    const model = fallbackModel();
    return { agent: fallbackAgent, by: "fallback", reason, ...(model ? { model } : {}) };
  };

  if (cfg.enabled === false) return fallback("routing disabled in config");
  if (!opts.apiKeyPresent) return fallback("TYPESAFE_API_KEY not set");

  const candidates = Object.entries(cfg.candidates || {}).filter(([name]) =>
    (KNOWN_AGENTS as readonly string[]).includes(name),
  );
  if (candidates.length === 0) return fallback("no routing candidates configured");

  const questions: Record<string, unknown> = {
    agent: {
      type: "choice",
      instructions:
        "Which executor should handle the task in `task` (mode `mode`)? Pick the CHEAPEST one that can do it " +
        "well — subscription minutes are metered, agy time is free. Weigh the candidate notes in `candidates`: " +
        "do not spend a strong metered model on work a cheaper one handles correctly.",
      criteria: Object.fromEntries(candidates.map(([name, c]) => [name, c.note || name])),
    },
    complexity: {
      type: "choice",
      instructions: "How demanding is the work requested in `task`?",
      criteria: {
        standard: "Bounded fact-finding, ordinary analysis, straightforward code reading or writing",
        complex: "Subtle design, cross-cutting changes, hard debugging, high-stakes review",
      },
    },
  };

  /** Per-candidate model questions — one extra question per candidate with
   *  more than one routable model, answered in the SAME batched Jev call.
   *  Models on cooldown are hidden; the answer is used only when its agent
   *  wins the `agent` question. */
  const modelChoices: Record<string, string[]> = {};
  for (const [name, c] of candidates) {
    const all = c.models || [];
    if (all.length < 2) continue;
    const routable = all.filter((m) => {
      const e = cool[m];
      return !e || e.until <= Date.now();
    });
    const offered = routable.length ? routable : all;
    if (offered.length > 1) {
      modelChoices[name] = offered;
      questions[`model_${name}`] = {
        type: "choice",
        instructions:
          `If "${name}" executes the task in \`task\`, which model should run it? ` +
          "The first listed model is the owner's default preference — pick a later one only when the task clearly demands it.",
        criteria: Object.fromEntries(offered.map((m, i) => [m, i === 0 ? "preferred default" : "alternative"])),
      };
    }
  }

  let answers: Record<string, ClassifyAnswer>;
  try {
    answers = await opts.classifier(
      {
        mode: opts.mode,
        task: opts.task.slice(0, 16_000),
        candidates: Object.fromEntries(candidates.map(([name, c]) => [name, c.note || ""])),
      },
      questions,
      cfg.timeoutMs ?? 10_000,
    );
  } catch (e) {
    return fallback(`classifier failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const agentAnswer = answers.agent;
  const agent =
    agentAnswer?.type === "choice" && agentAnswer.probabilities
      ? argmax(agentAnswer.probabilities, candidates.map(([name]) => name))
      : null;
  if (!agent) return fallback("classifier returned no usable agent choice");

  const complexityAnswer = answers.complexity;
  const complexity =
    complexityAnswer?.type === "choice" && complexityAnswer.probabilities
      ? (argmax(complexityAnswer.probabilities, ["standard", "complex"]) as "standard" | "complex" | null)
      : null;

  const candidate = (cfg.candidates || {})[agent];
  const effort = complexity ? candidate?.effortByComplexity?.[complexity] : undefined;

  /** Model: Jev's per-candidate choice when asked, else the deterministic
   *  first non-cooldown model of the chosen candidate. */
  let model: string | undefined;
  const offered = modelChoices[agent];
  if (offered) {
    const modelAnswer = answers[`model_${agent}`];
    model =
      modelAnswer?.type === "choice" && modelAnswer.probabilities
        ? (argmax(modelAnswer.probabilities, offered) ?? undefined)
        : undefined;
    model ??= offered[0];
  } else if (candidate?.models?.length) {
    model = firstAvailable(candidate.models, cool) ?? candidate.models[0];
  }

  return {
    agent,
    by: "jev",
    ...(complexity ? { complexity } : {}),
    ...(effort ? { effort } : {}),
    ...(model ? { model } : {}),
    probabilities: {
      ...(agentAnswer?.probabilities ? { agent: agentAnswer.probabilities } : {}),
      ...(complexityAnswer?.probabilities ? { complexity: complexityAnswer.probabilities } : {}),
    },
  };
}
