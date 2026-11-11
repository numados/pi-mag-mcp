/**
 * One immutable request context per call. The installation, routing table and
 * credential resolver are resolved once, then handed to the handler, so a
 * single call cannot observe two different configurations between its preview
 * and its execution.
 */
import { AdoClient } from "./ado.js";
import { PreviewStore } from "./safety.js";
import { CredentialResolver, type ResolverDeps } from "./credentials.js";
import { GithubClient } from "./github.js";
import { JiraClient } from "./jira.js";
import { LIMITS } from "./contract.js";
import { loadInstallation, type Installation } from "./installation.js";
import type { RouteTable } from "./route.js";

export interface Context {
  installation: Installation;
  sources: string[];
  notes: string[];
  resolver: CredentialResolver;
  store: PreviewStore;
  github: GithubClient;
  jira: JiraClient;
  ado: AdoClient;
  table: RouteTable;
}

export interface ContextOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  deps?: ResolverDeps;
}

export type ContextResult = { ok: true; ctx: Context } | { ok: false; error: string; sources: string[]; notes: string[] };

export function buildContext(options: ContextOptions = {}): ContextResult {
  const loaded = loadInstallation({ ...(options.env ? { env: options.env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) });
  if (!loaded.installation) {
    return {
      ok: false,
      error: loaded.error ?? "no devwork installation could be resolved",
      sources: loaded.sources,
      notes: loaded.notes,
    };
  }
  const installation = loaded.installation;
  const resolver = new CredentialResolver(installation, options.env ?? process.env, options.deps);
  const ctx: Context = {
    installation,
    sources: loaded.sources,
    notes: loaded.notes,
    resolver,
    store: previewStore(),
    github: new GithubClient(installation.github, async () => (await resolver.github()).token),
    jira: new JiraClient(() => resolver.jira(), LIMITS.httpTimeoutMs),
    ado: new AdoClient(installation.id, installation.ado, () => resolver.ado()),
    table: { defaultBackend: installation.defaultBackend, jira: { projects: installation.jira.projects } },
  };
  return { ok: true, ctx };
}

/** Process-wide preview store: a preview and its confirm may be two calls. */
let sharedStore: PreviewStore | null = null;

export function previewStore(): PreviewStore {
  if (!sharedStore) sharedStore = new PreviewStore();
  return sharedStore;
}

export function resetPreviewStore(): void {
  sharedStore = null;
}
