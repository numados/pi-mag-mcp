/**
 * Server config with layered resolution (highest priority first):
 *
 *   SEARCH_MCP_CONFIG env file  >  repo `.search-mcp.json`  >  ~/.config/search-mcp/providers.json  >  defaults
 *
 * The repo layer lets each repository point at its own roots (different jobs =
 * different trees). The file is discovered by walking up from the process cwd,
 * looking up to and including the git root. Editing any layer reloads the
 * provider table live; the tool list itself never changes (see D-S1 in the
 * task plan), so a config edit cannot invalidate the host's prompt cache.
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ProviderConfig {
  enabled: boolean;
  /** Optional overrides. */
  command?: string;
  url?: string;
  args?: string[];
}

export interface ServerConfig {
  /** Allowlist of permitted root prefixes; empty = any non-blocklisted root. */
  roots: string[];
  /** Cross-repo search roots when not passed explicitly (zoekt / rg). */
  crossrepoRoots?: string[];
  providers: Record<string, ProviderConfig>;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** Files actually applied, lowest priority first (for status output). */
  sources: string[];
}

export const DEFAULT_CONFIG: ServerConfig = {
  roots: [],
  providers: {
    rg: { enabled: true },
    fd: { enabled: true },
    mdfind: { enabled: true },
    "ast-grep": { enabled: true },
    rga: { enabled: true },
    auggie: { enabled: true },
    serena: { enabled: true },
    zoekt: { enabled: false, url: "http://localhost:6070" },
  },
};

function applyRaw(config: ServerConfig, raw: unknown): ServerConfig {
  if (!raw || typeof raw !== "object") return config;
  const next: ServerConfig = { ...config, providers: { ...config.providers } };
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.roots)) next.roots = record.roots.map(String);
  if (Array.isArray(record.crossrepoRoots)) next.crossrepoRoots = record.crossrepoRoots.map(String);
  if (record.providers && typeof record.providers === "object") {
    for (const [name, value] of Object.entries(record.providers as Record<string, unknown>)) {
      const base = next.providers[name] ?? { enabled: true };
      const entry = (value ?? {}) as Record<string, unknown>;
      next.providers[name] = {
        ...base,
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : base.enabled,
        ...(typeof entry.command === "string" ? { command: entry.command } : {}),
        ...(typeof entry.url === "string" ? { url: entry.url } : {}),
        ...(Array.isArray(entry.args) ? { args: entry.args.map(String) } : {}),
      };
    }
  }
  return next;
}

export function userConfigPath(): string {
  return process.env.SEARCH_MCP_CONFIG ?? join(homedir(), ".config", "search-mcp", "providers.json");
}

/** Nearest `.search-mcp.json` from `startDir` upward, up to and including the git root. */
export function discoverRepoConfig(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".search-mcp.json");
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const atGitRoot = existsSync(join(dir, ".git"));
    if (atGitRoot) return null; // repo boundary reached, nothing found inside it
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[search] config parse failed (${path}): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function loadConfig(): LoadedConfig {
  // Application order = priority: defaults -> user -> repo (later wins).
  const sources: string[] = [];
  let config = applyRaw(DEFAULT_CONFIG, null);
  const envPath = process.env.SEARCH_MCP_CONFIG;

  if (envPath) {
    // An explicit path is the sole source: deterministic setups and tests.
    if (existsSync(envPath)) {
      const raw = readJson(envPath);
      if (raw) {
        config = applyRaw(config, raw);
        sources.push(envPath);
      }
    }
    return { config, sources };
  }

  const userPath = join(homedir(), ".config", "search-mcp", "providers.json");
  if (existsSync(userPath)) {
    const raw = readJson(userPath);
    if (raw) {
      config = applyRaw(config, raw);
      sources.push(userPath);
    }
  }

  const repoPath = discoverRepoConfig();
  if (repoPath) {
    const raw = readJson(repoPath);
    if (raw) {
      config = applyRaw(config, raw);
      sources.push(repoPath);
    }
  }

  return { config, sources };
}

/**
 * Watch every config layer (and their directories, so a file created after
 * startup is picked up). `onChange` is debounced because editors write twice.
 */
export function watchConfig(onChange: () => void): FSWatcher | null {
  const paths = new Set<string>();
  const envPath = process.env.SEARCH_MCP_CONFIG;
  if (envPath) {
    paths.add(envPath);
  } else {
    paths.add(userConfigPath());
    const repoPath = discoverRepoConfig();
    if (repoPath) paths.add(repoPath);
  }

  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };

  for (const path of paths) {
    try {
      if (existsSync(path)) watcher = watcher ?? watch(path, debounced);
    } catch {
      // an unwatchable layer must not stop the others
    }
    try {
      const dir = dirname(path);
      if (existsSync(dir)) {
        const directoryWatcher = watch(dir, (_event, filename) => {
          if (!filename || filename === basename(path)) debounced();
        });
        watcher = watcher ?? directoryWatcher;
      }
    } catch {
      // same
    }
  }
  return watcher;
}
