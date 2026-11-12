/** Environment configuration and validation. Errors contain variable names, never values. */

export const DEFAULT_DATASOURCE_TYPE = "quickwit-quickwit-datasource";

export class GrafanaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrafanaConfigurationError";
  }
}

export interface GrafanaConfig {
  url: string;
  datasourceUid: string;
  datasourceType: string;
  authHeader: string | undefined;
}

/** Shared URL policy for startup validation and the outbound request boundary. */
export function parseGrafanaUrl(value: string, authenticated = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GrafanaConfigurationError("GRAFANA_URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GrafanaConfigurationError("GRAFANA_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new GrafanaConfigurationError("GRAFANA_URL must not contain embedded credentials");
  }
  if (authenticated && url.protocol !== "https:") {
    throw new GrafanaConfigurationError("GRAFANA_API_TOKEN requires an HTTPS GRAFANA_URL");
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GrafanaConfig {
  const url = env.GRAFANA_URL?.trim();
  const datasourceUid = env.GRAFANA_DATASOURCE_UID?.trim();
  if (!url || !datasourceUid) {
    throw new GrafanaConfigurationError(
      "GRAFANA_URL and GRAFANA_DATASOURCE_UID must be set " +
        "(see config.example.json / the mcp.json server entry env)",
    );
  }
  const token = env.GRAFANA_API_TOKEN?.trim();
  // RFC 6750 bearer-token syntax. Validate before Node can quote a malformed
  // header (and its credential) in an exception message.
  if (token && !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
    throw new GrafanaConfigurationError("GRAFANA_API_TOKEN has an invalid bearer-token format");
  }
  parseGrafanaUrl(url, Boolean(token));
  return {
    url: url.replace(/\/+$/, ""),
    datasourceUid,
    datasourceType: env.GRAFANA_DATASOURCE_TYPE?.trim() || DEFAULT_DATASOURCE_TYPE,
    authHeader: token ? `Bearer ${token}` : undefined,
  };
}
