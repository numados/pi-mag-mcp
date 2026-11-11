/** Cooldown cache for external CLI models.
 *
 *  When a provider answers with a rate-limit / overload error, the model is
 *  parked for a TTL and excluded from routing and retry selection until the
 *  entry expires. Storage is a small JSON file shared across server runs;
 *  a missing or corrupt file degrades to an empty table — cooldown handling
 *  must never block a call. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CooldownKind = "rateLimit" | "overload";

export interface CooldownEntry {
  /** epoch ms when the model becomes routable again */
  until: number;
  kind: CooldownKind;
  reason: string;
}

export type CooldownTable = Record<string, CooldownEntry>;

/** Default TTLs (seconds). */
export const DEFAULT_TTL: Record<CooldownKind, number> = {
  rateLimit: 1800,
  overload: 300,
};

export function cooldownPath(): string {
  return (
    process.env.AGENTS_MCP_COOLDOWNS ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agents-mcp", "cooldowns.json")
  );
}

/** Load the table and prune expired entries. Corrupt file → empty table. */
export function loadCooldowns(now = Date.now(), path = cooldownPath()): CooldownTable {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: CooldownTable = {};
    for (const [model, e] of Object.entries(parsed as Record<string, CooldownEntry>)) {
      if (e && typeof e.until === "number" && e.until > now) out[model] = e;
    }
    return out;
  } catch {
    return {};
  }
}

/** Park a model. Best-effort: a write failure only means the next call may
 *  hit the same limit again — still never block the current call. */
export function recordCooldown(
  model: string,
  kind: CooldownKind,
  ttlSec: number,
  reason: string,
  path = cooldownPath(),
): void {
  try {
    const table = loadCooldowns(Date.now(), path);
    table[model] = { until: Date.now() + ttlSec * 1000, kind, reason: reason.slice(0, 200) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(table, null, 2));
  } catch {
    /* best-effort cache */
  }
}

/** Classify provider output as a cooldown-triggering error, or null.
 *  Checked against stdout+stderr of a failed CLI run. */
export function detectCooldownKind(output: string): CooldownKind | null {
  if (/529|overloaded|capacity/i.test(output)) return "overload";
  if (/429|rate.?limit|quota|resource.?exhausted|insufficient_quota|too many requests/i.test(output)) {
    return "rateLimit";
  }
  return null;
}

/** First model of `models` not on cooldown (list order = owner preference).
 *  Returns null when every candidate is parked — callers then try the list
 *  head anyway (a stale limit beats not running at all). */
export function firstAvailable(models: string[], table: CooldownTable, now = Date.now()): string | null {
  for (const m of models) {
    const e = table[m];
    if (!e || e.until <= now) return m;
  }
  return null;
}

/** Next model after `current` in `models` that is not on cooldown — the
 *  runtime rate-limit switch (same task, same effort, no re-classification). */
export function nextAvailable(
  models: string[],
  current: string,
  table: CooldownTable,
  now = Date.now(),
): string | null {
  const idx = models.indexOf(current);
  const rest = idx >= 0 ? models.slice(idx + 1) : models.filter((m) => m !== current);
  return firstAvailable(rest, table, now);
}
