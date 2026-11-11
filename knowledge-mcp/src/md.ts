/** Markdown engine: frontmatter (pragmatic YAML subset), heading outline,
 *  wikilink extraction/backlinks, section slicing, small line diff.
 *
 *  Frontmatter policy: parse a practical subset (scalars, inline/block string
 *  lists, nested one level). On anything unparsable the block is kept VERBATIM
 *  (update re-emits it unchanged) and callers get a warning — never a rewrite
 *  of properties we do not understand.
 *
 *  Ported from agent-toolkit knowledge-mcp unchanged in behaviour; only the
 *  strictness of the local tsconfig required guarding array/capture access. */

import type { Heading, Note, WikiLink } from "./types.js";

// ── frontmatter ───────────────────────────────────────────────────────────

export function parseNote(text: string): Note {
  if (!text.startsWith("---")) return { frontmatterRaw: null, frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatterRaw: null, frontmatter: {}, body: text };
  // closing fence must be at line start: "---" possibly followed by spaces/EOL
  const after = text.slice(end + 1);
  const m = /^---[ \t]*(\r?\n|$)/.exec(after);
  if (!m) return { frontmatterRaw: null, frontmatter: {}, body: text };
  const bodyStart = end + 1 + m[0].length;
  const fmRaw = text.slice(4, end); // skip opening "---\n"
  return { frontmatterRaw: fmRaw, frontmatter: parseYamlSubset(fmRaw), body: text.slice(bodyStart) };
}

function scalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  return t; // bare string (dates stay strings)
}

/** YAML subset: `key: value`, inline [a, b], block `- item` lists under a key,
 *  one nesting level (`parent:` + 2-space indented keys). Comments skipped.
 *  Returns null for anything else — callers keep the raw block verbatim. */
export function parseYamlSubset(raw: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  let ok = true;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) { i++; continue; }
    const m = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(line);
    if (!m) { ok = false; break; }
    const key = m[1]!;
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      // block value: list (scalars or mapping items), or nested map
      const listItems: unknown[] = [];
      const nested: Record<string, unknown> = {};
      let sawAny = false;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (/^\s*-\s+/.test(l)) {
          const itemText = l.replace(/^\s*-\s+/, "");
          const mapMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(itemText);
          if (mapMatch) {
            // mapping list item: `- k: v` + deeper-indented continuation keys
            const obj: Record<string, unknown> = { [mapMatch[1]!]: scalar(mapMatch[2] ?? "") };
            let k = j + 1;
            while (k < lines.length) {
              const cm = /^\s{3,}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[k]!);
              if (cm) { obj[cm[1]!] = scalar(cm[2] ?? ""); k++; continue; }
              break;
            }
            listItems.push(obj);
            sawAny = true;
            j = k;
            continue;
          }
          listItems.push(scalar(itemText));
          sawAny = true;
          j++;
          continue;
        }
        const nm = /^\s{2,}([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(l);
        if (nm) { nested[nm[1]!] = scalar(nm[2] ?? ""); sawAny = true; j++; continue; }
        break;
      }
      if (sawAny && listItems.length && Object.keys(nested).length) { ok = false; break; } // both → give up
      if (listItems.length) out[key] = listItems;
      else if (Object.keys(nested).length) out[key] = nested;
      else out[key] = null;
      i = j;
    } else if (/^\[.*\]$/.test(rest)) {
      out[key] = rest.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
      i++;
    } else if (rest === "|" || rest === ">" || rest.startsWith("|") || rest.startsWith(">")) {
      // block scalar: consume the indented block verbatim
      let j = i + 1;
      const buf: string[] = [];
      while (j < lines.length && (/^\s{2,}\S/.test(lines[j]!) || /^\s*$/.test(lines[j]!))) {
        buf.push(lines[j]!.replace(/^\s{2}/, ""));
        j++;
      }
      out[key] = buf.join("\n").replace(/\n+$/, "");
      i = j;
    } else {
      out[key] = scalar(rest);
      i++;
    }
  }
  return ok ? out : null; // null → caller keeps raw block verbatim
}

function esc(v: unknown): string {
  const s = String(v);
  return /[:#\n]/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function serializeYaml(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else if (v.every((x) => typeof x === "string" || typeof x === "number")) {
        lines.push(`${k}: [${v.map(esc).join(", ")}]`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) {
          if (item !== null && typeof item === "object") {
            const entries = Object.entries(item as Record<string, unknown>);
            entries.forEach(([k2, v2], idx2) => {
              lines.push(`${idx2 === 0 ? "  - " : "    "}${k2}: ${esc(v2)}`);
            });
          } else {
            lines.push(`  - ${typeof item === "string" ? item : JSON.stringify(item)}`);
          }
        }
      }
    } else if (v !== null && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) lines.push(`  ${k2}: ${esc(v2)}`);
    } else if (v === null) {
      lines.push(`${k}: null`);
    } else if (typeof v === "string" && v.includes("\n")) {
      lines.push(`${k}: |`);
      for (const l of v.split("\n")) lines.push(`  ${l}`);
    } else {
      lines.push(`${k}: ${esc(v)}`);
    }
  }
  return lines.join("\n");
}

export function renderNote(note: Note): string {
  if (note.frontmatterRaw !== null) {
    return `---\n${note.frontmatterRaw.replace(/\s*$/, "")}\n---\n${note.body}`;
  }
  if (note.frontmatter && Object.keys(note.frontmatter).length) {
    return `---\n${serializeYaml(note.frontmatter)}\n---\n${note.body}`;
  }
  return note.body;
}

// ── outline / sections ────────────────────────────────────────────────────

export function outline(body: string): Heading[] {
  const out: Heading[] = [];
  const inFence = { v: false };
  body.split(/\r?\n/).forEach((l, idx) => {
    if (/^\s*```/.test(l)) inFence.v = !inFence.v;
    if (inFence.v) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: idx + 1 });
  });
  return out;
}

/** Slice the body from a heading (by text prefix, case-insensitive) to the
 *  next heading of the same-or-higher level. */
export function section(body: string, name: string): string | null {
  const heads = outline(body);
  const idx = heads.findIndex((h) => h.text.toLowerCase().startsWith(name.toLowerCase()));
  if (idx === -1) return null;
  const start = heads[idx]!;
  const end = heads.slice(idx + 1).find((h) => h.level <= start.level);
  const lines = body.split(/\r?\n/);
  const from = start.line; // 1-based body line of the heading
  const to = end ? end.line - 1 : lines.length;
  return lines.slice(from, to).join("\n").replace(/\s+$/, "");
}

// ── wikilinks ─────────────────────────────────────────────────────────────

export function extractWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  const re = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const m of text.matchAll(re)) {
    const target = (m[2] ?? "").trim();
    if (!target) continue;
    const link: WikiLink = { target };
    if (m[3] !== undefined) link.section = m[3].slice(1);
    if (m[4] !== undefined) link.alias = m[4];
    out.push(link);
  }
  return out;
}

// ── diff (line-based, small) ──────────────────────────────────────────────

export function lineDiff(a: string, b: string, maxLines = 120): string[] {
  const al = a.split(/\r?\n/);
  const bl = b.split(/\r?\n/);
  // LCS table capped for safety
  const n = al.length, m = bl.length;
  if (n * m > 4_000_000) return [`(diff too large: ${n}x${m} lines — old ${n}, new ${m})`];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const cur = dp[i]!;
      const next = dp[i + 1]!;
      cur[j] = al[i] === bl[j] ? next[j + 1]! + 1 : Math.max(next[j]!, cur[j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push(`- ${al[i]!}`); i++; }
    else { out.push(`+ ${bl[j]!}`); j++; }
    if (out.length >= maxLines) { out.push(`… (${n + m - i - j} more changed lines)`); break; }
  }
  while (i < n && out.length < maxLines) { out.push(`- ${al[i]!}`); i++; }
  while (j < m && out.length < maxLines) { out.push(`+ ${bl[j]!}`); j++; }
  return out;
}
