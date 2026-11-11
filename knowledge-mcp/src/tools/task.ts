/** knowledge_task — the `numados-task-*` workspace protocol, ported
 *  behaviour-for-behaviour from the source server: `_task_index.md` (the
 *  projection) + append-only `iterations/NNNN-<stage>[-<phase>].md` (the
 *  events). Event outcomes (`status`) and task lifecycle (`taskStatus`) stay
 *  independent; legacy indexes (ticket/repos/bullets) are read, never
 *  migrated; an unparsable index is refused, never overwritten. Writes are
 *  two-phase like every write tool.
 *
 *  Routing: explicit vault → taskVault → repo/projects/primary (context.ts);
 *  the workspace root resolves inside the write root. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_STATUSES, TASK_STATUSES, type TaskArgs } from "../contract.js";
import { err, text, today, type TaskContext } from "../context.js";
import { lineDiff, outline, parseNote, renderNote, serializeYaml } from "../md.js";
import {
  renderTaskInitPreview,
  renderTaskIterationPreview,
  renderTaskStatus,
  renderTaskUpdatePreview,
  type TaskStatusView,
} from "../render.js";
import { repoName } from "../repo-config.js";
import { safeResolve } from "../safety.js";
import type { Heading, ToolResult } from "../types.js";

const ITERATION_PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** workflow stage → task lifecycle (the inference the protocol documents). */
const STAGE_TASK_STATUS: Record<string, string> = {
  brainstorm: "brainstorm",
  "gap-drill": "brainstorm",
  planning: "planning",
  implementation: "implementing",
  review: "reviewing",
};

/** Event outcomes and task lifecycle are separate; old index statuses survive
 *  projection-only updates until a stage or explicit lifecycle replaces them. */
function taskLifecycle(a: TaskArgs, fallback?: unknown): unknown {
  return (
    a.taskStatus ??
    (["blocked", "done"].includes(a.status ?? "") ? a.status : undefined) ??
    (a.stage !== undefined ? STAGE_TASK_STATUS[a.stage] : undefined) ??
    fallback
  );
}

function taskRepos(repos: string[]): Array<Record<string, unknown>> {
  return repos.map((r) => ({
    name: basename(r.replace(/\/+$/, "")),
    ...(r.startsWith("/") ? { path: r } : {}),
  }));
}

/** Patch canonical lines or legacy bullets without replacing the surrounding text. */
function taskBody(body: string, a: TaskArgs, status?: unknown): string {
  const setLine = (label: string, value: unknown): void => {
    if (value === undefined) return;
    const re = new RegExp(`^((?:- )?${label}:[ \\t]*).*$`, "im");
    if (re.test(body)) body = body.replace(re, (_line, prefix) => `${prefix}${value}`);
    else if (/^## Current state\r?$/m.test(body)) {
      body = body.replace(/^(## Current state\r?\n)/m, (_line, heading) => `${heading}- ${label}: ${value}\n`);
    } else if (label !== "status") {
      body = `${body.replace(/\s*$/, "")}\n${label === "next" ? "Next" : "Blocker"}: ${value}\n`;
    }
  };
  setLine("status", status);
  setLine("next", a.next);
  setLine("blocker", a.blocker);
  return body;
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

// ── knowledge_task ────────────────────────────────────────────────────────

export async function knowledgeTask(a: TaskArgs, ctx: TaskContext): Promise<ToolResult> {
  const action = a.action ?? "status";
  if (!ctx.config.allowWrite && action !== "status") {
    return err("writes disabled (allowWrite=false in config)");
  }

  const root = ctx.taskRoot.root;
  const ticket = String(a.ticket);
  const wsRel = `${ctx.taskRoot.rel}/${ticket}`;
  const wsAbs = safeResolve(root.path, wsRel, "write");
  const indexRel = `${wsRel}/_task_index.md`;
  const indexAbs = join(wsAbs, "_task_index.md");
  const rootLine: { root?: string } =
    ctx.source.roots.length > 1 ? { root: root.label } : {};

  if (a.taskStatus !== undefined && !TASK_STATUSES.includes(a.taskStatus)) {
    return err("invalid taskStatus lifecycle");
  }
  if (a.status !== undefined && !EVENT_STATUSES.includes(a.status)) return err("invalid event status");
  if (a.stage !== undefined && !Object.hasOwn(STAGE_TASK_STATUS, a.stage)) return err("invalid workflow stage");

  const readIndex = () => {
    if (!existsSync(indexAbs)) return null;
    return parseNote(readFileSync(indexAbs, "utf8"));
  };

  // ── status: recover the latest state fast
  if (action === "status") {
    const idxNote = readIndex();
    if (!idxNote) {
      return err(
        `no task workspace at ${indexRel} — init it, or check taskRoot (repo config: ${ctx.repoCtx.configPath ?? "none"})`,
      );
    }
    const fm = idxNote.frontmatter ?? {};
    const latest = typeof fm.latest_iteration === "string" ? fm.latest_iteration : null;
    let latestView: TaskStatusView["latest"] = null;
    if (latest) {
      // latest_iteration is task-workspace-relative (numados protocol)
      let p: string | null = null;
      try {
        const inRoot = safeResolve(root.path, latest, "read");
        if (existsSync(inRoot)) p = inRoot;
        else {
          const inWs = safeResolve(wsAbs, latest, "read");
          if (existsSync(inWs)) p = inWs;
        }
      } catch {
        /* an escaping link is reported as MISSING below */
      }
      if (p !== null) {
        const it = parseNote(readFileSync(p, "utf8"));
        const ifm = it.frontmatter ?? {};
        const headings: Heading[] = outline(it.body);
        latestView = {
          link: latest,
          stage: String(ifm.stage ?? "?"),
          status: String(ifm.status ?? "?"),
          iteration: String(ifm.iteration ?? "?"),
          headings,
          missing: false,
        };
      } else {
        latestView = { link: latest, stage: "?", status: "?", iteration: "?", headings: [], missing: true };
      }
    }
    const itDir = join(wsAbs, "iterations");
    const events = existsSync(itDir) ? readdirSync(itDir).filter((f) => f.endsWith(".md")).sort() : [];
    return text(
      renderTaskStatus({
        indexRel,
        taskId: String(fm.task_id ?? fm.ticket ?? ticket),
        status: String(fm.status ?? "?"),
        updated: String(fm.updated ?? "?"),
        repository: String(fm.repository ?? "(legacy repos)"),
        currentPhase: String(fm.current_phase ?? "none"),
        title: String(fm.title ?? "?"),
        repos: fm.repos ?? [],
        iterations: events,
        latest: latestView,
        wsRel,
        workspaceList: existsSync(wsAbs) ? readdirSync(wsAbs).slice(0, 12).join(", ") : "(missing)",
      }),
    );
  }

  // ── init: create the workspace
  if (action === "init") {
    if (existsSync(indexAbs)) {
      return err(`task workspace already exists: ${indexRel} — use action=status/iteration`);
    }
    if (!a.title) return err("init requires title=");
    const inferredRepo = repoName(ctx.repoCtx);
    const repos = taskRepos(a.repos ?? (inferredRepo !== undefined ? [inferredRepo] : []));
    const fm: Record<string, unknown> = {
      format: "numados-task-index-v1",
      task_id: ticket,
      title: a.title,
      status: taskLifecycle(a, "brainstorm"),
      repository: (repos[0] as { name?: string } | undefined)?.name ?? "none",
      repos,
      current_phase: a.phase || "none",
      created: today(),
      updated: today(),
      latest_iteration: null,
    };
    const body = `Current state: Workspace initialized.\nNext: ${a.next ?? "—"}\nBlocker: ${a.blocker ?? "none"}\n`;
    const raw = `---\n${serializeYaml(fm)}\n---\n${body}`;
    if (a.confirm !== true) {
      return text(renderTaskInitPreview({ indexRel, vault: ctx.source.name, ...rootLine, raw }));
    }
    mkdirSync(wsAbs, { recursive: true });
    writeFileSync(indexAbs, raw, "utf8");
    return text(`task workspace created: ${indexRel}\nverification: re-read ${existsSync(indexAbs) ? "OK" : "FAILED"}`);
  }

  // ── iteration: the small-agent append (one event per meaningful step)
  if (action === "iteration") {
    const idxNote = readIndex();
    if (!idxNote) return err(`no task workspace at ${indexRel} — action=init first`);
    if (!a.stage) return err("iteration requires stage=");
    if (idxNote.frontmatterRaw !== null && idxNote.frontmatter === null) {
      return err(`index frontmatter unparsable — fix ${indexRel} manually`);
    }
    const fmIdx = idxNote.frontmatter ?? {};
    const itDir = join(wsAbs, "iterations");
    const existing = existsSync(itDir) ? readdirSync(itDir).filter((f) => f.endsWith(".md")).sort() : [];
    const seq = existing.length ? Number(existing[existing.length - 1]!.slice(0, 4)) + 1 : 1;
    if (!Number.isFinite(seq)) {
      return err(`cannot derive next sequence from ${existing[existing.length - 1]}`);
    }
    const num = String(seq).padStart(4, "0");
    const phase = a.phase == null || a.phase === "" ? undefined : String(a.phase);
    if (phase !== undefined && !ITERATION_PHASE_RE.test(phase)) {
      return err(
        "iteration phase must contain only letters, numbers, underscores, and hyphens, and must start with a letter or number",
      );
    }
    const suffix = phase ? `-${phase}` : "";
    const fileName = `${num}-${a.stage}${suffix}.md`;
    const rel = `${wsRel}/iterations/${fileName}`;
    const eventAbs = safeResolve(root.path, rel, "write");
    const prev = existing.length ? `iterations/${existing[existing.length - 1]}` : null;
    const prevFm = prev
      ? (() => {
          try {
            return parseNote(readFileSync(join(wsAbs, prev), "utf8")).frontmatter ?? {};
          } catch {
            return {};
          }
        })()
      : {};
    const fm: Record<string, unknown> = {
      format: "numados-task-iteration-v1",
      task_id: fmIdx.task_id ?? fmIdx.ticket ?? ticket,
      iteration: `"${num}"`,
      stage: a.stage,
      status: a.status ?? "active",
      previous: prev,
      created: today(),
    };
    const section = (title: string, v?: string): string => (v && v.trim() ? `## ${title}\n\n${v.trim()}\n` : "");
    const body = `# Iteration ${num} — ${a.stage}${phase ? ` (${phase})` : ""}\n\n${section("Intent", a.intent)}${section("Verified state", a.verified)}${section("Changes", a.changes)}${section("Verification", a.verification)}${section("Handoff", a.handoff)}`;
    const raw = `---\n${serializeYaml(fm).replace(`iteration: ${JSON.stringify(`"${num}"`)}`, `iteration: "${num}"`)}\n---\n${body}`;
    // index projection update
    const idxFm: Record<string, unknown> = { ...fmIdx };
    idxFm.updated = today();
    idxFm.latest_iteration = `iterations/${fileName}`;
    idxFm.status = taskLifecycle(a, fmIdx.status);
    idxFm.current_phase = phase ?? "none";
    const idxRaw = renderNote({ frontmatterRaw: null, frontmatter: idxFm, body: taskBody(idxNote.body, a, idxFm.status) });
    if (a.confirm !== true) {
      return text(
        renderTaskIterationPreview({
          rel,
          vault: ctx.source.name,
          ...rootLine,
          num,
          previous: prev ?? "(first)",
          prevStatus: String(prevFm.status ?? "—"),
          indexProjection: `index will be updated: latest_iteration=iterations/${fileName}, status=${idxFm.status}, current_phase=${idxFm.current_phase}, updated=${today()}`,
          raw,
        }),
      );
    }
    mkdirSync(itDir, { recursive: true });
    writeFileSync(eventAbs, raw, "utf8");
    writeFileSync(indexAbs, idxRaw, "utf8");
    const back = parseNote(readFileSync(eventAbs, "utf8"));
    const okFm = back.frontmatter !== null && String(back.frontmatter.iteration).replace(/"/g, "") === num;
    return text(
      `iteration appended: ${rel}\nindex updated: ${indexRel}\nverification: frontmatter ${okFm ? "OK" : "MISMATCH"} (task_id=${back.frontmatter?.task_id ?? "?"})`,
    );
  }

  // ── update: index projection fields
  const idxNote = readIndex();
  if (!idxNote) return err(`no task workspace at ${indexRel}`);
  if (idxNote.frontmatterRaw !== null && idxNote.frontmatter === null) {
    return err(`index frontmatter unparsable — fix ${indexRel} manually`);
  }
  const fm: Record<string, unknown> = { ...(idxNote.frontmatter ?? {}) };
  if (a.title) fm.title = a.title;
  const lifecycle = taskLifecycle(a, fm.status);
  if (lifecycle !== undefined) fm.status = lifecycle;
  if (a.phase !== undefined) fm.current_phase = a.phase || "none";
  if (a.repos) {
    const repos = taskRepos(a.repos);
    fm.repos = repos;
    if ("repository" in fm || "task_id" in fm) fm.repository = (repos[0] as { name?: string } | undefined)?.name ?? "none";
  }
  fm.updated = today();
  const idxRaw = renderNote({ frontmatterRaw: null, frontmatter: fm, body: taskBody(idxNote.body, a, lifecycle) });
  if (a.confirm !== true) {
    return text(
      renderTaskUpdatePreview({
        indexRel,
        vault: ctx.source.name,
        ...rootLine,
        diff: lineDiff(renderNote(idxNote), idxRaw),
      }),
    );
  }
  writeFileSync(indexAbs, idxRaw, "utf8");
  return text(`index updated: ${indexRel} (status=${fm.status ?? "?"}, updated=${today()})`);
}
