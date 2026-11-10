/**
 * Bounded HTTP for remote reads: one stage timeout, caller cancellation and a
 * hard body-size cap, so a hostile or runaway response cannot exhaust memory.
 */
import { LIMITS, type FailureKind } from "./contract.js";

export class ResponseTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`response body exceeded ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** Compose caller cancellation with a stage timeout. */
export function stageSignal(signal: AbortSignal | undefined, timeoutMs: number = LIMITS.httpStageMs): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Read a body as text, aborting once `maxBytes` is exceeded. */
export async function readTextBounded(response: Response, maxBytes: number = LIMITS.maxResponseBytes): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (Number.isFinite(size) && size > maxBytes) throw new ResponseTooLargeError(maxBytes);
  }
  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new ResponseTooLargeError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Read and parse JSON under the same byte budget. */
export async function readJsonBounded(response: Response, maxBytes: number = LIMITS.maxResponseBytes): Promise<unknown> {
  const text = await readTextBounded(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError("response body is not valid JSON");
  }
}

/** Parse `Retry-After` (seconds or HTTP-date) into whole seconds. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? seconds : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const seconds = Math.ceil((when - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/** A classified remote failure: stable cause plus a message safe to show. */
export interface RemoteFailure {
  kind: FailureKind;
  message: string;
  status?: number;
  retryAfterSec?: number;
}

/** Map an HTTP status to a cause. One owner for the whole rule. */
export function classifyHttpStatus(status: number, retryAfterSec?: number): RemoteFailure {
  if (status === 401) return { kind: "auth", message: "authentication was rejected (HTTP 401)", status };
  if (status === 403) return { kind: "auth", message: "access is forbidden for this resource (HTTP 403)", status };
  if (status === 404) return { kind: "not-found", message: "the resource was not found (HTTP 404)", status };
  if (status === 429) {
    return { kind: "rate-limited", message: "the service rate-limited the request (HTTP 429)", status, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
  }
  if (status >= 500) return { kind: "network", message: `the service returned a server error (HTTP ${status})`, status };
  return { kind: "unknown", message: `unexpected response (HTTP ${status})`, status };
}

/** Map a thrown value to a cause without inventing detail. */
export function classifyThrown(error: unknown, signal?: AbortSignal): RemoteFailure {
  if (error instanceof ResponseTooLargeError) return { kind: "malformed", message: error.message };
  if (error instanceof SyntaxError) return { kind: "malformed", message: "response body is not valid JSON" };
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return { kind: "timeout", message: "the request timed out" };
    if (error.name === "AbortError") {
      const cancelledByCaller = signal?.aborted === true && signal.reason?.name !== "TimeoutError";
      return cancelledByCaller
        ? { kind: "cancelled", message: "the request was cancelled" }
        : { kind: "timeout", message: "the request timed out" };
    }
    return { kind: "network", message: error.message };
  }
  return { kind: "unknown", message: String(error) };
}

/**
 * Perform a GET and return parsed JSON, or throw a typed `RemoteError`.
 *
 * Nothing here logs: URLs may contain tokens or query text that must not be
 * written to stderr.
 */
export class RemoteError extends Error {
  readonly failure: RemoteFailure;
  constructor(failure: RemoteFailure) {
    super(failure.message);
    this.name = "RemoteError";
    this.failure = failure;
  }
}

export interface GetJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function getJson(url: string, options: GetJsonOptions = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
      signal: stageSignal(options.signal, options.timeoutMs),
    });
  } catch (error) {
    throw new RemoteError(classifyThrown(error, options.signal));
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    // Drain a bounded slice so the connection is reusable; the body is not
    // shown to the model because it may echo internals.
    await readTextBounded(response, 8_192).catch(() => "");
    throw new RemoteError(classifyHttpStatus(response.status, retryAfter));
  }

  try {
    return await readJsonBounded(response);
  } catch (error) {
    throw new RemoteError(classifyThrown(error, options.signal));
  }
}
