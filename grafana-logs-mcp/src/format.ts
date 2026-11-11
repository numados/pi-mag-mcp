/**
 * Pure render helpers: turn a Grafana /api/ds/query response into readable
 * log lines, counts and field lists. No I/O, fully unit tested.
 */

interface FieldSchema {
  name: string;
  type: string;
}

interface QueryResult {
  status?: number;
  frames?: QueryFrame[];
}

interface QueryFrame {
  schema?: { fields?: FieldSchema[] };
  data?: { values?: unknown[][] };
}

function toResults(data: unknown): Record<string, QueryResult> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const results = (data as Record<string, unknown>).results;
  if (typeof results !== "object" || results === null) return undefined;
  return results as Record<string, QueryResult>;
}

export function formatTimestamp(ts: string): string {
  if (!ts || ts === "None") return "";
  try {
    const ms = Number.parseInt(ts, 10);
    if (!Number.isNaN(ms)) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) {
        return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      }
    }
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
  } catch {
    // fall through to the raw string
  }
  return ts;
}

export function formatSeverity(level: string): string {
  if (!level || level === "None") return "";
  const sev = level.toLowerCase();
  if (sev.includes("error") || sev === "err" || sev === "e" || sev === "5") return "🔴";
  if (sev.includes("warn") || sev === "w" || sev === "4") return "🟡";
  if (sev.includes("info") || sev === "i" || sev === "6" || sev === "2") return "ℹ️";
  if (sev.includes("debug") || sev === "dbg" || sev === "d" || sev === "7") return "🔍";
  if (sev.includes("fatal") || sev.includes("crit") || sev === "f") return "💀";
  if (sev.includes("trace") || sev === "t") return "⚪";
  return `[${level}]`;
}

/** Columns that are already rendered as prefix fields, not body text. */
const METADATA_FIELDS = new Set([
  "timestamp", "level", "severity", "serviceName",
  "service.name", "service", "file", "stream",
  "namespace", "pod_name", "pod_ip",
  "container_name", "container_image",
  "source_type", "threadId", "aks_host",
  "pod_labels.app.kubernetes.io/name",
  "pod_labels.app.kubernetes.io/instance",
  "pod_labels.app.kubernetes.io/managed-by",
  "pod_labels.app.kubernetes.io/version",
  "pod_labels.pod-template-hash",
  "pod_labels.helm.sh/chart",
  "pod_labels.azure.workload.identity/use",
  "pod_labels.apps",
]);

/** Format a Grafana /api/ds/query response into readable log lines. */
export function formatResults(data: unknown): string {
  try {
    const results = toResults(data);
    if (!results) return JSON.stringify(data, null, 2);

    const lines: string[] = [];
    let totalCount = 0;

    for (const [refId, result] of Object.entries(results)) {
      if (result.status && result.status >= 400) {
        lines.push(`⚠️ Query ${refId} returned status ${result.status}`);
        continue;
      }

      const frames = result.frames;
      if (!frames || frames.length === 0) continue;

      for (const frame of frames) {
        const fields = frame.schema?.fields ?? [];
        const values = frame.data?.values ?? [];
        if (values.length === 0 || (values[0]?.length ?? 0) === 0) continue;

        const rowCount = values[0]?.length ?? 0;
        const colCount = values.length;

        const colByName: Record<string, number> = {};
        for (let i = 0; i < fields.length && i < colCount; i++) {
          const field = fields[i];
          if (field) colByName[field.name] = i;
        }

        const idx = (...names: string[]): number => {
          for (const name of names) {
            const i = colByName[name];
            if (i !== undefined) return i;
          }
          return -1;
        };

        const timeIdx = idx("timestamp");
        const levelIdx = idx("level", "severity");
        const serviceIdx = idx("serviceName", "service.name", "service");
        const bodyIdx = idx("message", "body", "Message", "msg");

        for (let row = 0; row < rowCount; row++) {
          const get = (col: number): string => {
            if (col < 0 || col >= colCount) return "";
            const v = values[col]?.[row];
            if (v === null || v === undefined) return "";
            return String(v);
          };

          const ts = get(timeIdx);
          const sev = get(levelIdx);
          const svc = get(serviceIdx);
          let msg = get(bodyIdx);

          if (!msg) {
            const textParts: string[] = [];
            for (const [name, col] of Object.entries(colByName)) {
              if (METADATA_FIELDS.has(name)) continue;
              const v = get(col);
              if (v) textParts.push(`${name}=${v}`);
            }
            msg = textParts.join("  ");
          }

          const entry = `${formatTimestamp(ts)} ${formatSeverity(sev)} ${svc ? `[${svc}] ` : ""}${msg}`;
          lines.push(entry);
          totalCount++;
        }
      }
    }

    if (lines.length === 0) {
      return "No log results found for the given query and time range.";
    }
    const header = `📋 ${totalCount} log entries:\n${"─".repeat(80)}`;
    return header + "\n" + lines.join("\n");
  } catch (err) {
    return `⚠️ Error parsing results: ${err}\nRaw response:\n${JSON.stringify(data, null, 2).substring(0, 2000)}`;
  }
}

export function countResults(data: unknown): number {
  try {
    const results = toResults(data);
    if (!results) return 0;
    for (const result of Object.values(results)) {
      for (const frame of result.frames ?? []) {
        const values = frame.data?.values;
        const first = values?.[0];
        if (values && values.length > 0 && first) {
          return first.length;
        }
      }
    }
  } catch {
    // a malformed response counts as zero rows
  }
  return 0;
}

export function extractRawFrameInfo(data: unknown): string {
  try {
    const results = toResults(data);
    if (!results) return "";
    const parts: string[] = [];
    for (const [refId, result] of Object.entries(results)) {
      for (const frame of result.frames ?? []) {
        const fields = frame.schema?.fields ?? [];
        parts.push(`Available fields (${refId}): ${fields.map((f) => f.name).join(", ")}`);
      }
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

export function tryFormatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
