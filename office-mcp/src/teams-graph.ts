/**
 * Microsoft Graph helpers for Teams channel messages.
 *
 * Message reads use the /beta endpoint on purpose: v1.0 requires the
 * admin-consented ChannelMessage.Read.All scope, while /beta works with the
 * Teams Web Client scopes. That dependency is documented, not hidden.
 */
import { LIMITS } from "./contract.js";
import { RemoteError, getJson } from "./http.js";

const GRAPH_V1 = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";

/** The only host shape this server accepts; other share domains need evidence first. */
const TEAMS_HOST = "teams.microsoft.com";

export interface ParsedTeamsUrl {
  tenantId: string;
  teamId: string;
  channelName: string;
  messageId: string;
  threadId: string;
  teamName: string;
}

/**
 * Parse a Teams message share URL before any credential is read.
 *
 * Rejects non-https URLs, foreign hosts, incomplete /l/message paths and a
 * missing groupId instead of building a Graph request out of them.
 */
export function parseTeamsUrl(raw: string): ParsedTeamsUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("the URL must use https");
  if (parsed.hostname !== TEAMS_HOST) throw new Error(`the URL must point at ${TEAMS_HOST}`);

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "l" || segments[1] !== "message") {
    throw new Error("expected a /l/message/<thread>/<message> path");
  }
  const threadId = decodeURIComponent(segments[2] ?? "");
  const messageId = decodeURIComponent(segments[3] ?? "");
  if (!threadId || !messageId) throw new Error("the URL is missing the thread or message id");

  const params = parsed.searchParams;
  const teamId = params.get("groupId") ?? "";
  if (!teamId) throw new Error("the URL is missing the groupId parameter");

  return {
    tenantId: params.get("tenantId") ?? "",
    teamId,
    channelName: params.get("channelName") ?? "General",
    messageId,
    threadId,
    teamName: params.get("teamName") ?? "",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface GraphChannel {
  id: string;
  displayName: string;
}

export async function findChannel(
  accessToken: string,
  teamId: string,
  channelName: string,
  signal?: AbortSignal,
): Promise<GraphChannel | null> {
  // Build $filter through URLSearchParams: OData quotes are doubled, then the
  // whole value is query-encoded once, so no manual escaping is involved.
  const filter = `displayName eq '${channelName.replace(/'/g, "''")}'`;
  const query = new URLSearchParams({ $filter: filter });
  const url = `${GRAPH_V1}/teams/${encodeURIComponent(teamId)}/channels?${query.toString()}`;

  const payload = asRecord(
    await getJson(url, { headers: { Authorization: `Bearer ${accessToken}` }, ...(signal ? { signal } : {}) }),
  );
  const rows = Array.isArray(payload.value) ? payload.value : [];
  const wanted = channelName.trim().toLowerCase();
  for (const row of rows) {
    const record = asRecord(row);
    const id = asString(record.id);
    const displayName = asString(record.displayName);
    // A server that ignores or partially matches the filter must not make us
    // read a different channel: only an exact (case-insensitive) name is used.
    if (id && displayName.trim().toLowerCase() === wanted) return { id, displayName };
  }
  return null;
}

export interface GraphMessage {
  id: string;
  bodyContentType: "html" | "text";
  bodyContent: string;
  author: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  subject: string;
  importance: string;
  webUrl: string;
  attachments: Array<{ name: string; contentType: string; url: string }>;
  reactions: Array<{ type: string; displayName: string }>;
}

/** Validate the parts of a Graph message this server renders; ignore the rest. */
export function mapGraphMessage(value: unknown): GraphMessage {
  const root = asRecord(value);
  const id = asString(root.id);
  if (!id) throw new RemoteError({ kind: "malformed", message: "Graph returned a message without an id" });
  const body = asRecord(root.body);
  const contentType = asString(body.contentType) === "text" ? "text" : "html";

  const attachments = (Array.isArray(root.attachments) ? root.attachments : []).map((row) => {
    const record = asRecord(row);
    return {
      name: asString(record.name) || asString(record.id) || "unnamed",
      contentType: asString(record.contentType),
      url: asString(record.contentUrl),
    };
  });

  const reactions = (Array.isArray(root.reactions) ? root.reactions : []).map((row) => {
    const record = asRecord(row);
    return { type: asString(record.reactionType), displayName: asString(record.displayName) };
  });

  return {
    id,
    bodyContentType: contentType,
    bodyContent: asString(body.content),
    author: asString(asRecord(asRecord(root.from).user).displayName) || "unknown",
    createdDateTime: asString(root.createdDateTime),
    lastModifiedDateTime: asString(root.lastModifiedDateTime),
    subject: asString(root.subject),
    importance: asString(root.importance),
    webUrl: asString(root.webUrl),
    attachments,
    reactions,
  };
}

export async function getMessage(
  accessToken: string,
  parsed: ParsedTeamsUrl,
  channelId: string,
  signal?: AbortSignal,
): Promise<GraphMessage> {
  const url = `${GRAPH_BETA}/teams/${encodeURIComponent(parsed.teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(parsed.messageId)}`;
  const payload = await getJson(url, { headers: { Authorization: `Bearer ${accessToken}` }, ...(signal ? { signal } : {}) });
  return mapGraphMessage(payload);
}

const REACTION_EMOJI: Readonly<Record<string, string>> = {
  like: "👍",
  heart: "❤️",
  laugh: "😂",
  surprised: "😮",
  sad: "😢",
  angry: "😡",
};

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render the message body plus attachments and reactions as text. */
export interface RenderedMessage {
  text: string;
  truncated: boolean;
}

/** Render the message body plus attachments and reactions as text. */
export function renderMessage(message: GraphMessage): RenderedMessage {
  const body = message.bodyContentType === "html" ? stripHtml(message.bodyContent) : message.bodyContent;
  const blocks: string[] = [body];

  if (message.attachments.length > 0) {
    blocks.push("Attachments:");
    for (const attachment of message.attachments) {
      blocks.push(`- ${attachment.name} (${attachment.contentType})`);
      // Only http(s) links are exposed; other schemes stay out of the output.
      if (attachment.url && /^https?:\/\//i.test(attachment.url)) blocks.push(`  ${attachment.url}`);
    }
  }

  if (message.reactions.length > 0) {
    const counts = new Map<string, number>();
    for (const reaction of message.reactions) counts.set(reaction.type, (counts.get(reaction.type) ?? 0) + 1);
    blocks.push("Reactions:");
    for (const [type, count] of counts) blocks.push(`- ${REACTION_EMOJI[type] ?? type} ×${count}`);
  }

  const text = blocks.join("\n\n").trim();
  if (text.length <= LIMITS.messageTextMaxChars) return { text, truncated: false };
  return { text: `${text.slice(0, LIMITS.messageTextMaxChars)}…`, truncated: true };
}

/** A Graph failure rendered as one actionable sentence. */
export function teamsNote(kind: string, message: string): string {
  switch (kind) {
    case "auth":
      return "Microsoft Graph rejected the token. Extract a fresh token from Teams Web (F12 console) and set TEAMS_ACCESS_TOKEN, or run az login --allow-no-subscriptions.";
    case "not-found":
      return "Graph did not find that message or channel. Check the share URL and your access to the team.";
    case "rate-limited":
      return `Graph rate-limited the request. ${message}`;
    case "timeout":
      return "The Graph request timed out before an answer arrived.";
    case "cancelled":
      return "The request was cancelled; no Graph answer was read.";
    case "malformed":
      return "Graph returned a response this server could not interpret.";
    default:
      return `The Graph request failed: ${message}`;
  }
}
