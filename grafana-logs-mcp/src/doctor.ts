/** Environment readiness; no network calls and no configuration values in the report. */
import { readFileSync } from "node:fs";
import { GrafanaConfigurationError, loadConfig } from "./config.js";

const requirements = JSON.parse(readFileSync(new URL("../requirements.json", import.meta.url), "utf8")) as {
  env: Array<{ name: string; required: boolean }>;
};

export interface DoctorReport {
  text: string;
  ok: boolean;
}

export function doctorReport(env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const lines = [
    "grafana-logs status",
    ...requirements.env.map(({ name, required }) => {
      const present = Boolean(env[name]?.trim());
      return `  ${name}: ${present ? "set" : required ? "missing" : "missing (optional)"}`;
    }),
  ];
  let ok = true;
  try {
    loadConfig(env);
  } catch (error) {
    ok = false;
    lines.push(`  configuration: ${error instanceof GrafanaConfigurationError ? error.message : "Invalid Grafana configuration"}`);
  }
  return { text: lines.join("\n") + "\n", ok };
}
