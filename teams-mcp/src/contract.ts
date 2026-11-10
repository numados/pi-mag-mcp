/**
 * Single owner of the teams-mcp contract: the one tool's input and output
 * schemas, the limits and the environment name. No other module restates them.
 */
import { z } from "zod";

export const STATUSES = ["ok", "empty", "unavailable", "cancelled"] as const;
export type TeamsStatus = (typeof STATUSES)[number];

/** Structured failure causes. Notes and guidance derive from these alone. */
export const FAILURE_KINDS = [
  "auth",
  "not-found",
  "rate-limited",
  "timeout",
  "cancelled",
  "malformed",
  "network",
  "busy",
  "unsupported",
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const LIMITS = {
  /** Share-URL length cap before the URL is parsed. */
  locatorMaxChars: 2_048,
  /** Graph request budget. */
  httpStageMs: 30_000,
  /** Response body cap; larger bodies abort instead of buffering. */
  maxResponseBytes: 8_000_000,
  /** Rendered message cap; truncation is reported, never silent. */
  messageTextMaxChars: 40_000,
  /** Child-process output cap (the az CLI token fetch). */
  subprocessOutputMaxBytes: 1_000_000,
} as const;

export const ENV = {
  teamsAccessToken: "TEAMS_ACCESS_TOKEN",
} as const;

export const teamsMessageInputSchema = z.strictObject({
  url: z
    .string()
    .trim()
    .min(1, "a Teams message URL is required")
    .max(LIMITS.locatorMaxChars, `url must be at most ${LIMITS.locatorMaxChars} characters`)
    .describe(
      "Full teams.microsoft.com message URL, e.g. https://teams.microsoft.com/l/message/THREAD_ID/MESSAGE_ID?groupId=...&channelName=...",
    ),
});
export type TeamsMessageInput = z.infer<typeof teamsMessageInputSchema>;

export const teamsMessageOutputSchema = z.object({
  status: z.enum(STATUSES),
  messageId: z.string(),
  author: z.string(),
  created: z.string(),
  edited: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  reason: z.enum(FAILURE_KINDS).nullable(),
  notes: z.array(z.string()),
});
export type TeamsMessageOutput = z.infer<typeof teamsMessageOutputSchema>;

/** True for statuses the model must treat as execution failures. */
export function isFailureStatus(status: TeamsStatus): boolean {
  return status === "unavailable" || status === "cancelled";
}
