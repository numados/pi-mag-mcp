/**
 * Teams/Graph behaviour: strict URL parsing before auth, token normalization,
 * Graph request construction and payload validation.
 *
 * No token, no CLI and no network: `fetch` is replaced where the transport is
 * exercised.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { RemoteError } from "../dist/http.js";
import { parseAzToken, parseExpiry } from "../dist/teams-auth.js";
import { findChannel, mapGraphMessage, parseTeamsUrl, renderMessage } from "../dist/teams-graph.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SHARE_URL =
  "https://teams.microsoft.com/l/message/19%3Aabc%40thread.tacv2/1729012345678?tenantId=t1&groupId=g1&channelName=Dev%20Chat&teamName=Team";

test("a share URL is parsed into its components", () => {
  const parsed = parseTeamsUrl(SHARE_URL);
  assert.equal(parsed.messageId, "1729012345678");
  assert.equal(parsed.threadId, "19:abc@thread.tacv2", "path segments are decoded");
  assert.equal(parsed.teamId, "g1");
  assert.equal(parsed.channelName, "Dev Chat");
  assert.equal(parsed.teamName, "Team");
});

test("channelName defaults to General, but a missing groupId is rejected", () => {
  assert.equal(parseTeamsUrl("https://teams.microsoft.com/l/message/abc/42?groupId=g").channelName, "General");
  assert.throws(() => parseTeamsUrl("https://teams.microsoft.com/l/message/abc/42"), /groupId/);
});

test("foreign hosts, non-https URLs and wrong paths are rejected before auth", () => {
  for (const bad of [
    "http://teams.microsoft.com/l/message/a/1?groupId=g",
    "https://evil.example/l/message/a/1?groupId=g",
    "https://teams.microsoft.com/channel/a/1?groupId=g",
    "https://teams.microsoft.com/l/message/only-one?groupId=g",
    "not a url",
  ]) {
    assert.throws(() => parseTeamsUrl(bad), undefined, `${bad} must be rejected`);
  }
});

test("JWT expiry is read from the payload, and a non-JWT is refused", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
  assert.equal(parseExpiry(`header.${payload}.signature`), 1_800_000_000_000);
  assert.equal(parseExpiry("not-a-jwt"), null);
});

test("an az response is normalized without trusting its shape", () => {
  const token = parseAzToken(JSON.stringify({ accessToken: "abc", expiresOn: "2030-01-01T00:00:00Z", tokenType: "Bearer" }));
  assert.equal(token.accessToken, "abc");
  assert.equal(token.source, "az");
  assert.ok(token.expiresAt > Date.now());
  assert.equal(parseAzToken("{}"), null);
  assert.equal(parseAzToken("<html>error</html>"), null);
});

test("the Graph channel query is encoded once and carries the bearer token", async () => {
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuth = String(init.headers.Authorization);
    return new Response(JSON.stringify({ value: [{ id: "chan-1", displayName: "Dev Chat" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const channel = await findChannel("token-1", "team-1", "Dev Chat");
  assert.deepEqual(channel, { id: "chan-1", displayName: "Dev Chat" });
  assert.equal(seenAuth, "Bearer token-1");
  assert.match(seenUrl, /^https:\/\/graph\.microsoft\.com\/v1\.0\/teams\/team-1\/channels\?/);
  assert.match(seenUrl, /%24filter=displayName\+eq\+%27Dev\+Chat%27/, "$filter is query-encoded");
  assert.equal(seenUrl.includes("$filter=displayName eq"), false, "no raw spaces or quotes in the URL");
});

test("a channel whose name does not match is not used", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ value: [{ id: "chan-2", displayName: "General" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  assert.equal(await findChannel("token-1", "team-1", "Dev Chat"), null, "a partial filter match must not read the wrong channel");
});

test("a Graph payload without an id is a malformed boundary", () => {
  assert.throws(() => mapGraphMessage({ body: { content: "x" } }), (error) => error instanceof RemoteError && error.failure.kind === "malformed");
});

test("message rendering keeps http attachments, drops other schemes and reports truncation", () => {
  const message = mapGraphMessage({
    id: "m1",
    body: { contentType: "html", content: "<p>Hello</p><p>world</p>" },
    from: { user: { displayName: "Ada" } },
    createdDateTime: "2026-02-02T10:00:00Z",
    attachments: [
      { name: "a.pdf", contentType: "application/pdf", contentUrl: "https://x.example/a.pdf" },
      { name: "b", contentType: "text/plain", contentUrl: "javascript:alert(1)" },
    ],
    reactions: [{ reactionType: "like" }, { reactionType: "like" }],
  });

  const rendered = renderMessage(message);
  assert.match(rendered.text, /Hello\nworld/);
  assert.match(rendered.text, /https:\/\/x\.example\/a\.pdf/);
  assert.doesNotMatch(rendered.text, /javascript:/);
  assert.match(rendered.text, /👍 ×2/);
  assert.equal(rendered.truncated, false);
});
