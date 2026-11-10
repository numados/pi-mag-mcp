/**
 * teams_message tool logic: validate the URL, acquire a token, resolve the
 * channel, read one message and project it to text.
 *
 * Order is deliberate: the locator is validated before any credential is read,
 * so a malformed URL never touches the CLI or the network.
 */
import type { TeamsMessageOutput } from "./contract.js";
import { RemoteError } from "./http.js";
import { clearToken, getToken, type Token } from "./teams-auth.js";
import { findChannel, getMessage, parseTeamsUrl, renderMessage, teamsNote, type ParsedTeamsUrl } from "./teams-graph.js";

function emptyOutput(notes: string[]): TeamsMessageOutput {
  return {
    status: "unavailable",
    messageId: "",
    author: "",
    created: "",
    edited: null,
    text: "",
    truncated: false,
    reason: null,
    notes,
  };
}

function tokenFailure(reason: "missing" | "expired" | "cli-failed", detail: string): TeamsMessageOutput {
  const notes =
    reason === "expired"
      ? [`${detail}. Extract a fresh token from Teams Web and set TEAMS_ACCESS_TOKEN, then retry.`]
      : [
          "No Microsoft Graph token is available. Set TEAMS_ACCESS_TOKEN from a Teams Web session, " +
            "or sign in with `az login --allow-no-subscriptions`.",
        ];
  return { ...emptyOutput(notes), reason: "auth" };
}

function failureOf(error: unknown): TeamsMessageOutput {
  if (error instanceof RemoteError) return { ...emptyOutput([teamsNote(error.failure.kind, error.failure.message)]), reason: error.failure.kind };
  const message = error instanceof Error ? error.message : String(error);
  return { ...emptyOutput([`The Teams read failed: ${message}`]), reason: "unknown" };
}

export async function fetchTeamsMessage(url: string, signal?: AbortSignal): Promise<TeamsMessageOutput> {
  let parsed: ParsedTeamsUrl;
  try {
    parsed = parseTeamsUrl(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...emptyOutput([
        `Not a usable Teams message URL: ${detail}. Expected https://teams.microsoft.com/l/message/<thread>/<message>?groupId=...`,
      ]),
      reason: "unsupported",
    };
  }

  let acquired = await getToken();
  if (!acquired.ok) {
    // An Azure CLI token can be refreshed once; an environment token cannot.
    const retry = acquired.reason === "expired" || acquired.reason === "cli-failed" ? await getToken({ fresh: true }) : acquired;
    if (!retry.ok) return tokenFailure(retry.reason, retry.detail);
    acquired = retry;
  }
  let token: Token = acquired.token;

  try {
    return await read(parsed, token, signal);
  } catch (error) {
    // A rejected token is retried once through the refreshable path only.
    if (error instanceof RemoteError && error.failure.status === 401 && token.source === "az") {
      clearToken();
      const refreshed = await getToken({ fresh: true });
      if (!refreshed.ok) return tokenFailure(refreshed.reason, refreshed.detail);
      token = refreshed.token;
      try {
        return await read(parsed, token, signal);
      } catch (retryError) {
        return failureOf(retryError);
      }
    }
    return failureOf(error);
  }
}

async function read(parsed: ParsedTeamsUrl, token: Token, signal?: AbortSignal): Promise<TeamsMessageOutput> {
  const channel = await findChannel(token.accessToken, parsed.teamId, parsed.channelName, signal);
  if (!channel) {
    return {
      ...emptyOutput([
        `Channel "${parsed.channelName}" was not found in team ${parsed.teamId}. Check the channel name in the URL or your access.`,
      ]),
      reason: "not-found",
    };
  }

  const message = await getMessage(token.accessToken, parsed, channel.id, signal);
  const rendered = renderMessage(message);
  const edited =
    message.lastModifiedDateTime && message.lastModifiedDateTime !== message.createdDateTime
      ? message.lastModifiedDateTime
      : null;

  return {
    status: "ok",
    messageId: message.id,
    author: message.author,
    created: message.createdDateTime,
    edited,
    text: rendered.text,
    truncated: rendered.truncated,
    reason: null,
    notes: [],
  };
}
