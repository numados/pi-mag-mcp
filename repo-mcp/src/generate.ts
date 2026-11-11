/** Generation tools — produce text, never execute git mutations
 *  (numados-branch / numados-commit-message contracts, 1:1).
 *
 *  branch_plan: Jira key preserved verbatim, no suffix; ADO numeric id
 *  preserved verbatim + caller-supplied description slugified to 2–5 kebab
 *  words. Base = cached origin/HEAD → tracking-branch fallback → explicit
 *  caller base only; ambiguity is an error, never a guess. Returns the exact
 *  `git switch -c` command for the caller to run via branch_create (approval
 *  tier) — this tool itself runs nothing.
 *
 *  commit_message: gathers diff/branch/history/repo-instruction CONTEXT,
 *  reports exactly which context was selected, and formats the caller-supplied
 *  summary/type/scope/body deterministically. Conventional-Commits-style
 *  formatting is the FALLBACK; the server cannot infer repository semantics
 *  or conventions reliably — the caller's judgment governs (documented in
 *  every response). */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./exec.js";
import { detectDefaultBranch } from "./defaults.js";
import { resolveRepo } from "./repo.js";
import { ValidationError, isString, validateRef, validateMessage } from "./validate.js";

export interface BranchPlanResult {
  branch: string;
  base: string;
  baseHow: string;
  tracker: "jira" | "ado";
  ticket: string;
  type: "bugfix" | "feature";
  command: string;
  note: string;
}

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ADO_ID = /^\d+$/;

/** slugify a caller-supplied description into kebab words */
export function slugifyWords(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
}

export function quoteCommand(args: string[]): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `git ${args.map(q).join(" ")}`;
}

export async function branchPlan(p: Record<string, unknown>): Promise<BranchPlanResult> {
  const { root } = await resolveRepo(p.repo);

  const tracker = p.tracker;
  if (tracker !== "jira" && tracker !== "ado") throw new ValidationError("tracker must be 'jira' or 'ado'");
  const type = p.type;
  if (type !== "bugfix" && type !== "feature") throw new ValidationError("type must be 'bugfix' or 'feature'");
  if (!isString(p.ticket) || p.ticket.length === 0) throw new ValidationError("ticket is required (Jira key like PROJ-123, or Azure DevOps numeric id)");

  let branch: string;
  const ticket = p.ticket;

  if (tracker === "jira") {
    if (!JIRA_KEY.test(ticket)) {
      throw new ValidationError(`Jira ticket must look like PROJ-123 (letters, then dash, then digits): "${ticket}"`);
    }
    // key preserved exactly as supplied — never reformatted, no suffix
    branch = `${type}/${ticket}`;
    if (p.description !== undefined) {
      throw new ValidationError("Jira branches carry only the key — do not pass description for tracker 'jira'");
    }
  } else {
    if (!ADO_ID.test(ticket)) {
      throw new ValidationError(`Azure DevOps ticket must be the numeric work-item id exactly as supplied: "${ticket}"`);
    }
    if (!isString(p.description) || p.description.trim().length === 0) {
      throw new ValidationError("tracker 'ado' requires description (the branch suffix: 2–5 lowercase kebab-case words naming the change's topic)");
    }
    const words = slugifyWords(p.description);
    if (words.length < 2 || words.length > 5) {
      throw new ValidationError(
        `ADO description must normalize to 2–5 kebab words (got ${words.length}: "${words.join("-")}") — name the change's topic, not the repository`,
      );
    }
    branch = `${type}/${ticket}-${words.join("-")}`;
  }

  // base: explicit only if supplied; else origin/HEAD → tracking fallback;
  // ambiguous/undeterminable is an error, never a guess.
  let base: string;
  let baseHow: string;
  if (p.base !== undefined) {
    base = validateRef(p.base, "base");
    baseHow = "explicitly supplied by caller";
  } else {
    const det = await detectDefaultBranch(root);
    base = det.branch;
    baseHow = det.how;
  }

  return {
    branch,
    base,
    baseHow,
    tracker,
    ticket,
    type,
    command: quoteCommand(["switch", "--no-overwrite-ignore", "-c", branch, base]),
    note:
      "Plan only — nothing executed. Never check out or move the base branch itself. To create it, call branch_create (two-step approval) or run the command yourself after user authorization.",
  };
}

// ── commit_message ────────────────────────────────────────────────────────

const CC_TYPES = ["feat", "fix", "test", "docs", "refactor", "perf", "build", "ops", "chore", "style"] as const;
const REPO_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"];

export interface CommitMessageResult {
  message: string;
  scopeUsed: "staged" | "unstaged";
  files: string[];
  ticket: string | null;
  ticketSource: "supplied" | "branch" | "none";
  historyConvention: string;
  historySample: string[];
  repoInstructionFiles: string[];
  limitation: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

function extractTicketFromBranch(branch: string): string | null {
  // bugfix/PROJ-123 or feature/PROJ-123-suffix → PROJ-123
  const jira = branch.match(/(?:^|\/)([A-Za-z][A-Za-z0-9_]*-\d+)(?:$|[-/])/);
  if (jira) return jira[1] ?? null;
  // bugfix/181874-editable-instrument-type → 181874
  const ado = branch.match(/(?:^|\/)(\d+)(?:$|-)/);
  if (ado) return ado[1] ?? null;
  return null;
}

export function stagedFromPorcelain(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .filter((l) => {
      const x = l[0];
      return x !== " " && x !== "?" && x !== "#";
    })
    .map((l) => {
      const parts = l.slice(3).split(" -> ");
      return (parts.at(-1) ?? "").trim();
    });
}

export async function commitMessage(p: Record<string, unknown>): Promise<CommitMessageResult> {
  const { root } = await resolveRepo(p.repo);

  const type = p.type;
  if (!isString(type) || !(CC_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(`type must be one of: ${CC_TYPES.join(", ")}`);
  }
  if (!isString(p.summary) || p.summary.trim().length === 0) throw new ValidationError("summary is required (imperative one-liner describing the durable outcome)");
  const summary = p.summary.trim();
  if (summary.includes("\n")) throw new ValidationError("summary must be a single line (use body for detail)");
  if (!/^[A-Z0-9]/.test(summary)) throw new ValidationError("summary should start with a capital letter or digit");
  if (summary.endsWith(".")) throw new ValidationError("summary should not end with a period");

  let scope: string | undefined;
  if (p.scope !== undefined) {
    if (!isString(p.scope) || !/^[a-z0-9][a-z0-9_.-]*$/i.test(p.scope) || p.scope.includes(":")) {
      throw new ValidationError("scope must be a short topic token (letters/digits/dots/dashes), not the repository name");
    }
    scope = p.scope;
  }

  // body: optional, 1–3 bullets (string with newlines or array)
  let bullets: string[] = [];
  if (p.body !== undefined) {
    let raw: string[];
    if (isStringArray(p.body)) {
      raw = p.body;
    } else if (isString(p.body)) {
      raw = p.body.split("\n");
    } else {
      throw new ValidationError("body must be a string or array of strings");
    }
    bullets = raw.map((b) => b.trim().replace(/^[-*]\s+/, "")).filter(Boolean);
    if (bullets.length === 0) throw new ValidationError("body supplied but empty after trimming");
    if (bullets.length > 3) throw new ValidationError(`body allows at most 3 bullets (got ${bullets.length}) — split unrelated concerns into separate commits`);
    for (const b of bullets) {
      if (b.includes("\x00") || /co-authored-by|generated with|generated-by|🤖/i.test(b)) {
        throw new ValidationError("body bullets must not contain AI/model/agent attribution or co-author metadata");
      }
    }
  }

  // ── context gathering (read-only) ──
  const status = await git({ cwd: root, args: ["status", "--porcelain=v1"] });
  if (status.code !== 0) throw new ValidationError(`git status failed: ${status.stderr.trim().split("\n")[0]}`);
  const staged = stagedFromPorcelain(status.stdout);

  let scopeUsed: "staged" | "unstaged";
  let diffStat: string[] = [];
  if (staged.length > 0) {
    scopeUsed = "staged";
    const d = await git({ cwd: root, args: ["diff", "--cached", "--stat"] });
    if (d.code !== 0) throw new ValidationError(`git diff --cached --stat failed: ${d.stderr.trim().split("\n")[0]}`);
    diffStat = d.stdout.trim() ? d.stdout.trim().split("\n") : [];
  } else {
    // nothing staged — inspect the unstaged diff and REPORT that assumption
    scopeUsed = "unstaged";
    const d = await git({ cwd: root, args: ["diff", "--stat"] });
    if (d.code !== 0 || d.stdout.trim().length === 0) {
      throw new ValidationError(
        "no staged and no unstaged changes found — nothing to describe; stage changes first (this tool never stages anything)",
      );
    }
    diffStat = d.stdout.trim().split("\n");
  }

  // branch → ticket
  let ticket: string | null = null;
  let ticketSource: "supplied" | "branch" | "none" = "none";
  if (p.ticket !== undefined) {
    if (!isString(p.ticket) || !(JIRA_KEY.test(p.ticket) || ADO_ID.test(p.ticket))) {
      throw new ValidationError(`ticket must be a Jira key (PROJ-123) or a numeric work-item id exactly as supplied: "${p.ticket}"`);
    }
    ticket = p.ticket; // used exactly as supplied — never reformatted or invented
    ticketSource = "supplied";
  } else {
    const b = await git({ cwd: root, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
    if (b.code === 0) {
      const found = extractTicketFromBranch(b.stdout.trim());
      if (found) {
        ticket = found;
        ticketSource = "branch";
      }
    }
  }

  // recent history sample + crude convention detection
  const historySample: string[] = [];
  let historyConvention = "no recent history (or unreadable) — fallback format used";
  const h = await git({ cwd: root, args: ["log", "-n", "10", "--format=%s"] });
  if (h.code === 0) {
    const subjects = h.stdout.split("\n").filter(Boolean);
    historySample.push(...subjects);
    const cc = subjects.filter((s) => /^(feat|fix|test|docs|refactor|perf|build|ops|chore|style)(\([^)]*\))?(!)?: /.test(s)).length;
    historyConvention =
      subjects.length === 0
        ? "empty history — fallback format used"
        : cc >= subjects.length / 2
          ? `conventional-commits dominant in last ${subjects.length} subjects (${cc}/${subjects.length}) — fallback format consistent with it`
          : `no dominant conventional-commits pattern in last ${subjects.length} subjects (${cc}/${subjects.length}) — check repo instructions; fallback format used`;
  }

  const repoInstructionFiles = REPO_INSTRUCTION_FILES.filter((f) => existsSync(join(root, f)));

  // ── deterministic fallback formatting ──
  const subjectParts = [`${type}${scope ? `(${scope})` : ""}:`, ticket ? ` ${ticket}` : "", ` ${summary}`].join("");
  const lines = [subjectParts.trim()];
  if (bullets.length > 0) {
    lines.push("");
    for (const b of bullets) lines.push(`- ${b}`);
  }

  return {
    message: validateMessage(lines.join("\n")),
    scopeUsed,
    files: diffStat,
    ticket,
    ticketSource,
    historyConvention,
    historySample,
    repoInstructionFiles,
    limitation:
      "Deterministic fallback formatting only. This server cannot infer change semantics, repository-specific commit rules, or identifier placement reliably — the caller (with repository instructions and judgment) decides. Prefer supplying the final message to git_commit directly when a repository convention is known.",
  };
}
