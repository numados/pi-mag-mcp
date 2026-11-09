/**
 * Tavily backend for `mode: "deep"`.
 *
 * Two access paths with different cost semantics, and the difference is
 * enforced here rather than described in prose (research §3, §8):
 *
 * - keyless: documented free tier, no `Authorization` header at all;
 * - account: sends the key and therefore spends account credits, so it is
 *   only reachable when the operator opted in (`WEB_SEARCH_ALLOW_QUOTA=1`).
 *
 * A key in the environment is not permission to spend it.
 */
import type { ChainStep, FailureReason, SearchResultItem } from "./contract.js";
import { ENV, LIMITS } from "./contract.js";
import type { ProviderOutcome } from "./ddg.js";
import { classifyHttpStatus, classifyThrown, parseRetryAfter, readJsonBounded } from "./http.js";
import { clampSnippet, isSafeHttpUrl, stripHtml } from "./text.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export interface TavilyCredentials {
  /** Whether account credits may be spent for this request. */
  allowQuota: boolean;
  apiKey?: string;
}

/** Read the quota decision from the environment; the only place that does. */
export function readTavilyCredentials(env: NodeJS.ProcessEnv = process.env): TavilyCredentials {
  const key = env[ENV.tavilyKey];
  return {
    allowQuota: env[ENV.allowQuota] === "1",
    ...(key ? { apiKey: key } : {}),
  };
}

/**
 * Validate a Tavily payload at the boundary.
 *
 * `content: null` used to survive the mapper and crash the formatter
 * (research §3); a record without a usable http(s) URL is counted and dropped.
 */
export function mapTavilyResponse(payload: unknown, maxResults: number): ProviderOutcome {
  if (typeof payload !== "object" || payload === null) {
    return {
      results: [],
      droppedUnsafeUrls: 0,
      error: "Tavily returned an unexpected payload",
      reason: "malformed",
      unrecognized: true,
    };
  }
  const body = payload as Record<string, unknown>;
  const rawResults = body["results"];
  if (rawResults !== undefined && !Array.isArray(rawResults)) {
    return {
      results: [],
      droppedUnsafeUrls: 0,
      error: "Tavily returned a malformed results field",
      reason: "malformed",
      unrecognized: true,
    };
  }

  const results: SearchResultItem[] = [];
  let droppedUnsafeUrls = 0;
  let usable = 0;
  for (const raw of rawResults ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const url = typeof record["url"] === "string" ? record["url"] : "";
    if (!isSafeHttpUrl(url)) {
      droppedUnsafeUrls++;
      continue;
    }
    usable++;
    if (results.length >= maxResults) continue;
    const title = typeof record["title"] === "string" ? stripHtml(record["title"]) : "";
    const content = typeof record["content"] === "string" ? record["content"] : "";
    const clamped = clampSnippet(content, LIMITS.snippetMaxChars);
    results.push({
      title: title || "(no title)",
      url,
      snippet: clamped.snippet,
      snippetTruncated: clamped.truncated,
    });
  }
  return { results, droppedUnsafeUrls, resultsTruncated: usable > maxResults };
}

/** Provider-supplied detail, so a note can quote a real cause instead of guessing. */
function errorDetail(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;
  const detail = record["detail"] ?? record["error"] ?? record["message"];
  return typeof detail === "string" ? detail : "";
}

function failureOutcome(status: number, body: unknown, retryAfterSec: number | undefined): ProviderOutcome {
  const info = classifyHttpStatus(status, errorDetail(body));
  return {
    results: [],
    droppedUnsafeUrls: 0,
    error: `Tavily ${info.message}`,
    reason: info.reason,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
  };
}

async function requestTavily(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  apiKey: string | undefined,
): Promise<ProviderOutcome> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers["authorization"] = `Bearer ${apiKey}`;
  } else {
    // The free tier is selected explicitly: without this header the endpoint
    // answers 401 even though no credentials are involved (research §4).
    headers["x-tavily-access-mode"] = "keyless";
  }

  const response = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      max_results: maxResults,
      // "advanced" costs 2 credits instead of 1 (research §4).
      search_depth: "advanced",
    }),
    signal,
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await readJsonBounded(response);
    } catch {
      body = undefined;
    }
    return failureOutcome(response.status, body, parseRetryAfter(response.headers.get("retry-after")));
  }

  return mapTavilyResponse(await readJsonBounded(response), maxResults);
}

function asOutcome(error: unknown, signal: AbortSignal): ProviderOutcome {
  const info = classifyThrown(error, signal);
  return { results: [], droppedUnsafeUrls: 0, error: info.message, reason: info.reason };
}

interface Attempt {
  provider: string;
  outcome: ProviderOutcome;
}

/**
 * Run a deep search.
 *
 * Access ladder: keyless first (free), account credits only when explicitly
 * allowed. A keyless 429 is reported with its real reason and wait hint; the
 * account path never becomes a silent upgrade (research §9).
 */
export async function searchTavily(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  credentials: TavilyCredentials,
): Promise<{ outcome: ProviderOutcome; step: ChainStep }> {
  const attempts: Attempt[] = [];

  const keyless = await requestTavily(query, maxResults, signal, undefined).catch((error: unknown) =>
    asOutcome(error, signal),
  );
  attempts.push({ provider: "tavily-keyless", outcome: keyless });
  if (!keyless.error) {
    return {
      outcome: keyless,
      step: { provider: "tavily-keyless", outcome: keyless.results.length > 0 ? "ok" : "empty" },
    };
  }

  if (credentials.allowQuota && credentials.apiKey && !signal.aborted) {
    const account = await requestTavily(query, maxResults, signal, credentials.apiKey).catch((error: unknown) =>
      asOutcome(error, signal),
    );
    attempts.push({ provider: "tavily-account", outcome: account });
    if (!account.error) {
      return {
        outcome: account,
        step: { provider: "tavily-account", outcome: account.results.length > 0 ? "ok" : "empty" },
      };
    }
  }

  // Every attempt failed: report the last cause, and keep any wait hint the
  // provider actually gave (research §9: no invented wait times).
  const last = attempts[attempts.length - 1];
  const outcome = last?.outcome ?? keyless;
  const retryAfterSec = attempts
    .map((attempt) => attempt.outcome.retryAfterSec)
    .find((seconds): seconds is number => seconds !== undefined);
  const message = attempts
    .map((attempt) => `${attempt.provider}: ${attempt.outcome.error ?? "failed"}`)
    .join("; ");
  const reason: FailureReason = outcome.reason ?? "unknown";

  return {
    outcome: {
      results: [],
      droppedUnsafeUrls: 0,
      error: message,
      reason,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    },
    step: {
      provider: last?.provider ?? "tavily-keyless",
      outcome: "error",
      error: message,
      reason,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    },
  };
}
