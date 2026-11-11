/**
 * Credential resolution. Fail-closed by design: an installation resolves
 * secrets from its own profile (literal or `env:VAR`) and never borrows the
 * machine's ambient login unless the profile explicitly asks for it with
 * `auth: "ambient"`.
 *
 * Why: `gh auth token` and `az account get-access-token` return whatever
 * account happens to be active on the machine. Two repositories of two
 * companies would then share one identity, and the answer could change between
 * two calls. Ambient mode stays available as an explicit, visible choice and
 * `devwork_status` reports the authenticated principal for it.
 *
 * Token caches live on the resolver instance, so they are per installation and
 * per process; nothing is shared across installations.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdoSettings, GithubSettings, Installation, JiraSettings } from "./installation.js";

const execFileAsync = promisify(execFile);

export type CredentialMode = "token" | "ambient" | "none";

export interface CredentialState {
  mode: CredentialMode;
  /** Where the value came from, e.g. "profile token → env:ACME_TOKEN". Never a value. */
  source: string;
  notes: string[];
}

export interface GithubCredential extends CredentialState {
  token?: string;
}

export interface JiraCredential extends CredentialState {
  email?: string;
  token?: string;
  domain?: string;
}

export interface AdoCredential extends CredentialState {
  /** Ready Authorization header value; never logged. */
  header?: string;
}

export interface ResolverDeps {
  /** Runs a command and returns stdout; injected by tests. */
  run: (command: string, args: string[], timeoutMs: number) => Promise<string>;
}

const defaultDeps: ResolverDeps = {
  run: async (command, args, timeoutMs) => {
    const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs });
    return stdout;
  },
};

/** `env:VAR` references are resolved here and nowhere else. */
export function resolveReference(reference: string | undefined, env: NodeJS.ProcessEnv): { value?: string; missing?: string } {
  if (!reference) return {};
  if (!reference.startsWith("env:")) return { value: reference };
  const name = reference.slice(4);
  const value = env[name];
  return value ? { value } : { missing: name };
}

export class CredentialResolver {
  private ghCache: { token: string; expiresAt: number } | null = null;
  private azCache: { token: string; expiresAt: number } | null = null;
  private ghState: GithubCredential | null = null;
  private adoState: AdoCredential | null = null;

  constructor(
    private readonly installation: Installation,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly deps: ResolverDeps = defaultDeps,
  ) {}

  /** GitHub token: profile token → (ambient only) env tokens → `gh auth token`. */
  async github(): Promise<GithubCredential> {
    if (this.ghState) return this.ghState;
    const settings: GithubSettings = this.installation.github;
    const notes: string[] = [];
    if (settings.auth === "off") {
      this.ghState = { mode: "none", source: "backend disabled (auth:off)", notes };
      return this.ghState;
    }
    const profile = resolveReference(settings.token, this.env);
    if (profile.value) {
      this.ghState = { mode: "token", token: profile.value, source: `installation token${settings.token?.startsWith("env:") ? ` (${settings.token})` : ""}`, notes };
      return this.ghState;
    }
    if (profile.missing) notes.push(`installation token reference ${settings.token} is unset`);

    if (settings.auth === "ambient") {
      const fromEnv = this.env.GH_TOKEN ?? this.env.GITHUB_TOKEN;
      if (fromEnv) {
        this.ghState = { mode: "ambient", token: fromEnv, source: this.env.GH_TOKEN ? "ambient GH_TOKEN" : "ambient GITHUB_TOKEN", notes };
        return this.ghState;
      }
      const fromCli = await this.ghCliToken();
      if (fromCli) {
        this.ghState = { mode: "ambient", token: fromCli, source: "ambient `gh auth token`", notes };
        return this.ghState;
      }
      notes.push("ambient GitHub login unavailable: no GH_TOKEN/GITHUB_TOKEN and `gh auth token` failed");
      this.ghState = { mode: "none", source: "ambient (unavailable)", notes };
      return this.ghState;
    }

    notes.push(`GitHub credential missing: set github.token to "env:<VARIABLE>" in ${this.installation.source}, or set github.auth:"ambient" to borrow the machine login`);
    this.ghState = { mode: "none", source: "installation token (missing)", notes };
    return this.ghState;
  }

  private async ghCliToken(): Promise<string | null> {
    if (this.ghCache && Date.now() < this.ghCache.expiresAt) return this.ghCache.token;
    try {
      const stdout = await this.deps.run("gh", ["auth", "token"], 10_000);
      const token = stdout.trim();
      if (!token) return null;
      this.ghCache = { token, expiresAt: Date.now() + 50 * 60_000 };
      return token;
    } catch {
      return null;
    }
  }

  /** Jira: profile domain + email + API token; there is no ambient Jira login. */
  jira(): JiraCredential {
    const settings: JiraSettings = this.installation.jira;
    const notes: string[] = [];
    if (settings.auth === "off") return { mode: "none", source: "backend disabled (auth:off)", notes };
    const token = resolveReference(settings.token, this.env);
    if (token.missing) notes.push(`jira.token reference ${settings.token} is unset`);
    const email = settings.email ? resolveReference(settings.email, this.env).value : undefined;
    const complete = Boolean(settings.domain && email && token.value);
    if (!complete) {
      notes.push(`Jira credentials incomplete: domain/email/token must all be set in ${this.installation.source}`);
      return { mode: "none", source: "installation credentials (incomplete)", notes, ...(settings.domain ? { domain: settings.domain } : {}) };
    }
    return {
      mode: "token",
      source: `installation credentials${settings.token?.startsWith("env:") ? ` (${settings.token})` : ""}`,
      notes,
      email: email as string,
      token: token.value as string,
      domain: settings.domain as string,
    };
  }

  /** ADO: static PAT, or `az` CLI only when the profile opts into ambient. */
  async ado(): Promise<AdoCredential> {
    if (this.adoState) return this.adoState;
    const settings: AdoSettings = this.installation.ado;
    const notes: string[] = [];
    if (settings.auth === "off") {
      this.adoState = { mode: "none", source: "backend disabled (auth:off)", notes };
      return this.adoState;
    }
    const pat = resolveReference(settings.pat, this.env);
    if (pat.value) {
      const encoded = Buffer.from(`:${pat.value}`).toString("base64");
      this.adoState = { mode: "token", header: `Basic ${encoded}`, source: `installation PAT${settings.pat?.startsWith("env:") ? ` (${settings.pat})` : ""}`, notes };
      return this.adoState;
    }
    if (pat.missing) notes.push(`ado.pat reference ${settings.pat} is unset`);

    if (settings.auth === "ambient") {
      const token = await this.azToken();
      if (token) {
        this.adoState = { mode: "ambient", header: `Bearer ${token}`, source: "ambient `az` CLI login", notes };
        return this.adoState;
      }
      notes.push("ambient ADO login unavailable: `az account get-access-token` failed (install azure-cli or use a PAT)");
    } else {
      notes.push(`ADO credential missing: set ado.pat to "env:<VARIABLE>" in ${this.installation.source}, or set ado.auth:"ambient" to borrow the machine login`);
    }
    this.adoState = { mode: "none", source: "installation PAT (missing)", notes };
    return this.adoState;
  }

  private async azToken(): Promise<string | null> {
    if (this.azCache && Date.now() < this.azCache.expiresAt) return this.azCache.token;
    try {
      const stdout = await this.deps.run(
        "az",
        ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "--output", "tsv"],
        15_000,
      );
      const token = stdout.trim();
      if (!token) return null;
      this.azCache = { token, expiresAt: Date.now() + 50 * 60_000 };
      return token;
    } catch {
      return null;
    }
  }
}
