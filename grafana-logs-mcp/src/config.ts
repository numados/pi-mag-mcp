/**
 * grafana-logs-mcp configuration. Env-only, all machine-local; nothing is
 * defaulted except the Quickwit datasource type. The env parameter keeps the
 * loader testable without mutating process.env.
 */

export interface GrafanaConfig {
  url: string;
  datasourceUid: string;
  datasourceType: string;
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
  return {
    url: url.replace(/\/+$/, ""),
    datasourceUid,
    datasourceType: env.GRAFANA_DATASOURCE_TYPE ?? "quickwit-quickwit-datasource",
  };
}
