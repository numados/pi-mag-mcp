/**
 * grafana-logs-mcp configuration. Env-only, all machine-local; nothing is
 * defaulted except the Quickwit datasource type. The env parameter keeps the
 * loader testable without mutating process.env.
 *
 * Authentication: GRAFANA_API_TOKEN (optional) carries a Grafana
 * service-account token or legacy API key; it becomes the fully-formed
 * Authorization header value here and grafanaFetch is the only place that
 * puts it on the wire.
 */

export interface GrafanaConfig {
  url: string;
  datasourceUid: string;
  datasourceType: string;
  /** Fully-formed Authorization header value (e.g. "Bearer …"), or undefined for anonymous requests. */
  authHeader: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrafanaConfig {
  const url = env.GRAFANA_URL;
  const datasourceUid = env.GRAFANA_DATASOURCE_UID;
  if (!url || !datasourceUid) {
    throw new Error(
      "GRAFANA_URL and GRAFANA_DATASOURCE_UID must be set " +
        "(see config.example.json / the mcp.json server entry env)",
    );
  }
  const token = env.GRAFANA_API_TOKEN?.trim();
  return {
    url: url.replace(/\/+$/, ""),
    datasourceUid,
    datasourceType: env.GRAFANA_DATASOURCE_TYPE ?? "quickwit-quickwit-datasource",
    authHeader: token ? `Bearer ${token}` : undefined,
  };
}
