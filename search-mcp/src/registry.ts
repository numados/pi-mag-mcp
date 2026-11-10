/**
 * Provider table, intent chains, probe cache and the fallback runner.
 *
 * Chain semantics (unchanged from the previous server):
 *   try providers in order; skip disabled/unavailable ones (recorded with a
 *   reason); fall through on error OR empty results; stop at the first provider
 *   that yields results; if nothing yields results, report the first provider
 *   that at least answered (empty).
 *
 * The router is a class so tests can inject a fake provider table; the server
 * builds one with the real providers. There is no module-level mutable state,
 * so a config reload only touches the instance.
 */

import type { ServerConfig } from "./config.js";
import { assertRoot, assertRoots, clipLimit, clipSnippet, truncate } from "./scope.js";
import { astgrepProvider } from "./providers/astgrep.js";
import { auggieProvider, shutdownAuggie } from "./providers/auggie.js";
import { fdProvider } from "./providers/fd.js";
import { mdfindProvider } from "./providers/mdfind.js";
import { rgfilesProvider, rgProvider } from "./providers/rg.js";
import { rgaProvider } from "./providers/rga.js";
import { serenaProvider, shutdownSerena } from "./providers/serena.js";
import { createZoektProvider } from "./providers/zoekt.js";
import type { Intent, ProbeResult, ProviderDef, SearchHit, SearchQuery, SearchResponse, SkippedProvider } from "./types.js";

/** Ordered fallback chain per intent. Behaviour, not contract. */
export const CHAINS: Record<Intent, string[]> = {
  text: ["rg"],
  files: ["fd", "rgfiles", "mdfind"],
  structure: ["ast-grep", "rg"],
  docs: ["rga", "fd"],
  semantic: ["auggie", "serena", "ast-grep", "rg"],
  machine: ["mdfind"],
  crossrepo: ["zoekt", "rg"],
};

const PROBE_TTL_MS = 5 * 60 * 1_000;

export interface ProviderStatus {
  name: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
  intents: Intent[];
}

/** Raw tool arguments before normalization. */
export interface RawParams {
  query: string;
  roots?: string[];
  pathGlob?: string;
  limit?: number;
  lang?: string;
  caseSensitive?: boolean;
  maxSnippet?: number;
}

export interface RouterOptions {
  /** Override the real provider table (tests). */
  providers?: ProviderDef[];
  probeTtlMs?: number;
  onShutdown?: () => void;
}

function finish(intent: Intent, provider: string, hits: SearchHit[], skipped: SkippedProvider[]): SearchResponse {
  const note =
    intent === "semantic" && provider === "rg"
      ? "degraded: lexical only — semantic providers unavailable/disabled"
      : undefined;
  return {
    results: hits,
    provider,
    skipped,
    ...(note ? { note } : {}),
    count: hits.length,
  };
}

export class Router {
  private config: ServerConfig;
  private readonly providers: ProviderDef[];
  private readonly byName: Map<string, ProviderDef>;
  private readonly probeCache = new Map<string, ProbeResult>();
  private readonly probeTtlMs: number;
  private readonly onShutdown: (() => void) | undefined;

  constructor(config: ServerConfig, options: RouterOptions = {}) {
    this.config = config;
    this.probeTtlMs = options.probeTtlMs ?? PROBE_TTL_MS;
    this.onShutdown = options.onShutdown;
    this.providers =
      options.providers ??
      [
        rgProvider,
        rgfilesProvider,
        fdProvider,
        mdfindProvider,
        astgrepProvider,
        rgaProvider,
        auggieProvider,
        serenaProvider,
        createZoektProvider(() => this.config.providers.zoekt?.url),
      ];
    this.byName = new Map(this.providers.map((provider) => [provider.name, provider]));
  }

  isEnabled(name: string): boolean {
    return this.config.providers[name]?.enabled !== false;
  }

  /** Apply a reloaded config: the next probe and the next call see it. */
  applyConfig(next: ServerConfig): void {
    this.config = next;
    this.probeCache.clear();
  }

  private async probeOf(name: string, force = false): Promise<ProbeResult> {
    const cached = this.probeCache.get(name);
    if (!force && cached && Date.now() - cached.at < this.probeTtlMs) return cached;

    const definition = this.byName.get(name);
    let result: ProbeResult;
    if (!definition) {
      result = { ok: false, reason: "unknown provider", at: Date.now() };
    } else {
      try {
        result = await Promise.race([
          definition.probe(),
          new Promise<ProbeResult>((resolve) =>
            setTimeout(() => resolve({ ok: false, reason: "probe timeout", at: Date.now() }), 6_000),
          ),
        ]);
      } catch (error) {
        result = { ok: false, reason: (error as Error).message, at: Date.now() };
      }
    }
    this.probeCache.set(name, result);
    return result;
  }

  async status(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const provider of this.providers) {
      const enabled = this.isEnabled(provider.name);
      let available = false;
      let reason: string | undefined;
      if (!enabled) {
        reason = "disabled by config";
      } else {
        const probe = await this.probeOf(provider.name);
        available = probe.ok;
        reason = probe.reason;
      }
      out.push({
        name: provider.name,
        enabled,
        available,
        ...(reason ? { reason } : {}),
        intents: [...provider.intents],
      });
    }
    return out;
  }

  async reprobeAll(): Promise<void> {
    await Promise.all(this.providers.map((provider) => this.probeOf(provider.name, true)));
  }

  // ------------------------------------------------- query normalization

  private defaultRootsFor(intent: Intent): string[] {
    if (intent === "crossrepo") {
      if (this.config.crossrepoRoots?.length) return this.config.crossrepoRoots;
      if (this.config.roots.length) return this.config.roots;
      return [];
    }
    if (this.config.roots.length) return this.config.roots;
    // Use cwd only when it survives the scope checks (the home directory does not).
    try {
      return [assertRoot(this.config, process.cwd())];
    } catch {
      return [];
    }
  }

  private normalizeQuery(intent: Intent, params: RawParams): SearchQuery {
    const query = String(params.query ?? "").trim();
    if (!query) throw new Error("query is required");

    let roots: string[] | undefined;
    if (intent === "machine") {
      roots = params.roots?.length ? assertRoots(this.config, params.roots) : undefined;
    } else {
      roots = assertRoots(this.config, params.roots?.length ? params.roots : this.defaultRootsFor(intent));
    }

    return {
      intent,
      query,
      ...(roots ? { roots } : {}),
      ...(params.pathGlob !== undefined ? { pathGlob: params.pathGlob } : {}),
      limit: clipLimit(params.limit),
      ...(params.lang !== undefined ? { lang: params.lang } : {}),
      caseSensitive: !!params.caseSensitive,
      maxSnippet: clipSnippet(params.maxSnippet),
    };
  }

  // ------------------------------------------------------- chain runner

  async runChain(intent: Intent, params: RawParams): Promise<SearchResponse> {
    const query = this.normalizeQuery(intent, params);
    const skipped: SkippedProvider[] = [];
    let firstSuccess: { name: string; hits: SearchHit[] } | null = null;
    const maxSnippet = query.maxSnippet ?? 240;

    for (const name of CHAINS[intent]) {
      if (!this.isEnabled(name)) {
        skipped.push({ name, reason: "disabled by config" });
        continue;
      }
      const probe = await this.probeOf(name);
      if (!probe.ok) {
        skipped.push({ name, reason: probe.reason ?? "unavailable" });
        continue;
      }

      const definition = this.byName.get(name);
      if (!definition) continue;

      let hits: SearchHit[];
      try {
        hits = await Promise.race([
          definition.search(query),
          new Promise<SearchHit[]>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${definition.timeoutMs}ms`)), definition.timeoutMs + 2_000),
          ),
        ]);
      } catch (error) {
        skipped.push({ name, reason: (error as Error).message.slice(0, 200) });
        continue;
      }

      hits = hits.slice(0, query.limit ?? 50).map((hit) => ({
        ...hit,
        ...(hit.snippet ? { snippet: truncate(hit.snippet, maxSnippet) } : {}),
      }));

      if (hits.length > 0) return finish(intent, name, hits, skipped);
      skipped.push({ name, reason: "no results" });
      firstSuccess ??= { name, hits };
    }

    if (firstSuccess) return finish(intent, firstSuccess.name, firstSuccess.hits, skipped);
    throw new Error(
      `no provider answered intent "${intent}"; skipped: ${skipped.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}`,
    );
  }

  shutdown(): void {
    shutdownAuggie();
    shutdownSerena();
    this.onShutdown?.();
  }
}
