/** The two note-writing tools. Both are two-phase: without `confirm:true`
 *  only a preview is returned and no file changes. Gates, in order: the
 *  global `allowWrite` config, then the per-root `writable` flag (a write
 *  target in a read-only root is refused with its own text). Writes target
 *  one source and — without explicit `<label>:<rel>` addressing — its first
 *  writable root; the preview names the vault (and the root when there are
 *  several). */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MoveArgs, WriteArgs } from "../contract.js";
import { conventions, err, linkReport, resolveWikiTargetInSource, text, today, type ToolContext } from "../context.js";
import { lineDiff, parseNote, renderNote, serializeYaml } from "../md.js";
import {
  displayRel,
  renderMoveDone,
  renderMovePreview,
  renderWriteDone,
  renderWritePreview,
} from "../render.js";
import { scanSecrets } from "../safety.js";
import type { ResolvedRef } from "../sources.js";
import type { Root, ToolResult } from "../types.js";

const metaCharsEscaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── knowledge_write ───────────────────────────────────────────────────────

export async function knowledgeWrite(a: WriteArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.config.allowWrite) return err("writes disabled (allowWrite=false in config)");
  const op = a.op ?? "create";
  const confirm = a.confirm === true;
  const source = ctx.source;

  // ── resolve the target (create targets the write root; the others resolve
  //    the existing note anywhere in the source, but never in a read-only root)
  let target: ResolvedRef;
  if (op === "create") {
    let t = a.target;
    if (t.endsWith("/")) {
      if (!a.title) return err("target ends with '/' — pass title to derive the filename");
      t = join(t, a.title);
    }
    target = ctx.resolveNoteRef(t, "write");
    if (existsSync(target.abs)) {
      return err(`note already exists: ${target.rel} — use op=update`);
    }
  } else {
    target = ctx.resolveNoteRef(a.target, "read");
    if (target.root.writable === false) {
      return err(`source root "${target.root.label}" is read-only by config`);
    }
  }

  // ── build the new note content
  const conv = conventions(target.root.path, dirname(target.abs));
  let newRaw: string;
  let oldRaw: string | null = null;
  let fmDecision: string;

  if (op === "create") {
    const useFm = a.frontmatter !== undefined || a.content?.startsWith("---") || conv.frontmatterShare >= 0.5;
    if (a.content !== undefined) {
      newRaw = a.content;
      fmDecision = "content supplied verbatim";
    } else {
      const fm: Record<string, unknown> = {
        ...(useFm ? { title: a.title ?? basename(target.rel, ".md"), updated: today(), status: "active" } : {}),
        ...(a.frontmatter ?? {}),
      };
      if (a.frontmatter !== undefined && !("updated" in a.frontmatter)) fm.updated = today();
      newRaw = Object.keys(fm).length ? `---\n${serializeYaml(fm)}\n---\n${a.body ?? ""}` : (a.body ?? "");
      fmDecision = useFm
        ? `frontmatter emitted (neighbours ${Math.round(conv.frontmatterShare * 100)}% have it${a.frontmatter !== undefined ? "; explicit props merged" : ""})`
        : "no frontmatter (neighbours have none)";
    }
  } else {
    oldRaw = readFileSync(target.abs, "utf8");
    const note = parseNote(oldRaw);
    if (op === "update") {
      if (a.content !== undefined) {
        newRaw = a.content;
        fmDecision = "content supplied verbatim";
      } else {
        const fm: Record<string, unknown> = { ...(note.frontmatter ?? {}) };
        const verbatim = note.frontmatterRaw !== null && note.frontmatter === null;
        if (verbatim && a.frontmatter !== undefined) {
          return err(
            `frontmatter of ${target.rel} is not parseable by the safe subset parser — edit via content= (full raw note) to avoid corrupting properties`,
          );
        }
        if (note.frontmatterRaw !== null && a.frontmatter === undefined) {
          // body-only change: keep the raw frontmatter block verbatim
          newRaw = renderNote({ frontmatterRaw: note.frontmatterRaw, frontmatter: null, body: a.body ?? note.body });
          fmDecision = "frontmatter kept verbatim (body-only change)";
        } else {
          for (const [k, v] of Object.entries(a.frontmatter ?? {})) {
            if (v === null) delete fm[k];
            else fm[k] = v;
          }
          fm.updated = today();
          newRaw = renderNote({ frontmatterRaw: null, frontmatter: fm, body: a.body ?? note.body });
          fmDecision = "frontmatter patched (updated bumped)";
        }
      }
    } else if (op === "retire") {
      if (note.frontmatterRaw !== null && note.frontmatter === null) {
        return err(`frontmatter of ${target.rel} is unparsable — retire needs a parseable block; edit via content=`);
      }
      const fm: Record<string, unknown> = { ...(note.frontmatter ?? {}) };
      fm.status = "retired";
      fm.retired_at = today();
      if (a.reason) fm.retire_reason = a.reason;
      newRaw = renderNote({ frontmatterRaw: null, frontmatter: fm, body: note.body });
      fmDecision = "status=retired marker (note kept — reversible)";
    } else {
      // supersede
      if (!a.superseded_by) return err("op=supersede requires superseded_by=<note>");
      if (note.frontmatterRaw !== null && note.frontmatter === null) {
        return err(`frontmatter of ${target.rel} is unparsable — supersede needs a parseable block; edit via content=`);
      }
      const r = resolveWikiTargetInSource(source, a.superseded_by);
      if (r.paths.length !== 1) {
        return err(
          `superseded_by does not resolve uniquely: ${a.superseded_by} (${r.paths.length === 0 ? "not found" : "ambiguous"})`,
        );
      }
      const replacement = r.paths[0]!;
      const fm: Record<string, unknown> = { ...(note.frontmatter ?? {}) };
      fm.status = "superseded";
      fm.superseded_by = `[[${basename(replacement.rel, ".md")}]]`;
      fm.updated = today();
      const banner = `> Superseded by [[${basename(replacement.rel, ".md")}]] — ${today()}.\n\n`;
      newRaw = renderNote({
        frontmatterRaw: null,
        frontmatter: fm,
        body: banner + note.body.replace(/^> Superseded by[^\n]*\n\n/, ""),
      });
      fmDecision = `redirect to ${replacement.rel}`;
    }
  }

  // ── validations (warnings, not blockers — except the secrets policy)
  const warnings: string[] = [];
  const secrets = scanSecrets(newRaw);
  if (secrets.length) warnings.push(`possible secrets in content: ${secrets.join(", ")} — remove before saving`);
  const lr = linkReport(source, newRaw);
  if (lr.unresolved.length) {
    warnings.push(`unresolved wikilinks (targets not in vault): ${lr.unresolved.slice(0, 10).join(", ")}`);
  }
  if (lr.ambiguous.length) warnings.push(`ambiguous link targets: ${lr.ambiguous.slice(0, 10).join(", ")}`);
  if (op === "create") {
    const dup = await ctx.search.searchVault(target.root.path, basename(target.rel, ".md"), { limit: 5, prefer: "rg" });
    const dups = dup.hits.map((h) => h.path).filter((p) => p !== target.rel);
    if (dups.length) {
      warnings.push(`possible duplicates (similar title already exists): ${dups.join(", ")} — prefer updating an authoritative note`);
    }
  }

  // ── preview
  if (!confirm) {
    return text(
      renderWritePreview({
        op,
        targetRel: target.rel,
        vault: source.name,
        ...(source.roots.length > 1 ? { root: target.root.label } : {}),
        format: fmDecision,
        warnings,
        ...(oldRaw !== null ? { diff: lineDiff(oldRaw, newRaw) } : { newRaw }),
      }),
    );
  }

  // ── execute + verify
  if (secrets.length) return err(`refusing to write: possible secrets (${secrets.join(", ")})`);
  if (op === "create") mkdirSync(dirname(target.abs), { recursive: true });
  writeFileSync(target.abs, newRaw.endsWith("\n") ? newRaw : `${newRaw}\n`, "utf8");
  const back = parseNote(readFileSync(target.abs, "utf8"));
  if (back.frontmatter === null && back.frontmatterRaw !== null && op !== "create") {
    return err(`written but frontmatter no longer parses — inspect ${target.rel} manually`);
  }
  const verify = await ctx.search.searchVault(target.root.path, basename(target.rel, ".md"), { limit: 3, prefer: "rg" });
  const rediscovered = verify.hits.some((h) => h.path === target.rel);
  return text(
    renderWriteDone({
      op,
      targetRel: target.rel,
      fmParses: Boolean(back.frontmatter && Object.keys(back.frontmatter).length),
      rediscovered,
      warnings,
    }),
  );
}

// ── knowledge_move ────────────────────────────────────────────────────────

export async function knowledgeMove(a: MoveArgs, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.config.allowWrite) return err("writes disabled (allowWrite=false in config)");
  const source = ctx.source;
  const from = ctx.resolveNoteRef(a.from, "read");
  if (from.root.writable === false) {
    return err(`source root "${from.root.label}" is read-only by config`);
  }
  const to = ctx.resolveNoteRef(a.to, "write");
  if (existsSync(to.abs)) return err(`destination exists: ${a.to}`);
  const updateLinks = a.updateLinks !== false;
  const multi = source.roots.length > 1;

  const oldBase = basename(from.abs, ".md");
  const newBase = basename(to.abs, ".md");
  const oldRelNoExt = from.rel.slice(0, -3);

  // referencing files across every root of the source (one namespace)
  let affected: Array<{ root: Root; rel: string }> = [];
  if (updateLinks) {
    for (const root of source.roots) {
      const r = await ctx.run(
        "rg",
        ["-l", "--glob", "*.md", "-e", `\\[\\[(${metaCharsEscaped(oldBase)}|${metaCharsEscaped(oldRelNoExt)})(#|\\]|\\|)`],
        { cwd: root.path, timeoutMs: 10_000 },
      );
      if (r.code !== 0) continue;
      for (const p of r.stdout.split("\n").filter(Boolean)) {
        if (root === from.root && p === from.rel) continue;
        affected.push({ root, rel: p });
      }
    }
  }

  if (a.confirm !== true) {
    return text(
      renderMovePreview({
        from: multi ? displayRel(source, from.root, from.rel) : from.rel,
        to: multi ? displayRel(source, to.root, to.rel) : to.rel,
        vault: source.name,
        ...(multi ? { fromRoot: from.root.label, toRoot: to.root.label } : {}),
        updateLinks,
        referencedBy: affected.length,
        oldBase,
        affected: affected.map((f) => (multi ? `${f.root.label}/${f.rel}` : f.rel)),
      }),
    );
  }

  mkdirSync(dirname(to.abs), { recursive: true });
  renameSync(from.abs, to.abs);
  let rewritten = 0;
  for (const f of affected) {
    const abs = join(f.root.path, f.rel);
    try {
      const raw = readFileSync(abs, "utf8");
      const re = new RegExp(
        `\\[\\[(${metaCharsEscaped(oldBase)}|${metaCharsEscaped(oldRelNoExt)})((?:#[^\\]|]*)?)(\\|[^\\]]*)?\\]\\]`,
        "g",
      );
      const next = raw.replace(re, (_m, _tgt, sect, alias) => `[[${newBase}${sect ?? ""}${alias ?? ""}]]`);
      if (next !== raw) {
        writeFileSync(abs, next, "utf8");
        rewritten++;
      }
    } catch {
      /* unreadable referencing file — left untouched */
    }
  }
  const check = readFileSync(to.abs, "utf8");
  const moved = (r: ResolvedRef): string => (multi ? displayRel(source, r.root, r.rel) : r.rel);
  return text(renderMoveDone({ from: moved(from), to: moved(to), rewritten, affected: affected.length, chars: check.length }));
}
