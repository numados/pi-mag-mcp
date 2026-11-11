/** Staged text-file size policy for repo-mcp's commit preflight.
 *
 * This module deliberately reads Git's index objects, never the worktree.
 * Git diff is restricted to metadata/plumbing output: external diff drivers and
 * textconv are disabled, paths are NUL-delimited, and output is bounded.
 *
 * The default ignore list, including test classification, lives here only.
 * An independently installed shell hook may run its own copy of this check and
 * may lag behind these exclusions; keeping it in sync is out of scope here.
 */

import { git } from "./exec.js";
import { ValidationError } from "./validate.js";

export const DEFAULT_MAX_TOKENS = 5000;
export const DEFAULT_BYTES_PER_TOKEN = 4;
export const DEFAULT_MODE = "new" as const;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;

type Mode = "new" | "growth" | "all";

interface Policy {
  maxTokens: number;
  bytesPerToken: number;
  mode: Mode;
  ignores: RegExp[];
}

interface RawEntry {
  status: string;
  path: string;
  oldPath?: string;
  oldOid: string;
  newOid: string;
}

export interface SizeViolation {
  path: string;
  stagedBytes: number;
  oldBytes: number | null;
  reason: string;
}

export interface SizeCheck {
  maxBytes: number;
  bytesPerToken: number;
  checked: number;
  skipped: number;
  violations: SizeViolation[];
}

const DEFAULT_IGNORE_GLOBS = [
  "*.lock", "*.lock.json",
  "package-lock.json", "*/package-lock.json",
  "yarn.lock", "*/yarn.lock",
  "pnpm-lock.yaml", "*/pnpm-lock.yaml",
  "Cargo.lock", "*/Cargo.lock",
  "Gemfile.lock", "*/Gemfile.lock",
  "composer.lock", "*/composer.lock",
  "poetry.lock", "*/poetry.lock",
  "go.sum", "*/go.sum",
  "Podfile.lock", "*/Podfile.lock",
  "Package.resolved", "*/Package.resolved",
  "generated/*", "*/generated/*",
  "codegen/*", "*/codegen/*",
  "code-generated/*", "*/code-generated/*",
  "gen/*", "*/gen/*",
  "*.generated", "*.generated.*",
  "*.g.cs", "*.designer.cs", "*.pb.go", "*.pb.ts", "*.gen.go",
  // Test sources and fixtures are not production source-code inputs. The
  // directory components are explicit (test/tests/__tests__/spec/specs at any
  // level) and the name patterns require a ".test."/".spec." separator or an
  // idiomatic suffix/prefix; a bare *test* would wrongly exempt production
  // files such as src/contest.ts, src/testimonial.ts or src/latest.ts.
  "test/*", "*/test/*",
  "tests/*", "*/tests/*",
  "__tests__/*", "*/__tests__/*",
  "spec/*", "*/spec/*",
  "specs/*", "*/specs/*",
  "*.test.*", "*.spec.*",
  // Language-idiomatic test names (bounded, not any *test*).
  "*_test.go",
  "test_*.py", "*/test_*.py", "*_test.py",
  "*Test.cs", "*Tests.cs",
  // Posts, documentation, and text/data files are not source-code inputs.
  "posts/*", "post/*", "*/posts/*",
  "docs/*", "*/docs/*", "documentation/*", "*/documentation/*",
  "README*", "*/README*", "CHANGELOG*", "*/CHANGELOG*", "LICENSE*", "*/LICENSE*",
  "*.md", "*.mdx", "*.txt", "*.text", "*.rst", "*.adoc", "*.asciidoc", "*.org", "*.tex", "*.rtf",
  "*.html", "*.htm", "*.xml", "*.json", "*.yaml", "*.yml", "*.toml", "*.ini", "*.cfg", "*.conf", "*.csv", "*.tsv",
];

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        source += `[${cls.replaceAll("\\", "\\\\").replaceAll("]", "\\]")}]`;
        i = end;
      }
    } else if ("\\.^$+(){}|".includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`${source}$`);
}

function positive(value: string, key: string, path: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ValidationError(`${key} must be a positive integer in ${path}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${key} is too large in ${path}`);
  return n;
}

function trim(value: string): string {
  return value.trim();
}

async function loadPolicy(root: string, signal?: AbortSignal): Promise<Policy> {
  const configPath = ".agent-file-size.conf";
  let maxTokens = DEFAULT_MAX_TOKENS;
  let bytesPerToken = DEFAULT_BYTES_PER_TOKEN;
  let mode: Mode = DEFAULT_MODE;
  const patterns = [...DEFAULT_IGNORE_GLOBS];

  const index = await gitOutput(root, ["--literal-pathspecs", "ls-files", "--stage", "--", configPath], signal);
  if (index.trim()) {
    const firstLine = index.split(/\r?\n/)[0] ?? "";
    const tab = firstLine.indexOf("\t");
    const meta = tab < 0 ? firstLine : firstLine.slice(0, tab);
    const [modeBits, oid, stage] = meta.split(" ");
    if (!oid || stage !== "0" || (modeBits !== "100644" && modeBits !== "100755")) {
      throw new ValidationError(`.agent-file-size.conf must be a regular staged file`);
    }
    const source = await gitOutput(root, ["cat-file", "blob", oid], signal);
    for (const raw of source.split(/\r?\n/)) {
      const line = trim(raw);
      if (!line || line.startsWith("#")) continue;
      const match = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) throw new ValidationError(`invalid config line in ${configPath}: ${line}`);
      const key = match[1] ?? "";
      const rawValue = match[2] ?? "";
      const value = trim(rawValue);
      switch (key) {
        case "max_tokens":
          maxTokens = positive(value, key, configPath);
          break;
        case "bytes_per_token":
          bytesPerToken = positive(value, key, configPath);
          break;
        case "mode":
          if (value !== "new" && value !== "growth" && value !== "all") {
            throw new ValidationError(`mode must be new, growth, or all in ${configPath}`);
          }
          mode = value;
          break;
        case "ignore":
          if (!value) throw new ValidationError(`ignore patterns cannot be empty in ${configPath}`);
          patterns.push(value);
          break;
        default:
          throw new ValidationError(`unknown config key '${key}' in ${configPath}`);
      }
    }
  }

  return { maxTokens, bytesPerToken, mode, ignores: patterns.map(globRegex) };
}

async function gitOutput(root: string, args: string[], signal?: AbortSignal, stdin?: string): Promise<string> {
  const r = await git({ cwd: root, args, signal, stdin, maxOutput: MAX_GIT_OUTPUT });
  if (r.aborted) throw new ValidationError("cancelled while checking staged file sizes");
  if (r.code !== 0) throw new ValidationError(`cannot check staged file sizes: git ${args[0]} failed: ${(r.stderr || "(no output)").trim()}`);
  if (r.truncated) throw new ValidationError("cannot check staged file sizes: Git metadata output exceeded the safety bound");
  return r.stdout;
}

function isOid(value: string): boolean {
  return /^[0-9a-f]+$/.test(value) && value.length >= 40 && !/^0+$/.test(value);
}

function isRawOid(value: string): boolean {
  return /^[0-9a-f]+$/.test(value) && value.length >= 40;
}

function parseRaw(output: string): RawEntry[] {
  const fields = output.split("\0");
  const entries: RawEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const meta = fields[i];
    if (meta === undefined || meta === "") break;
    i++;
    const parts = meta.split(" ");
    if (parts.length < 5 || !meta.startsWith(":") || !isRawOid(parts[2] ?? "") || !isRawOid(parts[3] ?? "")) {
      throw new ValidationError("cannot check staged file sizes: malformed Git raw diff output");
    }
    const status = parts[4] ?? "";
    let oldPath: string | undefined;
    let path: string | undefined;
    if (status.startsWith("R") || status.startsWith("C")) {
      oldPath = fields[i];
      i++;
      path = fields[i];
      i++;
    } else {
      path = fields[i];
      i++;
    }
    if (path === undefined || (oldPath === undefined && (status.startsWith("R") || status.startsWith("C")))) {
      throw new ValidationError("cannot check staged file sizes: incomplete Git raw diff output");
    }
    const entry: RawEntry = { status, path, oldOid: parts[2] ?? "", newOid: parts[3] ?? "" };
    if (oldPath !== undefined) entry.oldPath = oldPath;
    entries.push(entry);
  }
  return entries;
}

function parseNumstat(output: string): Map<string, boolean> {
  const fields = output.split("\0");
  const binary = new Map<string, boolean>();
  let i = 0;
  while (i < fields.length) {
    const row = fields[i];
    if (row === undefined || row === "") break;
    i++;
    const firstTab = row.indexOf("\t");
    const secondTab = row.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new ValidationError("cannot check staged file sizes: malformed Git numstat output");
    const added = row.slice(0, firstTab);
    const deleted = row.slice(firstTab + 1, secondTab);
    let path = row.slice(secondTab + 1);
    // With --find-renames -z, rename records contain an empty path followed
    // by the old and new path. The new path is what is staged.
    if (path === "") {
      i++; // old path
      const newPath = fields[i];
      i++;
      if (newPath === undefined) throw new ValidationError("cannot check staged file sizes: incomplete Git rename output");
      path = newPath;
    }
    binary.set(path, added === "-" && deleted === "-");
  }
  return binary;
}

async function objectSizes(root: string, oids: Iterable<string>, signal?: AbortSignal): Promise<Map<string, { type: string; size: number }>> {
  const unique = [...new Set([...oids].filter(isOid))];
  if (!unique.length) return new Map();
  const output = await gitOutput(root, ["cat-file", "--batch-check"], signal, `${unique.join("\n")}\n`);
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== unique.length) throw new ValidationError("cannot check staged file sizes: incomplete cat-file output");
  const sizes = new Map<string, { type: string; size: number }>();
  for (const line of lines) {
    const parts = line.split(" ");
    const oid = parts[0] ?? "";
    const type = parts[1] ?? "";
    const rawSize = parts[2] ?? "";
    if (!isOid(oid) || !type || !/^[0-9]+$/.test(rawSize)) {
      throw new ValidationError("cannot check staged file sizes: malformed cat-file output");
    }
    sizes.set(oid, { type, size: Number(rawSize) });
  }
  return sizes;
}

export async function checkStagedFileSize(root: string, signal?: AbortSignal): Promise<SizeCheck> {
  const policy = await loadPolicy(root, signal);
  const maxBytes = policy.maxTokens * policy.bytesPerToken;
  const raw = await gitOutput(root, [
    "--no-pager", "diff", "--cached", "--find-renames", "--no-ext-diff", "--no-textconv",
    "--raw", "-z", "--no-abbrev", "--diff-filter=ACMRT",
  ], signal);
  const entries = parseRaw(raw);
  const numstat = await gitOutput(root, [
    "--literal-pathspecs", "--no-pager", "diff", "--cached", "--find-renames", "--no-ext-diff", "--no-textconv",
    "--numstat", "-z", "--diff-filter=ACMRT",
  ], signal);
  const binary = parseNumstat(numstat);

  const oids = entries.flatMap((entry) => [entry.newOid, entry.status.startsWith("C") ? "" : entry.oldOid]);
  const sizes = await objectSizes(root, oids, signal);
  const violations: SizeViolation[] = [];
  let checked = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (policy.ignores.some((pattern) => pattern.test(entry.path)) || binary.get(entry.path) === true) {
      skipped++;
      continue;
    }
    const staged = sizes.get(entry.newOid);
    if (!staged || staged.type !== "blob") {
      skipped++;
      continue;
    }
    checked++;

    const oldOid = entry.status.startsWith("C") ? undefined : entry.oldOid;
    const old = oldOid ? sizes.get(oldOid) : undefined;
    const oldBytes = old !== undefined && old.type === "blob" ? old.size : null;

    if (policy.mode === "new" && oldBytes !== null) continue;
    if (policy.mode === "growth" && oldBytes !== null && (staged.size <= maxBytes || staged.size <= oldBytes)) continue;
    if (staged.size <= maxBytes) continue;

    violations.push({
      path: entry.path,
      stagedBytes: staged.size,
      oldBytes,
      reason: oldBytes === null ? "new file" : staged.size > oldBytes ? "existing file grew beyond the limit" : "existing file exceeds the limit",
    });
  }

  return { maxBytes, bytesPerToken: policy.bytesPerToken, checked, skipped, violations };
}

export function formatSizeViolations(check: SizeCheck): string {
  const lines = [
    "commit blocked: staged file-size policy violation",
    `limit: ${check.maxBytes} bytes (~${Math.ceil(check.maxBytes / check.bytesPerToken)} tokens; bytes/${check.bytesPerToken})`,
  ];
  for (const v of check.violations) {
    const tokens = Math.ceil(v.stagedBytes / check.bytesPerToken);
    lines.push(`- ${v.path}: ${v.stagedBytes} bytes (~${tokens} tokens); ${v.reason}${v.oldBytes === null ? "" : `; previous ${v.oldBytes} bytes`}`);
  }
  lines.push("fix: split the new source file or add a narrow ignore=... rule for a non-source file in .agent-file-size.conf");
  return lines.join("\n");
}
