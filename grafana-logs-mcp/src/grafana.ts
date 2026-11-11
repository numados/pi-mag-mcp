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
    throw new Error("Grafana endpoint must be /api or start with /api/");
  }
  const base = new URL(baseUrl);
  if (base.username || base.password) throw new Error("GRAFANA_URL must not contain embedded credentials");
  const basePath = base.pathname.replace(/\/+$/, "");
  const expectedApiPath = `${basePath}/api`;
  const target = new URL(`${base.origin}${basePath}${endpoint}`);
  if (target.origin !== base.origin) throw new Error("Grafana endpoint must stay on the configured origin");
  if (target.pathname !== expectedApiPath && !target.pathname.startsWith(`${expectedApiPath}/`)) {
    throw new Error("Grafana endpoint must stay within the configured /api path");
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
  const { authHeader, ...rest } = options;
  const headers: Record<string, string> = { ...rest.headers };
  if (authHeader) headers.Authorization = authHeader;
  return fetch(url, {
    ...rest,
    headers,
    redirect: "error",
    signal: combineSignal(30_000, signal),
  });
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
