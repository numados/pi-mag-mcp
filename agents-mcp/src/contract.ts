/**
 * Single owner of the agents-mcp contract: the advertised input schemas
 * (tools/list), the runtime input validation (the SDK validates tools/call
 * arguments against the same zod schemas) and the shared structured output
 * schema all derive from these definitions. No other module may restate
 * these rules.
 *
 * Schema policy, inherited from the source: loose objects — unknown keys are
 * tolerated in answers, and the envelope always validates, because a
 * delegation answer must reach the caller even when it carries extra fields.
 */
import { z } from "zod";
import { EFFORTS, MODES } from "./modes.js";

// ── input schemas ─────────────────────────────────────────────────────────

export const agentCallInputSchema = z.object({
  mode: z
    .enum(MODES)
    .describe("Answer shape: research=facts, opinion=verdict, review=confirmed findings"),
  agent: z
    .enum(["claude", "codex", "agy", "auto"])
    .describe(
      "CLI executor. 'auto' = Jev complexity routing picks the cheapest suitable agent+effort (falls back to config routing.fallback when unavailable); explicit agent skips routing",
    ),
  task: z
    .string()
    .describe("Full task context — the callee starts fresh; include file paths, decisions, constraints"),
  model: z
    .string()
    .optional()
    .describe("Override the resolved default model (including agy, when the installed CLI supports it)"),
  effort: z
    .enum(EFFORTS)
    .optional()
    .describe("Override the resolved default effort (agy: none)"),
  alias: z
    .string()
    .optional()
    .describe("claude only: subscription alias from config"),
  extra_dirs: z
    .array(z.string())
    .optional()
    .describe("agy only: extra workspace directories"),
});

export const agentsStatusInputSchema = z.object({});

// ── shared output envelope ────────────────────────────────────────────────

export const envelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional().describe("Human-readable failure reason (ok=false only)"),
  mode: z.enum(MODES).optional(),
  agent: z.enum(["claude", "codex", "agy"]).optional(),
  alias: z.string().optional().describe("claude subscription alias used"),
  routing: z
    .looseObject({
      by: z.enum(["jev", "fallback"]).optional(),
      complexity: z.enum(["standard", "complex"]).optional(),
      model: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional()
    .describe(
      "agent=auto only: how the executor was chosen (by=jev|fallback, complexity, model, probabilities, fallback reason)",
    ),
  retried: z
    .looseObject({
      from: z.string(),
      to: z.string(),
      kind: z.enum(["rateLimit", "overload"]),
    })
    .optional()
    .describe(
      "Present when the first attempt hit a provider rate limit and the call was retried on the next model of the routing candidate (no re-classification)",
    ),
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
  sandbox: z.string().optional().describe("codex only: read-only | workspace-write"),
  result: z.string().optional().describe("Agent answer (codex output cleaned)"),
  findings: z
    .array(
      z.looseObject({
        severity: z.enum(["blocker", "major", "minor"]),
        location: z.string(),
        issue: z.string(),
        evidence: z.string().optional(),
      }),
    )
    .optional()
    .describe("review mode only: parsed confirmed findings (absent when none parsed)"),
});

// ── tool surface (fixed at build time) ────────────────────────────────────

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: typeof agentCallInputSchema | typeof agentsStatusInputSchema;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "agent_call",
    title: "Agent call",
    description: [
      "Call an external agent CLI (claude / codex / agy) in an isolated process with no prior conversation — include ALL context in the task.",
      "Modes shape the answer: research (gather facts with evidence, change nothing), opinion (independent second opinion, verdict first), review (only confirmed findings, each as `- [severity] location — issue — evidence`).",
      "Agents: claude (subscriptions via config aliases), codex (effort low=read-only sandbox, medium/high=workspace-write), agy (selectable --model, default Gemini 3.8 Flash High, fast/cheap, extra_dirs extends its workspace), auto (Jev picks agent+effort by task complexity, cheapest suitable first).",
      "Use proactively: second opinion on non-trivial decisions, parallel fact-gathering, independent review. Explicit request model/effort always wins over defaults.",
    ].join(" "),
    inputSchema: agentCallInputSchema,
  },
  {
    name: "agents_status",
    title: "Agents status",
    description:
      "Doctor: CLI presence (claude/codex/agy) with install hints, subscription aliases, resolved defaults, active repo override (.agents-mcp.json).",
    inputSchema: agentsStatusInputSchema,
  },
];
