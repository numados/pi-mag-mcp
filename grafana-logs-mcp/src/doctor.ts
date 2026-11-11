/**
 * grafana-logs-mcp readiness report. One owner of the doctor verdict: the
 * installer's `list` runs `node dist/server.js --doctor` and prints this
 * text; exit code 1 means a required environment value is missing.
 * Values are never printed — only their presence.
 */

export interface DoctorReport {
  text: string;
  ok: boolean;
}

export function doctorReport(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const url = env.GRAFANA_URL;
  const uid = env.GRAFANA_DATASOURCE_UID;
  const lines = [
    "grafana-logs status",
    `  GRAFANA_URL: ${url ? "set" : "missing"}`,
    `  GRAFANA_DATASOURCE_UID: ${uid ? "set" : "missing"}`,
    `  GRAFANA_DATASOURCE_TYPE: ${env.GRAFANA_DATASOURCE_TYPE ?? "quickwit-quickwit-datasource (default)"}`,
  ];
  const ok = Boolean(url && uid);
  if (!ok) {
    lines.push("  calls will answer a configuration error until both required values are set");
  }
  return { text: lines.join("\n") + "\n", ok };
}
