/**
 * Microsoft Graph token acquisition.
 *
 * Priority: TEAMS_ACCESS_TOKEN (browser token) → Azure CLI.
 *
 * The CLI is invoked as an argv array with no shell, asynchronously, and with
 * an allowlisted environment. It is a fallback, not a silent override: a token
 * cached here is dropped as soon as Graph rejects it.
 */
import { ENV } from "./contract.js";
import { runCommand, SubprocessError } from "./subprocess.js";

export interface Token {
  accessToken: string;
  expiresAt: number;
  tokenType: string;
  source: "env" | "az";
}

let cached: Token | null = null;

/** Decode the JWT `exp` claim; returns null when the token is not a JWT. */
export function parseExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Read a token from the environment. An expired token is returned with its real expiry. */
function envToken(env: NodeJS.ProcessEnv): Token | null {
  const raw = env[ENV.teamsAccessToken]?.trim() ?? "";
  if (!raw) return null;
  return {
    accessToken: raw,
    expiresAt: parseExpiry(raw) ?? Date.now() + 3_600_000,
    tokenType: "Bearer",
    source: "env",
  };
}

/** Parse the Azure CLI response without trusting its shape. */
export function parseAzToken(raw: string): Token | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken : "";
  if (!accessToken) return null;
  const expiresOn = typeof record.expiresOn === "string" ? Date.parse(record.expiresOn) : Number.NaN;
  const expiresAt = Number.isFinite(expiresOn) ? expiresOn : parseExpiry(accessToken) ?? Date.now() + 3_600_000;
  return {
    accessToken,
    expiresAt,
    tokenType: typeof record.tokenType === "string" ? record.tokenType : "Bearer",
    source: "az",
  };
}

export type TokenResult =
  | { ok: true; token: Token }
  | { ok: false; reason: "missing" | "expired" | "cli-failed"; detail: string };

/**
 * Acquire a usable token.
 *
 * `fresh` forces the Azure CLI path, which is how a rejected token is retried
 * once. An environment token cannot be refreshed by this server, so it is
 * reported as expired instead of being silently reused.
 */
export async function getToken(options: { fresh?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<TokenResult> {
  const env = options.env ?? process.env;
  const now = Date.now();

  if (!options.fresh) {
    if (cached && cached.expiresAt > now + 120_000) return { ok: true, token: cached };
    const fromEnv = envToken(env);
    if (fromEnv && fromEnv.expiresAt > now) {
      cached = fromEnv;
      return { ok: true, token: fromEnv };
    }
    if (fromEnv) return { ok: false, reason: "expired", detail: "TEAMS_ACCESS_TOKEN has expired" };
  } else if (cached?.source === "env") {
    // A rejected environment token cannot be refreshed; do not pretend it can.
    cached = null;
    return { ok: false, reason: "expired", detail: "TEAMS_ACCESS_TOKEN was rejected and cannot be refreshed by this server" };
  }

  try {
    const { stdout } = await runCommand(
      "az",
      [
        "account",
        "get-access-token",
        "--resource",
        "https://graph.microsoft.com",
        "--query",
        "{accessToken:accessToken,expiresOn:expiresOn,tokenType:tokenType}",
        "-o",
        "json",
      ],
      { timeoutMs: 20_000 },
    );
    const token = parseAzToken(stdout);
    if (!token) return { ok: false, reason: "cli-failed", detail: "az returned an unexpected payload" };
    cached = token;
    return { ok: true, token };
  } catch (error) {
    const detail = error instanceof SubprocessError ? error.message : "az could not be started";
    return { ok: false, reason: "cli-failed", detail };
  }
}

/** Drop the cached token, so the next call re-acquires one. */
export function clearToken(): void {
  cached = null;
}

/** Test seam: install a token without touching the environment or the CLI. */
export function setTokenForTest(token: Token | null): void {
  cached = token;
}
