/**
 * DuckDuckGo backend: the free, key-less search path.
 *
 * Two transports, one provider: the unofficial scrape API
 * (`duck-duck-scrape`) and the lite HTML page. They are not independent
 * suppliers — both depend on DuckDuckGo and its anti-bot protection — so a
 * failure of both is reported as one provider failing, not as two (research §4).
 */
import type { ChainStep, FailureReason, SearchResultItem } from "./contract.js";
import { LIMITS } from "./contract.js";
import { classifyHttpStatus, classifyThrown, readTextBounded } from "./http.js";
import { clampSnippet, isSafeHttpUrl, stripHtml } from "./text.js";

export interface ProviderOutcome {
  results: SearchResultItem[];
  droppedUnsafeUrls: number;
  /** True when the provider offered more usable results than were returned. */
  resultsTruncated?: boolean;
  /** Set when the provider produced no usable results; eligible for fallback. */
  error?: string;
  /** Structured cause, set whenever `error` is set. */
  reason?: FailureReason;
  /** Provider-advised wait, when the provider supplied one. */
  retryAfterSec?: number;
  /**
   * True when the transport answered but did not look like a result page at
   * all. Such a response must never be reported as "no matches" (research §3).
   */
  unrecognized?: boolean;
}

/** Minimal attribute reader, so attribute order and quoting style stop mattering. */
function readAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = tag.match(pattern);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasClass(tag: string, className: string): boolean {
  const value = readAttribute(tag, "class");
  return value ? value.split(/\s+/).includes(className) : false;
}

/** Resolve a DDG lite redirect (`//duckduckgo.com/l/?uddg=...`) to its target. */
export function resolveDdgUrl(raw: string): string {
  const trimmed = raw.trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(absolute);
    const target = parsed.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : absolute;
  } catch {
    return absolute;
  }
}

/** Whether a lite page carries any marker of a results listing at all. */
export function looksLikeResultsPage(html: string): boolean {
  return /result-link|result-snippet|result__a|no-results/i.test(html);
}

function isChallengePage(html: string): boolean {
  return (
    /<form\b[^>]*\bid\s*=\s*["']challenge-form["']/i.test(html) ||
    /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/anomaly\.js(?:[?"'])/i.test(html) ||
    /\bcaptcha\b/i.test(html)
  );
}

const ANCHOR_PATTERN = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
const SNIPPET_CELL_PATTERN = /<td\b[^>]*class\s*=\s*["'][^"']*result-snippet[^"']*["'][^>]*>[\s\S]*?<\/td>/gi;

/**
 * Parse a DDG lite page.
 *
 * Links and snippet cells are collected with their document offsets and
 * replayed in order: a link opens an entry, a snippet fills the nearest
 * preceding entry that has none yet. The previous index-based pairing attached
 * one page's snippet to another page's link whenever a link had no snippet
 * (research §3).
 */
export function parseDdgLite(html: string, maxResults: number): ProviderOutcome {
  interface Event {
    at: number;
    title?: string;
    url?: string;
    snippet?: string;
  }
  const events: Event[] = [];

  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const anchor = match[0];
    if (!hasClass(anchor, "result-link")) continue;
    const href = readAttribute(anchor, "href");
    if (!href) continue;
    const inner = anchor.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>$/i, "");
    events.push({ at: match.index ?? 0, title: stripHtml(inner) || "(no title)", url: resolveDdgUrl(href) });
  }
  for (const match of html.matchAll(SNIPPET_CELL_PATTERN)) {
    const inner = match[0].replace(/^<td\b[^>]*>/i, "").replace(/<\/td>$/i, "");
    const snippet = stripHtml(inner);
    if (snippet) events.push({ at: match.index ?? 0, snippet });
  }
  events.sort((a, b) => a.at - b.at);

  const entries: Array<{ title: string; url: string; snippet: string }> = [];
  let droppedUnsafeUrls = 0;
  for (const event of events) {
    if (event.url !== undefined && event.title !== undefined) {
      if (!isSafeHttpUrl(event.url)) {
        droppedUnsafeUrls++;
        continue;
      }
      entries.push({ title: event.title, url: event.url, snippet: "" });
      continue;
    }
    if (event.snippet !== undefined && entries.length > 0) {
      const nearest = entries[entries.length - 1];
      if (nearest && nearest.snippet === "") nearest.snippet = event.snippet;
    }
  }

  const results = entries.slice(0, maxResults).map((entry) => {
    const clamped = clampSnippet(entry.snippet, LIMITS.snippetMaxChars);
    return {
      title: entry.title,
      url: entry.url,
      snippet: clamped.snippet,
      snippetTruncated: clamped.truncated,
    };
  });
  return { results, droppedUnsafeUrls, resultsTruncated: entries.length > maxResults };
}

function emptyOutcome(
  message: string,
  reason: FailureReason,
  extra: Partial<ProviderOutcome> = {},
): ProviderOutcome {
  return { results: [], droppedUnsafeUrls: 0, error: message, reason, ...extra };
}

/** Map scrape-API records, validating each field instead of trusting the shape. */
export function mapScrapeResults(raw: unknown, maxResults: number): ProviderOutcome {
  if (!Array.isArray(raw)) {
    return emptyOutcome("scrape API returned an unexpected payload", "malformed", { unrecognized: true });
  }
  const results: SearchResultItem[] = [];
  let droppedUnsafeUrls = 0;
  let usable = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = typeof record["url"] === "string" ? record["url"] : "";
    if (!isSafeHttpUrl(url)) {
      droppedUnsafeUrls++;
      continue;
    }
    usable++;
    if (results.length >= maxResults) continue;
    const title = typeof record["title"] === "string" ? stripHtml(record["title"]) : "";
    const description = typeof record["description"] === "string" ? record["description"] : "";
    const clamped = clampSnippet(description, LIMITS.snippetMaxChars);
    results.push({
      title: title || "(no title)",
      url,
      snippet: clamped.snippet,
      snippetTruncated: clamped.truncated,
    });
  }
  return { results, droppedUnsafeUrls, resultsTruncated: usable > maxResults };
}

function describeError(error: unknown, signal: AbortSignal): { message: string; reason: FailureReason } {
  const info = classifyThrown(error, signal);
  return { message: info.message, reason: info.reason };
}

async function searchViaScrapeApi(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ProviderOutcome> {
  const { search, SafeSearchType } = await import("duck-duck-scrape");
  // `signal` reaches Needle, so cancellation stops the request, not just the await.
  const response = await search(query, { safeSearch: SafeSearchType.MODERATE }, { signal });
  if (!response || typeof response !== "object") {
    return emptyOutcome("scrape API returned an unexpected payload", "malformed", { unrecognized: true });
  }
  if (response.noResults) return { results: [], droppedUnsafeUrls: 0 };
  return mapScrapeResults(response.results, maxResults);
}

async function searchViaLitePage(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<ProviderOutcome> {
  const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    signal,
    headers: { accept: "text/html" },
  });
  const html = await readTextBounded(response);

  if (response.status !== 200) {
    const info = classifyHttpStatus(response.status);
    return emptyOutcome(`DuckDuckGo ${info.message}`, info.reason);
  }
  if (isChallengePage(html)) {
    return emptyOutcome("DuckDuckGo served a bot challenge instead of results", "blocked", {
      unrecognized: true,
    });
  }
  if (!looksLikeResultsPage(html)) {
    return emptyOutcome("DuckDuckGo response did not contain a result listing", "malformed", {
      unrecognized: true,
    });
  }
  return parseDdgLite(html, maxResults);
}

/**
 * Search DuckDuckGo, trying the scrape API and then the lite page.
 *
 * The second transport runs only while the caller's signal is live and the
 * overall deadline has not expired (research §3: no new work after
 * cancellation).
 */
export async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<{ outcome: ProviderOutcome; step: ChainStep }> {
  const failures: Array<{ message: string; reason: FailureReason }> = [];
  for (const transport of [searchViaScrapeApi, searchViaLitePage]) {
    if (signal.aborted) break;
    try {
      const outcome = await transport(query, maxResults, signal);
      if (outcome.error) {
        failures.push({ message: outcome.error, reason: outcome.reason ?? "unknown" });
        continue;
      }
      return {
        outcome,
        step: { provider: "duckduckgo", outcome: outcome.results.length > 0 ? "ok" : "empty" },
      };
    } catch (error) {
      failures.push(describeError(error, signal));
    }
  }
  const cause = failures[0]?.reason ?? "unknown";
  const message = failures.map((failure) => failure.message).join("; ") || "no transport was attempted";
  return {
    outcome: { results: [], droppedUnsafeUrls: 0, error: message, reason: cause },
    step: { provider: "duckduckgo", outcome: "error", error: message, reason: cause },
  };
}
