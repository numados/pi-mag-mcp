/** Call modes: each mode wraps the task in a mode system prompt (expectations
 *  for the answer), NOT a separate code path. The safety rules block is the
 *  inherited channel policy; harness-side gates (no-git-push etc.) stay in
 *  place on top of it. */

export const MODES = ["research", "opinion", "review"] as const;
export type Mode = (typeof MODES)[number];

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const SAFETY_RULES = `SAFETY RULES:
- NEVER delete, modify, or write outside the current git repository.
- NEVER delete files not tracked by git (git ls-files to check).
- NEVER git push, git push --force, or any remote operation without explicit user permission.
- NEVER modify system files (/etc, /usr, /bin, /sbin, /opt/homebrew, ~/.codex, ~/.claude*).
- NEVER expose API keys, credentials, or secrets in output (redact with ***).
- For git operations: commit local changes is OK, push requires asking.
- Edit existing files with targeted changes rather than full rewrites.`;

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  research: `MODE: research — fact gathering.
Read the described material and answer the questions with evidence: file paths, line numbers, short quotes. Do not modify anything. Separate facts from inference; state explicitly what could not be established.`,
  opinion: `MODE: opinion — independent second opinion.
State your verdict first, then the reasoning: what is correct, what is wrong, what is risky, which alternative you would consider. Be concise; disagreement is more valuable than agreement.`,
  review: `MODE: review — confirmed findings only.
Review the described change/code. Report ONLY findings you confirmed in the source — no speculation, no praise, no style nits. One bullet per finding, exactly this shape:
- [severity] location — issue — evidence
severity: blocker|major|minor. location: path:line or symbol name.
If nothing is wrong, answer with exactly: NO FINDINGS`,
};

/** Compose the full task handed to the CLI: safety rules + mode + task. */
export function composeTask(mode: Mode, task: string): string {
  return `${SAFETY_RULES}\n\n${MODE_INSTRUCTIONS[mode]}\n\nTASK:\n${task}`;
}

// ── codex output cleanup ──────────────────────────────────────────────────

export function cleanCodexOutput(raw: string): string {
  let out = raw;
  // Pull content out of ``` fences if the whole output is wrapped
  const fenceMatch = out.match(/```[\s\S]*?\n([\s\S]*?)```/);
  const fenced = fenceMatch?.[1];
  if (fenced !== undefined) out = fenced.trim();
  // Cut off trailing token-count / separator footers
  const cutoffPatterns = [
    /\n---+\s*\n.*tokens used.*$/s,
    /\n---+\s*$/s,
    /\n\*\*Tokens used:.*$/s,
    /\ntokens used.*$/si,
  ];
  for (const pat of cutoffPatterns) {
    const m = out.match(pat);
    if (m && m.index !== undefined) out = out.slice(0, m.index).trim();
  }
  // Dangling separator left when only the bold footer matched
  out = out.replace(/\n---+\s*$/, "").trim();
  return out;
}

// ── review findings parsing ───────────────────────────────────────────────

export interface Finding {
  severity: "blocker" | "major" | "minor";
  location: string;
  issue: string;
  evidence?: string;
}

const SEVERITY_MAP: Record<string, Finding["severity"]> = {
  blocker: "blocker",
  critical: "blocker",
  major: "major",
  minor: "minor",
  info: "minor",
};

/** Conservative parser: only bullets shaped `- [severity] rest` count.
 *  Splits rest on " — " / " -- " into location — issue — evidence. */
export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s*\[(blocker|critical|major|minor|info)\]\s*(.+)$/i);
    if (!m) continue;
    const severityToken = m[1];
    const rest = m[2];
    if (severityToken === undefined || rest === undefined) continue;
    const severity = SEVERITY_MAP[severityToken.toLowerCase()];
    if (severity === undefined) continue;
    const parts = rest
      .split(/\s+(?:—|--)\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const location = parts[0];
    if (location === undefined) continue;
    findings.push({
      severity,
      location,
      issue: parts[1] ?? location,
      ...(parts.length >= 3 ? { evidence: parts.slice(2).join(" — ") } : {}),
    });
  }
  return findings;
}
