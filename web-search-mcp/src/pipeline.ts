/**
 * Search orchestration: deadline, cancellation, concurrency and the provider
 * chain.
 *
 * Provider order and failure policy live here; providers only report what
 * happened. The status/notes rules are the ones the user accepted in
 * research §9: never claim the web has nothing, never invent a cause, never
 * invent a wait time.
 */
import type { ChainStep, FailureReason, SearchStatus, WebSearchOutput } from "./contract.js";
import { ENV, LIMITS, type SearchMode } from "./contract.js";
import type { ProviderOutcome } from "./ddg.js";
import { searchDuckDuckGo } from "./ddg.js";
import { classifyThrown } from "./http.js";
import { searchTavily, type TavilyCredentials } from "./tavily.js";

export interface SearchDeps {
  /** Caller cancellation (MCP request signal or a test controller). */
  signal: AbortSignal;
  credentials: TavilyCredentials;
  deadlineMs?: number;
  /** Injected for tests; defaults to the real backends. */
  duckduckgo?: typeof searchDuckDuckGo;
  tavily?: typeof searchTavily;
}

/** Whole-search budget from the environment, clamped to a sane range. */
export function readDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[ENV.deadlineMs] ?? "", 10);
  if (!Number.isFinite(raw)) return LIMITS.totalDeadlineDefaultMs;
  return Math.min(Math.max(raw, 1_000), LIMITS.totalDeadlineMaxMs);
}

/**
 * Bound the concurrent searches.
 *
 * Excess calls wait for a slot instead of queueing forever: the caller's
 * deadline still governs, so a saturated server answers with a real reason
 * rather than an open-ended hang.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.active < this.capacity) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const concurrency = new Semaphore(LIMITS.maxConcurrentRequests);

/** Compose the caller's signal with the whole-search deadline. */
function composeDeadline(signal: AbortSignal, deadlineMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
}

/** True when the deadline (not the caller) ended the request. */
function isDeadlineExpiry(deadline: AbortSignal, caller: AbortSignal): boolean {
  return deadline.aborted && !caller.aborted;
}

interface ChainOutcome {
  steps: ChainStep[];
  results: ProviderOutcome["results"];
  provider: string | null;
  droppedUnsafeUrls: number;
  resultsTruncated: boolean;
  fallback: WebSearchOutput["fallback"];
}

/**
 * Race a provider call against the budget.
 *
 * Providers receive the same signal and normally abort by themselves; this is
 * the guarantee that a provider which ignores its signal still cannot hold the
 * tool open past the deadline (research §3, §8).
 */
async function withinDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) throw deadline.reason;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.reason ?? new DOMException("aborted", "AbortError"));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (onAbort) deadline.removeEventListener("abort", onAbort);
    // An abandoned call must not surface as an unhandled rejection.
    void work.catch(() => undefined);
  }
}


/** Convert a thrown or aborted provider call into the same shape providers report. */
function failureFrom(error: unknown, deadline: AbortSignal, caller: AbortSignal): ChainStep {
  const info = classifyThrown(error, deadline);
  const reason = caller.aborted ? "cancelled" : info.reason;
  return {
    provider: "unknown",
    outcome: "error",
    error: caller.aborted ? "request was cancelled" : info.message,
    reason,
  };
}

/**
 * One actionable sentence per cause.
 *
 * Only confirmed causes appear here; the mapping is the single owner of the
 * failure guidance described in research §9.
 */
export function guidanceFor(step: ChainStep): string {
  const provider = step.provider;
  switch (step.reason) {
    case "rate-limited":
      return step.retryAfterSec !== undefined
        ? `${provider} is rate limited; a retry after ${step.retryAfterSec}s may work.`
        : `${provider} is rate limited; retrying later may work.`;
    case "auth":
      return `${provider} refused the request as unauthorised; keyless access or the key configuration may be at fault.`;
    case "blocked":
      return `${provider} blocked this request (bot protection or refusal); retrying later may work.`;
    case "timeout":
      return `${provider} did not answer within the time budget.`;
    case "malformed":
      return `${provider} answered with something that is not a result page, so its answer was not trusted.`;
    case "network":
      return `${provider} could not be reached (network or provider error).`;
    case "busy":
      return `The server is already running ${LIMITS.maxConcurrentRequests} searches; retry shortly.`;
    case "cancelled":
      return `The search was cancelled.`;
    case "unknown":
    case undefined:
      return `${provider} failed for a reason that could not be confirmed.`;
  }
}

/**
 * Decide the status from the chain.
 *
 * `empty` is claimed only when every attempted provider answered and none of
 * them errored: a provider outage is not evidence that the web has no match
 * (research §9).
 */
function decideStatus(chain: ChainOutcome, caller: AbortSignal): SearchStatus {
  if (caller.aborted) return "cancelled";
  if (chain.results.length > 0) return "ok";
  if (chain.steps.length === 0) return "unavailable";
  return chain.steps.every((step) => step.outcome !== "error") ? "empty" : "unavailable";
}

function buildNotes(
  chain: ChainOutcome,
  status: SearchStatus,
  mode: SearchMode,
  deadline: AbortSignal,
  caller: AbortSignal,
  deadlineMs: number,
): string[] {
  const notes: string[] = [];
  for (const step of chain.steps) {
    if (step.outcome !== "error") continue;
    notes.push(guidanceFor(step));
  }
  if (isDeadlineExpiry(deadline, caller) && chain.results.length === 0) {
    notes.push(`The whole search stopped at its ${Math.round(deadlineMs / 1000)}s budget.`);
  }
  if (status === "unavailable") {
    notes.push(
      "No provider produced a usable answer, so this says nothing about whether the information exists.",
    );
    if (mode === "deep") {
      notes.push(
        "Account-credit search stays disabled unless WEB_SEARCH_ALLOW_QUOTA=1 and TAVILY_API_KEY are set.",
      );
    }
  }
  return notes;
}

export function buildOutput(
  query: string,
  mode: SearchMode,
  chain: ChainOutcome,
  status: SearchStatus,
  deadline: AbortSignal,
  caller: AbortSignal,
  deadlineMs: number,
): WebSearchOutput {
  return {
    status,
    query,
    mode,
    provider: chain.provider,
    results: chain.results,
    chain: chain.steps,
    fallback: chain.fallback,
    droppedUnsafeUrls: chain.droppedUnsafeUrls,
    resultsTruncated: chain.resultsTruncated,
    notes: buildNotes(chain, status, mode, deadline, caller, deadlineMs),
  };
}

/**
 * Run the provider chain for `mode`.
 *
 * `auto` uses the free provider only. `deep` tries Tavily and falls back to
 * DuckDuckGo, recording the fallback instead of hiding it in prose
 * (research §2, §3).
 */
async function runChain(
  query: string,
  mode: SearchMode,
  maxResults: number,
  deps: SearchDeps,
  deadline: AbortSignal,
): Promise<ChainOutcome> {
  const duckduckgo = deps.duckduckgo ?? searchDuckDuckGo;
  const tavily = deps.tavily ?? searchTavily;

  const steps: ChainStep[] = [];
  const chain: ChainOutcome = {
    steps,
    results: [],
    provider: null,
    droppedUnsafeUrls: 0,
    resultsTruncated: false,
    fallback: null,
  };

  const attempt = async (
    name: string,
    call: () => Promise<{ outcome: ProviderOutcome; step: ChainStep }>,
  ): Promise<{ outcome: ProviderOutcome; step: ChainStep }> => {
    try {
      const { outcome, step } = await withinDeadline(call(), deadline);
      steps.push(step);
      return { outcome, step };
    } catch (error) {
      const step = { ...failureFrom(error, deadline, deps.signal), provider: name };
      steps.push(step);
      return {
        outcome: {
          results: [],
          droppedUnsafeUrls: 0,
          error: step.error ?? "provider failed",
          ...(step.reason !== undefined ? { reason: step.reason } : {}),
        },
        step,
      };
    }
  };

  const adopt = (outcome: ProviderOutcome, provider: string): void => {
    chain.results = outcome.results;
    chain.provider = provider;
    chain.droppedUnsafeUrls = outcome.droppedUnsafeUrls;
    chain.resultsTruncated = outcome.resultsTruncated === true;
  };

  if (mode === "auto") {
    const { outcome, step } = await attempt("duckduckgo", () => duckduckgo(query, maxResults, deadline));
    if (!outcome.error) adopt(outcome, step.provider);
    return chain;
  }

  const deep = await attempt("tavily", () => tavily(query, maxResults, deadline, deps.credentials));
  if (!deep.outcome.error) {
    adopt(deep.outcome, deep.step.provider);
    return chain;
  }
  if (deadline.aborted) return chain;

  const fallbackReason = deep.outcome.error ?? "Tavily was unavailable";
  const { outcome, step } = await attempt("duckduckgo", () => duckduckgo(query, maxResults, deadline));
  if (!outcome.error) {
    adopt(outcome, step.provider);
    chain.fallback = { from: deep.step.provider, to: step.provider, reason: fallbackReason };
  }
  return chain;
}

/** Entry point used by the tool handler: applies limits, then runs the chain. */
export async function runSearch(
  query: string,
  mode: SearchMode,
  maxResults: number,
  deps: SearchDeps,
): Promise<WebSearchOutput> {
  const deadlineMs = deps.deadlineMs ?? readDeadlineMs();
  const deadline = composeDeadline(deps.signal, deadlineMs);

  const emptyChain: ChainOutcome = {
    steps: [],
    results: [],
    provider: null,
    droppedUnsafeUrls: 0,
    resultsTruncated: false,
    fallback: null,
  };

  if (deps.signal.aborted) {
    return buildOutput(query, mode, emptyChain, "cancelled", deadline, deps.signal, deadlineMs);
  }

  let release: (() => void) | undefined;
  try {
    release = await concurrency.acquire(deadline);
  } catch {
    const busy: ChainOutcome = {
      ...emptyChain,
      steps: [{ provider: "web-search", outcome: "error", reason: "busy" satisfies FailureReason }],
    };
    return buildOutput(query, mode, busy, "unavailable", deadline, deps.signal, deadlineMs);
  }

  try {
    const chain = await runChain(query, mode, maxResults, deps, deadline);
    const status = decideStatus(chain, deps.signal);
    return buildOutput(query, mode, chain, status, deadline, deps.signal, deadlineMs);
  } finally {
    release();
  }
}
