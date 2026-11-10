/**
 * Confluence Cloud REST (v1 content API) with Basic auth.
 *
 * Credential priority is fixed here and nowhere else:
 *   1. the complete CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN + CONFLUENCE_BASE_URL tuple;
 *   2. the shared Atlassian token in ~/.pi/agent/jira-config.json.
 *
 * A candidate is retried only when the previous one was rejected with HTTP 401.
 * A 403, 404, timeout or cancellation is a real answer and is reported as is.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENV, JIRA_CONFIG_RELATIVE_PATH, LIMITS } from "./contract.js";
import { RemoteError, getJson, type RemoteFailure } from "./http.js";

export interface Credentials {
  email: string;
  token: string;
  baseUrl: string;
  source: "env" | "jira-config";
}

function safeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // The Cloud API lives under /wiki, so a base URL that already ends with
    // /wiki is trimmed instead of becoming /wiki/wiki/rest/...
    const path = url.pathname.replace(/\/+$/, "").replace(/\/wiki$/i, "");
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

function readJiraConfig(): { email: string; token: string; baseUrl: string } | null {
  const file = path.join(os.homedir(), JIRA_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > LIMITS.configFileMaxBytes) return null;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const token = typeof record.token === "string" ? record.token.trim() : "";
  const domain = typeof record.domain === "string" ? record.domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  if (!email || !token || !domain) return null;
  const baseUrl = safeBaseUrl(`https://${domain}`);
  if (!baseUrl) return null;
  return { email, token, baseUrl };
}

/** All known credential sources, in priority order. Never throws. */
export function getCredentialCandidates(env: NodeJS.ProcessEnv = process.env): Credentials[] {
  const candidates: Credentials[] = [];
  const email = env[ENV.confluenceEmail]?.trim() ?? "";
  const token = env[ENV.confluenceApiToken]?.trim() ?? "";
  const baseUrlRaw = env[ENV.confluenceBaseUrl];
  const baseUrl = baseUrlRaw ? safeBaseUrl(baseUrlRaw) : null;
  if (email && token && baseUrl) {
    candidates.push({ email, token, baseUrl, source: "env" });
  }

  const fallback = readJiraConfig();
  if (fallback && !candidates.some((c) => c.token === fallback.token)) {
    candidates.push({ ...fallback, source: "jira-config" });
  }
  return candidates;
}

/**
 * Run `fn` with the first candidate that works.
 *
 * Only a 401 moves to the next candidate: trying another credential after a
 * 403 or a 404 would hide the real cause and multiply requests.
 */
export async function withAuth<T>(fn: (c: Credentials) => Promise<T>): Promise<T> {
  const candidates = getCredentialCandidates();
  if (candidates.length === 0) {
    throw new RemoteError({
      kind: "auth",
      message:
        "no Confluence credentials: set CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN and CONFLUENCE_BASE_URL, " +
        "or add email/token/domain to ~/.pi/agent/jira-config.json",
    });
  }
  return withAuthCandidates(candidates, fn);
}

/** The retry rule, separated so it can be tested without touching the real config. */
export async function withAuthCandidates<T>(candidates: Credentials[], fn: (c: Credentials) => Promise<T>): Promise<T> {
  let last: RemoteError | null = null;
  for (const candidate of candidates) {
    try {
      return await fn(candidate);
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error;
      last = error;
      // Only a 401 means "wrong credential"; anything else is a real answer.
      if (error.failure.status !== 401) throw error;
    }
  }
  throw last ?? new RemoteError({ kind: "auth", message: "no Confluence credential was accepted" });
}

function authHeader(c: Credentials): string {
  return `Basic ${Buffer.from(`${c.email}:${c.token}`).toString("base64")}`;
}

async function apiGet(c: Credentials, apiPath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const url = `${c.baseUrl}/wiki${apiPath}`;
  const payload = await getJson(url, {
    headers: { Authorization: authHeader(c) },
    ...(signal ? { signal } : {}),
  });
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new RemoteError({ kind: "malformed", message: "Confluence returned a non-object payload" });
  }
  return payload as Record<string, unknown>;
}

// --------------------------------------------------------------- locators

/** Extract a numeric page/blogpost id from a Confluence URL or a bare id. */
export function parsePageId(input: string): string | null {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  const pages = value.match(/\/(?:pages|blog(?:post)?\/[\d/]+)\/(\d+)/i);
  if (pages?.[1]) return pages[1];
  const query = value.match(/[?&]pageId=(\d+)/i);
  if (query?.[1]) return query[1];
  const trailing = value.match(/\/(\d{6,})(?:[/?#]|$)/);
  return trailing?.[1] ?? null;
}

// --------------------------------------------------------------- payloads

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface Page {
  id: string;
  type: string;
  title: string;
  spaceKey: string;
  version: number | null;
  updated: string;
  url: string;
  html: string;
}

export async function getPage(c: Credentials, pageId: string, signal?: AbortSignal): Promise<Page> {
  const data = await apiGet(
    c,
    `/rest/api/content/${encodeURIComponent(pageId)}?expand=body.view,version,space`,
    signal,
  );
  if (asString(data.id) === "") {
    throw new RemoteError({ kind: "malformed", message: "Confluence page payload has no id" });
  }
  const space = asRecord(data.space);
  const version = asRecord(data.version);
  const links = asRecord(data._links);
  return {
    id: asString(data.id),
    type: asString(data.type),
    title: asString(data.title),
    spaceKey: asString(space.key),
    version: asNumber(version.number),
    updated: asString(version.when),
    url: `${c.baseUrl}/wiki${asString(links.webui)}`,
    html: asString(asRecord(asRecord(data.body).view).value),
  };
}

export interface Comment {
  author: string;
  created: string;
  text: string;
}

export async function getComments(
  c: Credentials,
  pageId: string,
  signal?: AbortSignal,
): Promise<{ comments: Comment[]; truncated: boolean }> {
  const data = await apiGet(
    c,
    `/rest/api/content/${encodeURIComponent(pageId)}/child/comment?expand=body.view,history&limit=${LIMITS.commentsMax}`,
    signal,
  );
  const rows = asArray(data.results);
  const comments = rows.slice(0, LIMITS.commentsMax).map((row) => {
    const record = asRecord(row);
    const history = asRecord(record.history);
    return {
      author: asString(asRecord(history.createdBy).displayName) || "unknown",
      created: asString(history.createdDate),
      text: clampText(htmlToText(asString(asRecord(asRecord(record.body).view).value)), LIMITS.commentTextMaxChars).text,
    };
  });
  // Only a follow-up link proves that more comments exist; a count equal to the
  // page limit does not.
  const hasNext = asString(asRecord(data._links).next) !== "";
  return { comments, truncated: hasNext };
}

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  spaceKey: string;
  url: string;
  excerpt: string;
  excerptTruncated: boolean;
  unsafeUrl: boolean;
}

export async function search(
  c: Credentials,
  cql: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const data = await apiGet(
    c,
    `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space`,
    signal,
  );
  const rows = asArray(data.results);
  const results = rows.slice(0, limit).map((row) => {
    const record = asRecord(row);
    const url = `${c.baseUrl}/wiki${asString(asRecord(record._links).webui)}`;
    const excerpt = clampText(htmlToText(asString(record.excerpt)), LIMITS.searchExcerptMaxChars);
    return {
      id: asString(record.id),
      type: asString(record.type),
      title: asString(record.title),
      spaceKey: asString(asRecord(record.space).key),
      url,
      excerpt: excerpt.text,
      excerptTruncated: excerpt.truncated,
      unsafeUrl: !isHttpUrl(url),
    };
  });
  const total = asNumber(data.totalSize);
  return { results, truncated: total !== null && total > results.length };
}

// ----------------------------------------------------------- HTML to text

export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface Clamped {
  text: string;
  truncated: boolean;
}

/** Clamp to a character budget; the caller reports truncation explicitly. */
export function clampText(text: string, maxChars: number): Clamped {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}…`, truncated: true };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

/** Decode HTML entities once; unknown entities stay literal. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

/**
 * Convert Confluence storage/view HTML to readable text.
 *
 * Order matters: real tags are stripped first, then entities are decoded once,
 * so `&lt;int&gt;` survives as `<int>` instead of being deleted as a tag.
 */
export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${stripTags(code)}\n\`\`\`\n`);
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, body: string) => `\n${"#".repeat(Number(level))} ${stripTags(body)}\n`);
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, body: string) => {
    const label = decodeEntities(stripTags(body)).trim();
    // Only http(s) links are rendered as links; other schemes are text only.
    if (!isHttpUrl(href)) return label || href;
    return label && label !== href ? `${label} (${href})` : href;
  });
  text = text.replace(/<\/t[dh]>/gi, " | ");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/(p|div|ul|ol|table|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = stripTags(text);
  text = decodeEntities(text);
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Render a failure cause into one actionable sentence. */
export function confluenceNote(failure: RemoteFailure): string {
  switch (failure.kind) {
    case "auth":
      return "Confluence rejected the credentials. Check CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN and CONFLUENCE_BASE_URL (a token comes from id.atlassian.com/manage-profile/security/api-tokens).";
    case "not-found":
      return "Confluence did not find that page. Check the page id and that the URL points at the intended site.";
    case "rate-limited":
      return failure.retryAfterSec === undefined
        ? "Confluence rate-limited the request. Retry later."
        : `Confluence rate-limited the request. Retry after about ${failure.retryAfterSec}s.`;
    case "timeout":
      return "The request to Confluence timed out before an answer arrived.";
    case "cancelled":
      return "The request was cancelled; no Confluence answer was read.";
    case "malformed":
      return "Confluence returned a response this server could not interpret.";
    case "network":
      return "The Confluence request failed at the network or service level.";
    default:
      return `The Confluence request failed (${failure.kind}).`;
  }
}
