/**
 * Shared vocabulary of the search router.
 *
 * `INTENTS` is the single owner of the intent names: the tool contract turns it
 * into an enum, the registry keys its chains by it. Nothing else restates them.
 */

export const INTENTS = ["text", "files", "structure", "docs", "semantic", "machine", "crossrepo"] as const;

export type Intent = (typeof INTENTS)[number];

export interface SearchQuery {
  intent: Intent;
  /** Text / pattern / name to search for. */
  query: string;
  /** Explicit roots, already validated by scope.ts. Undefined = intent default. */
  roots?: string[];
  pathGlob?: string;
  limit?: number;
  /** Language for structural search (ast-grep -l). */
  lang?: string;
  caseSensitive?: boolean;
  maxSnippet?: number;
}

export interface SearchHit {
  path: string;
  line?: number;
  snippet?: string;
  kind?: string;
}

export interface SkippedProvider {
  name: string;
  reason: string;
}

export interface SearchResponse {
  results: SearchHit[];
  provider: string;
  skipped: SkippedProvider[];
  note?: string;
  count: number;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  at: number;
}

export interface ProviderDef {
  readonly name: string;
  readonly intents: readonly Intent[];
  /** Quick availability check (binary / service). Never throws: failure is a result. */
  probe(): Promise<ProbeResult>;
  /** Run one search; throwing makes the chain fall through to the next provider. */
  search(query: SearchQuery): Promise<SearchHit[]>;
  /** Rough per-call timeout hint in ms. */
  readonly timeoutMs: number;
}

/** A root the server refuses to search. Message text is part of the contract. */
export class ScopeError extends Error {}

/** Build a probe result without ever setting `reason: undefined`. */
export function probeResult(ok: boolean, reason?: string): ProbeResult {
  return ok ? { ok: true, at: Date.now() } : { ok: false, reason: reason ?? "unavailable", at: Date.now() };
}
