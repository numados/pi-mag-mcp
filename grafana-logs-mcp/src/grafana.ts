/**
 * Transport boundary: URL pinning, verified-TLS fetch with a hard timeout,
 * and the Quickwit query payload builder. Pure parts are unit tested.
 *
 * Security rules owned here (server.ts never restates them):
 *   - raw endpoints must be /api paths on the configured origin,
 *   - GRAFANA_URL must not carry embedded credentials,
 *   - redirects are refused (redirect: "error") so a 30x cannot move
 *     an authenticated request off-origin,
 *   - TLS verification is never disabled; a corporate CA is supplied via
 *     NODE_EXTRA_CA_CERTS on the server environment.
 */

import { GrafanaConfigurationError, parseGrafanaUrl } from "./config.js";

export class GrafanaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrafanaRequestError";
  }
}

/** Only our fixed diagnostics are safe to expose; fetch errors may quote credentials. */
export function requestErrorMessage(error: unknown): string {
  if (error instanceof GrafanaConfigurationError || error instanceof GrafanaRequestError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "The Grafana request was cancelled or timed out";
  }
  return "The Grafana request failed; check configuration, credentials and network access";
}

export function combineSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface GrafanaRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Fully-formed Authorization header value; attached here and nowhere else. */
  authHeader?: string;
  signal?: AbortSignal;
}

/** Resolve one Grafana API path without allowing a caller to change origin. */
export function grafanaApiUrl(baseUrl: string, endpoint: string): string {
  if (!endpoint.startsWith("/api") || (endpoint.length > 4 && endpoint[4] !== "/")) {
    throw new GrafanaRequestError("Grafana endpoint must be /api or start with /api/");
  }
  const base = parseGrafanaUrl(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const expectedApiPath = `${basePath}/api`;
  const target = new URL(`${base.origin}${basePath}${endpoint}`);
  if (target.origin !== base.origin) throw new GrafanaRequestError("Grafana endpoint must stay on the configured origin");
  if (target.pathname !== expectedApiPath && !target.pathname.startsWith(`${expectedApiPath}/`)) {
    throw new GrafanaRequestError("Grafana endpoint must stay within the configured /api path");
  }
  return target.toString();
}

export async function grafanaFetch(
  url: string,
  options: Omit<GrafanaRequestOptions, "signal"> = {},
  signal?: AbortSignal,
): Promise<Response> {
  // Single injection point for credentials: the auth header is attached here
  // so both tools and every future caller behave the same, and `redirect:
  // "error"` below guarantees the header can never be replayed to another
  // origin by a redirect.
  try {
    const { authHeader, ...rest } = options;
    const headers = new Headers(rest.headers);
    if (authHeader) headers.set("Authorization", authHeader);
    // Check the final URL and all authorization headers before any I/O,
    // including callers that bypass loadConfig.
    parseGrafanaUrl(url, headers.has("Authorization"));
    return await fetch(url, {
      ...rest,
      headers,
      redirect: "error",
      signal: combineSignal(30_000, signal),
    });
  } catch (error) {
    throw new GrafanaRequestError(requestErrorMessage(error));
  }
}

export interface QueryPayload {
  queries: Array<{
    refId: string;
    datasource: { type: string; uid: string };
    rawQuery: boolean;
    query: string;
    limit: number;
    sortDirection: "desc";
    metrics: Array<{ id: string; type: string }>;
    bucketAggs: unknown[];
    timeField: string;
  }>;
  from: string;
  to: string;
}

export function buildQueryPayload(
  query: string,
  datasourceType: string,
  datasourceUid: string,
  timeRange: string,
  limit: number,
): QueryPayload {
  return {
    queries: [
      {
        refId: "A",
        datasource: { type: datasourceType, uid: datasourceUid },
        rawQuery: true,
        query,
        limit,
        sortDirection: "desc",
        metrics: [{ id: "3", type: "logs" }],
        bucketAggs: [],
        timeField: "",
      },
    ],
    from: timeRange,
    to: "now",
  };
}
