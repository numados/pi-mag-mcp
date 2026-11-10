/**
 * Confluence tool handlers: locator validation, credential use and the
 * projection of REST data into the advertised output shape.
 *
 * The locator is validated before any credential is read, so a malformed URL
 * never triggers a request.
 */
import {
  LIMITS,
  type ConfluenceCommentsOutput,
  type ConfluencePageOutput,
  type ConfluenceSearchInput,
  type ConfluenceSearchOutput,
  type FailureKind,
} from "./contract.js";
import { RemoteError } from "./http.js";
import {
  clampText,
  confluenceNote,
  getComments,
  getPage,
  htmlToText,
  parsePageId,
  search,
  withAuth,
} from "./confluence.js";

function pageFailure(reason: FailureKind | null, notes: string[]): ConfluencePageOutput {
  return {
    status: "unavailable",
    pageId: null,
    title: "",
    type: "",
    spaceKey: "",
    version: null,
    updated: "",
    url: "",
    text: "",
    textTruncated: false,
    reason,
    notes,
  };
}

function commentsFailure(reason: FailureKind | null, notes: string[]): ConfluenceCommentsOutput {
  return { status: "unavailable", pageId: null, count: 0, comments: [], truncated: false, reason, notes };
}

function searchFailure(cql: string, reason: FailureKind | null, notes: string[]): ConfluenceSearchOutput {
  return {
    status: "unavailable",
    cql,
    count: 0,
    results: [],
    truncated: false,
    droppedUnsafeUrls: 0,
    reason,
    notes,
  };
}

function failureOf(error: unknown): { reason: FailureKind; note: string } {
  if (error instanceof RemoteError) return { reason: error.failure.kind, note: confluenceNote(error.failure) };
  const message = error instanceof Error ? error.message : String(error);
  return { reason: "unknown", note: `The Confluence read failed: ${message}` };
}

const MISSING_LOCATOR =
  "Could not find a page id in that value. Pass a numeric page id or a Confluence page/blog URL.";

export async function readConfluencePage(url: string, signal?: AbortSignal): Promise<ConfluencePageOutput> {
  const pageId = parsePageId(url);
  if (!pageId) return pageFailure("unsupported", [MISSING_LOCATOR]);

  try {
    return await withAuth(async (credentials) => {
      const page = await getPage(credentials, pageId, signal);
      const clamped = clampText(htmlToText(page.html), LIMITS.pageTextMaxChars);
      return {
        status: "ok" as const,
        pageId: page.id,
        title: page.title,
        type: page.type,
        spaceKey: page.spaceKey,
        version: page.version,
        updated: page.updated,
        url: page.url,
        text: clamped.text,
        textTruncated: clamped.truncated,
        reason: null,
        notes: [],
      };
    });
  } catch (error) {
    const failure = failureOf(error);
    return pageFailure(failure.reason, [failure.note]);
  }
}

export async function readConfluenceComments(url: string, signal?: AbortSignal): Promise<ConfluenceCommentsOutput> {
  const pageId = parsePageId(url);
  if (!pageId) return commentsFailure("unsupported", [MISSING_LOCATOR]);

  try {
    return await withAuth(async (credentials) => {
      const { comments, truncated } = await getComments(credentials, pageId, signal);
      return {
        // Zero comments is a successful read that matched nothing, not an error.
        status: comments.length === 0 ? ("empty" as const) : ("ok" as const),
        pageId,
        count: comments.length,
        comments,
        truncated,
        reason: null,
        notes: truncated ? [`The API returned the first ${comments.length} comments.`] : [],
      };
    });
  } catch (error) {
    const failure = failureOf(error);
    return commentsFailure(failure.reason, [failure.note]);
  }
}

export async function searchConfluence(
  input: ConfluenceSearchInput,
  signal?: AbortSignal,
): Promise<ConfluenceSearchOutput> {
  try {
    return await withAuth(async (credentials) => {
      const { results, truncated } = await search(credentials, input.cql, input.limit, signal);
      const usable = results.filter((result) => !result.unsafeUrl);
      const droppedUnsafeUrls = results.length - usable.length;
      return {
        // Zero matches is a successful search, not a failure.
        status: usable.length === 0 ? ("empty" as const) : ("ok" as const),
        cql: input.cql,
        count: usable.length,
        results: usable.map((result) => ({
          id: result.id,
          type: result.type,
          title: result.title,
          spaceKey: result.spaceKey,
          url: result.url,
          excerpt: result.excerpt,
          excerptTruncated: result.excerptTruncated,
        })),
        truncated,
        droppedUnsafeUrls,
        reason: null,
        notes: [],
      };
    });
  } catch (error) {
    const failure = failureOf(error);
    return searchFailure(input.cql, failure.reason, [failure.note]);
  }
}

