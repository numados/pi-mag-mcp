/**
 * Bounded HTTP: every provider response body is size-limited so a hostile or
 * runaway response cannot exhaust memory (research §3, §8).
 */
import { LIMITS, type FailureReason } from "./contract.js";

export class ResponseTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`response body exceeded ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Read a response body as text, aborting once `maxBytes` is exceeded.
 *
 * `Content-Length` is checked first as a cheap rejection, but the stream is
 * still counted because the header can be missing or wrong.
 */
export async function readTextBounded(response: Response, maxBytes = LIMITS.maxResponseBytes): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new ResponseTooLargeError(maxBytes);
    }
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
    // Releasing the lock leaves the stream cancellable on the error path.
    reader.releaseLock();
  }
}

/** Read and parse JSON with the same byte budget. */
export async function readJsonBounded(response: Response, maxBytes = LIMITS.maxResponseBytes): Promise<unknown> {
  const text = await readTextBounded(response, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntaxError("response body is not valid JSON");
  }
}

/**
 * Parse `Retry-After` (seconds or HTTP-date) into whole seconds, so a caller
 * gets a real wait hint instead of an invented one (research §9).
 */
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

/** A classified failure: the message a caller sees plus the cause a note uses. */
export interface FailureInfo {
  message: string;
  reason: FailureReason;
  retryAfterSec?: number;
}

/** Map an HTTP status to a cause. One owner for the whole status-to-reason rule. */
export function classifyHttpStatus(status: number, hint = ""): FailureInfo {
  const suffix = hint ? `: ${hint}` : "";
  if (status === 429) return { message: `rate limited (HTTP 429${suffix})`, reason: "rate-limited" };
  if (status === 401 || status === 403) {
    return { message: `request was not authorised (HTTP ${status}${suffix})`, reason: "auth" };
  }
  if (status === 202 || status === 503) {
    return { message: `service refused the request (HTTP ${status}${suffix})`, reason: "blocked" };
  }
  if (status >= 500) return { message: `provider error (HTTP ${status}${suffix})`, reason: "network" };
  return { message: `unexpected response (HTTP ${status}${suffix})`, reason: "unknown" };
}

/** Map a thrown value to a cause without inventing detail. */
export function classifyThrown(error: unknown, signal?: AbortSignal): FailureInfo {
  if (error instanceof ResponseTooLargeError) {
    return { message: error.message, reason: "malformed" };
  }
  if (error instanceof SyntaxError) {
    return { message: "response body is not valid JSON", reason: "malformed" };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return { message: "timed out", reason: "timeout" };
    if (error.name === "AbortError") {
      const cancelledByCaller = signal?.aborted === true && signal.reason?.name !== "TimeoutError";
      return {
        message: cancelledByCaller ? "request was cancelled" : "timed out",
        reason: cancelledByCaller ? "cancelled" : "timeout",
      };
    }
    return { message: error.message, reason: "network" };
  }
  return { message: String(error), reason: "unknown" };
}
