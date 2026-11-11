/**
 * Text projection of every structured answer. One owner, so the text a model
 * reads and the JSON codemode receives cannot drift apart.
 */
import type { PullRequest, WorkItem } from "./types.js";

export function renderItem(item: WorkItem, verbose = true): string {
  const id = item.backend === "jira" ? (item.key ?? item.id) : `#${item.id}`;
  const lines = [
    `${id}  ${item.type ?? "?"}  [${item.state ?? "?"}]`,
    `Title:     ${item.title ?? "?"}`,
    `Assigned:  ${item.assignedTo ?? "(unassigned)"}`,
    `Changed:   ${item.changed ?? "?"}${verbose && item.iteration ? `   Iteration: ${item.iteration}` : ""}`,
  ];
  if (item.remaining || item.completed) {
    lines.push(`Work:      remaining ${item.remaining ?? "–"}h · completed ${item.completed ?? "–"}h`);
  }
  if (item.tags && item.tags.length > 0) lines.push(`Tags:      ${item.tags.join(", ")}`);
  if (item.parent) lines.push(`Parent:    ${item.parent.id} ${item.parent.title ?? ""}`.trimEnd());
  if (item.url) lines.push(`URL:       ${item.url}`);
  if (verbose && item.children && item.children.length > 0) {
    lines.push("", "Children:");
    for (const child of item.children) {
      const work = child.remaining ? ` · ${child.remaining}h` : child.completed ? ` · done ${child.completed}h` : "";
      lines.push(`  ${child.id.padEnd(8)} [${child.state ?? "?"}] ${child.title ?? "?"}${work}`);
    }
  }
  if (verbose && item.description) lines.push("", "── Description ──", item.description.slice(0, 4000));
  if (verbose && item.acceptanceCriteria) lines.push("", "── Acceptance Criteria ──", item.acceptanceCriteria.slice(0, 4000));
  return lines.join("\n");
}

export function renderItemRow(item: WorkItem): string {
  const id = item.backend === "jira" ? (item.key ?? item.id) : `#${item.id}`;
  return `  ${id.padEnd(9)} ${(item.type ?? "?").padEnd(12)} ${(item.state ?? "?").padEnd(14)} ${item.title ?? "?"}`;
}

const VOTE_ICON: Record<string, string> = {
  approve: "✅",
  reject: "❌",
  "wait-for-author": "👎",
  "approve-with-suggestions": "👍",
};

export function renderPr(pr: PullRequest, verbose = true): string {
  const lines = [
    `PR #${pr.id}${pr.isDraft ? " [DRAFT]" : ""}  ${pr.status ?? "?"}`,
    `Title:   ${pr.title ?? "?"}`,
    `Branch:  ${pr.source ?? "?"} → ${pr.target ?? "?"}`,
    `By:      ${pr.createdBy ?? "?"}  ${pr.created ?? ""}${pr.mergeStatus ? `  merge: ${pr.mergeStatus}` : ""}`.trimEnd(),
  ];
  if (pr.url) lines.push(`URL:     ${pr.url}`);
  if (verbose && pr.reviewers && pr.reviewers.length > 0) {
    lines.push("", "Reviewers:");
    for (const reviewer of pr.reviewers) {
      const icon = VOTE_ICON[reviewer.vote ?? ""] ?? "⏳";
      lines.push(`  ${icon} ${reviewer.name}${reviewer.required ? " [required]" : ""}`);
    }
  }
  if (verbose && pr.description) lines.push("", "── Description ──", pr.description.slice(0, 4000));
  return lines.join("\n");
}

export function renderPrRow(pr: PullRequest): string {
  const icon = pr.status === "active" ? (pr.isDraft ? "📝" : "🟢") : pr.status === "completed" ? "✅" : "❌";
  return `  ${icon} PR #${pr.id}  ${pr.title}\n     ${pr.source} → ${pr.target}  by ${pr.createdBy ?? "?"}`;
}

export function renderQueryResult(items: WorkItem[], count: number): string {
  if (count === 0) return "No work items found.";
  return `Found ${count}:\n\n${items.map(renderItemRow).join("\n")}`;
}

export function renderPrList(prs: PullRequest[]): string {
  if (prs.length === 0) return "No pull requests found.";
  return `Found ${prs.length} PR(s):\n\n${prs.map(renderPrRow).join("\n")}`;
}
