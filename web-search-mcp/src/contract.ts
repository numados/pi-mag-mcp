/**
 * Single owner of the web_search contract.
 *
 * The advertised input schema (tools/list), the runtime input validation
 * (SDK validates tools/call arguments against the same zod schema) and the
 * structured output schema all derive from these definitions. No other
 * module may restate these rules.
 */
import { z } from "zod";

export const SEARCH_MODES = ["auto", "deep"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const STATUSES = ["ok", "empty", "unavailable", "cancelled"] as const;
export type SearchStatus = (typeof STATUSES)[number];

/** Hard limits. One owner; pipeline and providers read these, never restate. */
export const LIMITS = {
  /** Query length cap before the request reaches a provider. */
  queryMaxChars: 400,
  maxResults: 10,
  snippetMaxChars: 400,
  /** Per-provider HTTP stage budget. */
  providerTimeoutMs: 15_000,
  /** Whole-search budget across the provider chain. */
  totalDeadlineDefaultMs: 30_000,
  totalDeadlineMaxMs: 120_000,
  /** Provider response body cap; larger bodies abort. */
  maxResponseBytes: 2_000_000,
  /** Concurrent in-flight searches; excess requests get an honest busy status. */
  maxConcurrentRequests: 4,
} as const;

/** Environment variable names. One owner; nothing else hardcodes these strings. */
export const ENV = {
  tavilyKey: "TAVILY_API_KEY",
  allowQuota: "WEB_SEARCH_ALLOW_QUOTA",
  deadlineMs: "WEB_SEARCH_DEADLINE_MS",
} as const;

export const webSearchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "query must contain at least one non-whitespace character")
    .max(LIMITS.queryMaxChars, `query must be at most ${LIMITS.queryMaxChars} characters`)
    .describe("Search query"),
  count: z
    .number()
    .int("count must be an integer")
    .min(1, "count must be at least 1")
    .max(LIMITS.maxResults, `count must be at most ${LIMITS.maxResults}`)
    .default(5)
    .describe(`Number of results, 1..${LIMITS.maxResults} (default 5)`),
  mode: z
    .enum(SEARCH_MODES)
    .default("auto")
    .describe(
      "'auto' = free DuckDuckGo search (default, no quota); " +
        "'deep' = Tavily — free keyless tier first, account credits only if WEB_SEARCH_ALLOW_QUOTA=1 and TAVILY_API_KEY are set",
    ),
});
export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

/** Machine-readable failure causes. Notes and hints derive from these alone. */
export const FAILURE_REASONS = [
  "rate-limited",
  "auth",
  "blocked",
  "timeout",
  "malformed",
  "network",
  "busy",
  "cancelled",
  "unknown",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const searchResultItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  /** True when the provider snippet exceeded the clamp and was cut. */
  snippetTruncated: z.boolean(),
});
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

export const chainStepSchema = z.object({
  provider: z.string(),
  outcome: z.enum(["ok", "empty", "error"]),
  error: z.string().optional(),
  /** Structured cause; the only input to failure notes. */
  reason: z.enum(FAILURE_REASONS).optional(),
  /** Provider-advised wait in seconds (e.g. Retry-After), when supplied. */
  retryAfterSec: z.number().int().optional(),
});
export type ChainStep = z.infer<typeof chainStepSchema>;

export const webSearchOutputSchema = z.object({
  /** ok = results found; empty = providers answered, zero matches; unavailable = every provider failed; cancelled = caller aborted. */
  status: z.enum(STATUSES),
  query: z.string(),
  mode: z.enum(SEARCH_MODES),
  /** Provider that produced the returned results, null when none did. */
  provider: z.string().nullable(),
  results: z.array(searchResultItemSchema),
  /** Every attempted provider with its outcome and failure reason. */
  chain: z.array(chainStepSchema),
  /** Present when a later provider succeeded after an earlier one failed. */
  fallback: z
    .object({ from: z.string(), to: z.string(), reason: z.string() })
    .nullable(),
  /** Number of results withheld because the provider URL was not http(s). */
  droppedUnsafeUrls: z.number().int(),
  /** True when the provider returned more valid results than `count`. */
  resultsTruncated: z.boolean(),
  notes: z.array(z.string()),
});
export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

/** True for tool results the model must treat as execution failures. */
export function isFailureStatus(status: SearchStatus): boolean {
  return status === "unavailable" || status === "cancelled";
}
