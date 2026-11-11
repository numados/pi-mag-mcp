/**
 * Shared vocabulary of the knowledge vault server.
 *
 * The internal normalized form lives here and nothing else restates it:
 * a source is a name plus an ordered list of roots (one logical vault may be
 * spread over several directories), and every module — config, sources,
 * safety, search — speaks only in these types. Behavioural rules are owned by
 * their modules (config model in config.ts, resolution in sources.ts, the
 * runner in subprocess.ts); this file owns the words.
 */

/** One directory of a source. Roots are normalized at load time (resolve +
 *  realpath when the directory exists), so containment checks never fight a
 *  trailing slash or a symlinked vault. */
export interface Root {
  /** Unique inside the source; addressing form is `<label>:<rel>`. */
  label: string;
  /** Normalized absolute directory path. */
  path: string;
  writable: boolean;
  /** null = inherit the global `qmd.enabled` setting. */
  qmd: boolean | null;
}

/** A named knowledge source; `roots[0]` has the highest priority. */
export interface Source {
  name: string;
  roots: Root[];
}

export interface QmdSettings {
  enabled: boolean;
  updateTtlMinutes: number;
}

/** Normalized central config (see config.ts for the accepted raw forms). */
export interface KnowledgeConfig {
  sources: Source[];
  /** Preferred sources in order; `defaultVaults[0]` is the primary. */
  defaultVaults: string[];
  /** Source that owns task workspaces. */
  taskVault: string | null;
  /** Legacy single default (still accepted; `defaultVaults` wins when set). */
  defaultVault: string | null;
  /** Directory prefixes → source name, longest boundary match wins. */
  projects: Record<string, string>;
  knowledgeRoot: string | null;
  defaultTaskRoot: string | null;
  allowWrite: boolean;
  qmd: QmdSettings;
  configPath: string;
  /** Merged raw config (built-in defaults ← file), unknown keys preserved so
   *  the doctor can enumerate them and setup never loses user input. */
  raw: Record<string, unknown>;
}

/** Config loading never throws: the file state and the structural problems
 *  are data. `state`/`error` describe the file itself (missing, unparsable);
 *  `errors` lists structural problems while the valid sources are still
 *  returned, so a doctor can print everything in one pass. */
export interface ConfigLoadResult {
  state: "ok" | "missing" | "malformed";
  error?: string;
  path: string;
  config: KnowledgeConfig;
  errors: string[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; -1 when the child could not be spawned or was killed. */
  code: number;
}

/** Tool responses are plain text; the message wording is part of the
 *  contract that skills quote, so there is no structured output. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface SearchHit {
  /** Root-relative path. */
  path: string;
  line?: number;
  snippet?: string;
  score?: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  provider: "qmd" | "rg";
  skipped?: string;
}

export interface Note {
  frontmatterRaw: string | null; // verbatim block between --- fences (no fences)
  frontmatter: Record<string, unknown> | null; // null = absent/unparsable
  body: string;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface WikiLink {
  target: string;
  section?: string;
  alias?: string;
}

/** Whitelisted keys of a repo-level `.knowledge-mcp.json`; a repository can
 *  point at its slice of a source, never redefine central settings. */
export interface RepoKnowledgeConfig {
  vault?: string;
  taskRoot?: string;
  knowledgeRoot?: string;
  repo?: { name?: string; path?: string };
}

export interface RepoContext {
  repoRoot: string | null;
  config: RepoKnowledgeConfig;
  configPath: string | null;
}

/** Narrow unknown JSON input to a plain object (never an array or null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
