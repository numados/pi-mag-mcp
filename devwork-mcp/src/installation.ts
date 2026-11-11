/**
 * Installation profile — the single owner of "which tenant does this process
 * serve". One profile per repository installation, stored outside the
 * repository with mode 0600:
 *
 *   ~/.config/devwork-mcp/installations/<id>.json
 *
 * A repository selects a profile; it never supplies endpoints, credentials or
 * write policy. The selected profile declares the trackers, their allowlists
 * (the scope a request may touch), the credential mode and the write policy.
 *
 * Nothing here reads a secret value: `token`/`pat` entries are either literals
 * or `env:VAR` references resolved in credentials.ts.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { ENV, LIMITS } from "./contract.js";
import { WRITE_OPERATIONS, type Backend, type WriteOperation } from "./types.js";

const authMode = z.enum(["token", "ambient", "off"]);

const githubSchema = z.strictObject({
  apiBase: z.string().trim().min(1).default("https://api.github.com"),
  /** Repositories this installation may read or write (owner/repo). */
  repositories: z.array(z.string().trim().min(3)).default([]),
  /** Default "owner/repo" for bare-number refs and unscoped queries. */
  defaultRepo: z.string().trim().min(3).optional(),
  /** Literal token or "env:VAR". */
  token: z.string().min(1).optional(),
  auth: authMode.default("token"),
});

const jiraSchema = z.strictObject({
  domain: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  /** Literal API token or "env:VAR". */
  token: z.string().min(1).optional(),
  /** Project keys this installation may route to. */
  projects: z.array(z.string().trim().min(1)).default([]),
  auth: authMode.default("token"),
});

const adoSchema = z.strictObject({
  org: z.string().trim().min(1).optional(),
  /** Default project; must also appear in `projects`. */
  project: z.string().trim().min(1).optional(),
  projects: z.array(z.string().trim().min(1)).default([]),
  /** Literal PAT or "env:VAR". */
  pat: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(LIMITS.adoTimeoutMs),
  auth: authMode.default("token"),
});

const writeSchema = z.strictObject({
  policy: z.enum(["read-only", "read-write"]).default("read-only"),
  /** Operation classes allowed when policy is read-write. `merge` is never
   *  implied: it must be listed explicitly. */
  allow: z.array(z.enum(WRITE_OPERATIONS)).optional(),
  /** A confirm call must match a preview issued for exactly these arguments. */
  requirePreview: z.boolean().default(true),
});

export const installationFileSchema = z.strictObject({
  installationId: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  /** Canonical repository root this installation belongs to. A session outside
   *  it is refused instead of silently using these credentials. Either this or
   *  `repositoryRoots` is required: an unpinned profile would let any repository
   *  borrow the installation. */
  repositoryRoot: z.string().trim().min(1).optional(),
  /** Several roots (worktrees of one repository); any of them may use it. */
  repositoryRoots: z.array(z.string().trim().min(1)).optional(),
  defaultBackend: z.enum(["ado", "jira", "github"]),
  github: githubSchema.default({ apiBase: "https://api.github.com", repositories: [], auth: "token" }),
  jira: jiraSchema.default({ projects: [], auth: "token" }),
  ado: adoSchema.default({ projects: [], requestTimeoutMs: LIMITS.adoTimeoutMs, auth: "token" }),
  write: writeSchema.default({ policy: "read-only", requirePreview: true }),
  cacheTtlSeconds: z.number().int().min(0).max(86_400).default(LIMITS.cacheTtlSeconds),
  top: z.number().int().min(1).max(LIMITS.maxTop).default(LIMITS.top),
});

export type InstallationFile = z.infer<typeof installationFileSchema>;
export type GithubSettings = z.infer<typeof githubSchema>;
export type JiraSettings = z.infer<typeof jiraSchema>;
export type AdoSettings = z.infer<typeof adoSchema>;
export type WriteSettings = z.infer<typeof writeSchema>;

export interface Installation {
  /** Stable identity, used in cache keys and every status line. */
  id: string;
  /** Profile file the values came from. */
  source: string;
  /** Roots this installation is bound to; the session must be inside one. */
  repositoryRoots: string[];
  defaultBackend: Backend;
  github: GithubSettings;
  jira: JiraSettings;
  ado: AdoSettings;
  write: WriteSettings;
  cacheTtlSeconds: number;
  top: number;
}

export interface InstallationLoad {
  installation?: Installation;
  /** Why no installation could be resolved; the message names the exact fix. */
  error?: string;
  /** Files consulted, strongest first; printed by the status tool. */
  sources: string[];
  /** Non-fatal observations (ignored repository-layer keys). */
  notes: string[];
}

export const INSTALLATION_KEYS = new Set<string>(Object.keys(installationFileSchema.shape));
/** Repository layer may only select an installation and narrow routing. */
const REPO_LAYER_KEYS = new Set(["installation", "defaultBackend", "ado", "jira", "github"]);
const REPO_ROUTING_KEYS: Record<string, ReadonlySet<string>> = {
  ado: new Set(["project"]),
  jira: new Set(["projects"]),
  github: new Set(["defaultRepo"]),
};

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith(`~${sep}`) || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function installationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENV.installationsDir];
  return configured ? resolve(expandHome(configured)) : join(homedir(), ".config", "devwork-mcp", "installations");
}

/** Canonical form of a path: symlinks resolved when it exists, resolved
 *  lexically otherwise. macOS `/var` → `/private/var` is the common trap. */
export function canonicalPath(p: string): string {
  const absolute = resolve(expandHome(p));
  try {
    return realpathSync.native(absolute);
  } catch {
    // The path (or its tail) does not exist yet: resolve the closest existing
    // ancestor and keep the rest lexically.
    const suffix: string[] = [];
    let cursor = absolute;
    for (let i = 0; i < 32; i++) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ""));
      cursor = parent;
      try {
        const resolved = realpathSync.native(cursor);
        return suffix.length > 0 ? join(resolved, ...suffix) : resolved;
      } catch {
        continue;
      }
    }
    return absolute;
  }
}

export function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

interface RepoLayer {
  path: string;
  installation?: string;
  defaultBackend?: Backend;
  adoProject?: string;
  jiraProjects?: string[];
  githubDefaultRepo?: string;
  ignoredCredentialKeys: string[];
}

/** Walk from `startDir` up to the repository boundary looking for
 *  `.devwork-mcp.json`. Credential-shaped keys are ignored, never merged. */
export function findRepoLayer(startDir: string): RepoLayer | null {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (let i = 0; i < 16 && dir !== root; i++) {
    const candidate = join(dir, ENV.repoFile);
    if (existsSync(candidate)) return readRepoLayer(candidate);
    if (existsSync(join(dir, ".git"))) return null;
    dir = dirname(dir);
  }
  return null;
}

function readRepoLayer(path: string): RepoLayer {
  const layer: RepoLayer = { path, ignoredCredentialKeys: [] };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return layer;
    raw = parsed as Record<string, unknown>;
  } catch {
    return layer;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!REPO_LAYER_KEYS.has(key)) {
      layer.ignoredCredentialKeys.push(key);
      continue;
    }
    if (key === "installation" && typeof value === "string") layer.installation = value;
    if (key === "defaultBackend" && (value === "ado" || value === "jira" || value === "github")) {
      layer.defaultBackend = value;
    }
    if (key === "ado" && value && typeof value === "object") {
      const ado = value as Record<string, unknown>;
      for (const k of Object.keys(ado)) {
        if (!REPO_ROUTING_KEYS["ado"]?.has(k)) {
          layer.ignoredCredentialKeys.push(`ado.${k}`);
          continue;
        }
        if (k === "project" && typeof ado[k] === "string") layer.adoProject = ado[k] as string;
      }
    }
    if (key === "jira" && value && typeof value === "object") {
      const jira = value as Record<string, unknown>;
      for (const k of Object.keys(jira)) {
        if (!REPO_ROUTING_KEYS["jira"]?.has(k)) {
          layer.ignoredCredentialKeys.push(`jira.${k}`);
          continue;
        }
        if (k === "projects" && Array.isArray(jira[k])) {
          layer.jiraProjects = (jira[k] as unknown[]).map(String).filter((s) => s.length > 0);
        }
      }
    }
    if (key === "github" && value && typeof value === "object") {
      const github = value as Record<string, unknown>;
      for (const k of Object.keys(github)) {
        if (!REPO_ROUTING_KEYS["github"]?.has(k)) {
          layer.ignoredCredentialKeys.push(`github.${k}`);
          continue;
        }
        if (k === "defaultRepo" && typeof github[k] === "string") layer.githubDefaultRepo = github[k] as string;
      }
    }
  }
  return layer;
}

function profilePath(id: string, env: NodeJS.ProcessEnv): string {
  return join(installationsDir(env), `${id}.json`);
}

function readProfile(path: string, expectedId: string): { installation?: Installation; error?: string } {
  if (!existsSync(path)) {
    return { error: `installation profile not found: ${path} — create it (see installation.example.json) or pass ${ENV.installationFile}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { error: `cannot read ${path}: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
  const validated = installationFileSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { error: `${path} is not a valid installation profile — ${issues}` };
  }
  const file = validated.data;
  const id = file.installationId ?? expectedId;
  if (file.installationId && expectedId && file.installationId !== expectedId) {
    return { error: `${path} declares installationId "${file.installationId}" but was selected as "${expectedId}"` };
  }

  const problems: string[] = [];
  const roots = [...(file.repositoryRoots ?? []), ...(file.repositoryRoot ? [file.repositoryRoot] : [])];
  if (roots.length === 0) {
    problems.push(
      "repositoryRoot (or repositoryRoots) is required — an unpinned profile could be borrowed by any repository; run ./install.sh devwork --local --repo <path> --installation <id>",
    );
  }
  const checkBackend = (name: string, auth: string, hasEndpoint: boolean, allowlist: string[]): void => {
    if (auth === "off") return;
    if (!hasEndpoint) problems.push(`${name}.auth is "${auth}" but no endpoint is configured — set the endpoint or auth:"off"`);
    if (allowlist.length === 0) {
      problems.push(`${name} has an empty allowlist — list the ${name === "jira" ? "project keys" : "projects/repositories"} this installation may touch, or set auth:"off"`);
    }
  };
  checkBackend("github", file.github.auth, Boolean(file.github.apiBase), file.github.repositories);
  checkBackend("jira", file.jira.auth, Boolean(file.jira.domain), file.jira.projects);
  checkBackend("ado", file.ado.auth, Boolean(file.ado.org), file.ado.projects);
  if (file.github.defaultRepo && !file.github.repositories.includes(file.github.defaultRepo)) {
    problems.push(`github.defaultRepo "${file.github.defaultRepo}" is not in github.repositories`);
  }
  if (file.ado.project && !file.ado.projects.includes(file.ado.project)) {
    problems.push(`ado.project "${file.ado.project}" is not in ado.projects`);
  }
  if (file.jira.domain) {
    const host = safeHost(file.jira.domain);
    if (host === null) problems.push(`jira.domain "${file.jira.domain}" is not a usable URL`);
    else if (!isHttpsOrLoopback(file.jira.domain)) problems.push("jira.domain must use https (http is accepted only for localhost)");
  }
  if (file.github.apiBase && !isHttpsOrLoopback(file.github.apiBase)) {
    problems.push("github.apiBase must use https (http is accepted only for localhost)");
  }
  if (file.ado.org && !isHttpsOrLoopback(file.ado.org)) {
    problems.push("ado.org must use https (http is accepted only for localhost)");
  }
  if (problems.length > 0) return { error: `${path} is not usable — ${problems.join("; ")}` };

  const installation: Installation = {
    id,
    source: path,
    repositoryRoots: roots.map((root) => canonicalPath(root)),
    defaultBackend: file.defaultBackend,
    github: file.github,
    jira: file.jira,
    ado: file.ado,
    write: file.write,
    cacheTtlSeconds: file.cacheTtlSeconds,
    top: file.top,
  };
  return { installation };
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isHttpsOrLoopback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Resolve the installation, strongest signal first:
 *   1. DEVWORK_INSTALLATION_FILE   — explicit profile path
 *   2. DEVWORK_INSTALLATION        — profile id in the installations directory
 *   3. <repo>/.devwork-mcp.json    — {"installation": "<id>"} from the repository
 * A repository may narrow routing (default backend, project/repo) but never
 * supplies endpoints, credentials or write policy.
 */
export function loadInstallation(options: LoadOptions = {}): InstallationLoad {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const sources: string[] = [];
  const notes: string[] = [];

  const explicitFile = env[ENV.installationFile];
  const explicitId = env[ENV.installation];
  const repoLayer = findRepoLayer(cwd);
  if (repoLayer) {
    sources.push(repoLayer.path);
    if (repoLayer.ignoredCredentialKeys.length > 0) {
      notes.push(
        `${repoLayer.path}: ignored ${repoLayer.ignoredCredentialKeys.join(", ")} — a repository may select an installation and narrow routing, never credentials, endpoints or write policy`,
      );
    }
  }

  let profile: string | undefined;
  let expectedId = "";
  if (explicitFile) {
    profile = resolve(expandHome(explicitFile));
    expectedId = "";
    sources.unshift(`${ENV.installationFile}=${profile}`);
  } else if (explicitId) {
    expectedId = explicitId;
    profile = profilePath(explicitId, env);
    sources.unshift(`${ENV.installation}=${explicitId}`);
  } else if (repoLayer?.installation) {
    expectedId = repoLayer.installation;
    profile = profilePath(repoLayer.installation, env);
    sources.unshift(`${repoLayer.path} → installation "${repoLayer.installation}"`);
  }

  if (!profile) {
    return {
      error:
        `no devwork installation selected — this server serves one installation per repository. ` +
        `Run ./install.sh devwork --local --repo <path> --installation <id>, or set ${ENV.installation} / ${ENV.installationFile}. ` +
        `Without an installation every tool refuses instead of borrowing machine credentials.`,
      sources,
      notes,
    };
  }

  const loaded = readProfile(profile, expectedId);
  if (!loaded.installation) {
    return {
      ...(loaded.error !== undefined ? { error: loaded.error } : {}),
      sources: [profile, ...sources],
      notes,
    };
  }
  sources.unshift(profile);

  const installation = applyRepoRouting(loaded.installation, repoLayer, notes);

  const sessionRoot = canonicalPath(cwd);
  if (!installation.repositoryRoots.some((root) => isInside(sessionRoot, root))) {
    return {
      error:
        `installation "${installation.id}" belongs to ${installation.repositoryRoots.join(", ")}, but this session runs in ${sessionRoot} — ` +
        `refusing to use another repository's credentials`,
      sources,
      notes,
    };
  }
  if (!existsSync(installation.source)) {
    return { error: `installation profile disappeared: ${installation.source}`, sources, notes };
  }
  const mode = fileMode(installation.source);
  // POSIX bits are meaningless on Windows, where stat reports a synthetic mode.
  if (process.platform !== "win32" && mode !== null && (mode & 0o077) !== 0) {
    return {
      error:
        `${installation.source} is readable by group/others (mode ${mode.toString(8)}) — refusing, the profile is the credential boundary. ` +
        `Run: chmod 600 ${installation.source}`,
      sources,
      notes,
    };
  }

  return { installation, sources, notes };
}

/** Repository layer may narrow routing; anything that would widen scope or
 *  swap identity is dropped. */
function applyRepoRouting(base: Installation, layer: RepoLayer | null, notes: string[]): Installation {
  if (!layer) return base;
  const next: Installation = {
    ...base,
    github: { ...base.github },
    jira: { ...base.jira, projects: [...base.jira.projects] },
    ado: { ...base.ado, projects: [...base.ado.projects] },
  };
  if (layer.defaultBackend) next.defaultBackend = layer.defaultBackend;

  if (layer.githubDefaultRepo) {
    if (base.github.repositories.includes(layer.githubDefaultRepo)) next.github.defaultRepo = layer.githubDefaultRepo;
    else notes.push(`${layer.path}: github.defaultRepo "${layer.githubDefaultRepo}" ignored — outside the installation allowlist`);
  }
  if (layer.adoProject) {
    if (base.ado.projects.includes(layer.adoProject)) next.ado.project = layer.adoProject;
    else notes.push(`${layer.path}: ado.project "${layer.adoProject}" ignored — outside the installation allowlist`);
  }
  if (layer.jiraProjects) {
    const narrowed = layer.jiraProjects.filter((p) => base.jira.projects.includes(p));
    const dropped = layer.jiraProjects.filter((p) => !base.jira.projects.includes(p));
    if (dropped.length > 0) {
      notes.push(`${layer.path}: jira.projects ${dropped.join(", ")} ignored — outside the installation allowlist`);
    }
    if (narrowed.length > 0) next.jira.projects = narrowed;
  }
  return next;
}

function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** Write operations this installation allows; the empty set means read-only. */
export function allowedWriteOperations(write: WriteSettings): Set<WriteOperation> {
  if (write.policy === "read-only") return new Set();
  const declared = write.allow ?? ["create", "update", "comment", "pr", "vote"];
  // `merge` is never implied by read-write; it must be listed explicitly.
  return new Set(declared);
}
