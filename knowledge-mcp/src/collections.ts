/** qmd collection vocabulary — the one owner of the rule that maps a source
 *  root to the qmd collection that indexes it, plus tolerant parsers for
 *  `qmd collection list` / `qmd collection show` output. Doctor (verdicts) and
 *  setup (commands) share this module; neither restates the naming or the
 *  output format. Parsing is deliberately forgiving: an unknown qmd version
 *  must surface as `unknown` with the raw first line, never as a crash or a
 *  wrong verdict. */

import type { Root, Source } from "./types.js";

/** `<source>` when the source has one root, `<source>-<label>` when several.
 *  qmd collections bind to one directory, so a multi-root source owns one
 *  collection per root and the name must stay derivable. */
export function collectionName(source: Pick<Source, "name" | "roots">, root: Root): string {
  return source.roots.length > 1 ? `${source.name}-${root.label}` : source.name;
}

export interface CollectionSummary {
  files?: number;
  /** Index age in minutes, when qmd printed a parseable one. */
  updatedMinutesAgo?: number;
}

const AGE_UNITS: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10_080 };

function parseAge(text: string): number | undefined {
  const m = /^(\d+)\s*([smhdw])/.exec(text.trim());
  if (m) return Math.round(Number(m[1]!) * (AGE_UNITS[m[2]!] ?? 0));
  if (/^(just now|now)$/i.test(text.trim())) return 0;
  return undefined;
}

/** `qmd collection list` → name → {files, updatedMinutesAgo}. Returns null
 *  when nothing recognizable was printed and the output does not look like an
 *  empty registry (the caller reports `unknown` with the raw first line). */
export function parseCollectionList(stdout: string): Map<string, CollectionSummary> | null {
  const out = new Map<string, CollectionSummary>();
  let sawHeader = false;
  let current: { name: string; summary: CollectionSummary } | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      current = null;
      continue;
    }
    const head = /^(\S+)\s+\(qmd:\/\/[^)]*\)\s*$/.exec(line);
    if (head) {
      sawHeader = true;
      current = { name: head[1]!, summary: {} };
      out.set(current.name, current.summary);
      continue;
    }
    const prop = /^\s+(\w[\w ]*?):\s+(.*?)\s*$/.exec(line);
    if (prop && current) {
      const [, key, value] = prop;
      if (key!.toLowerCase() === "files" && /^\d+$/.test(value!)) current.summary.files = Number(value);
      if (key!.toLowerCase() === "updated") {
        const minutes = parseAge(value!);
        if (minutes !== undefined) current.summary.updatedMinutesAgo = minutes;
      }
    }
  }
  if (sawHeader || /collections?\s*\(\s*0\s*\)|no collections/i.test(stdout)) return out;
  return null;
}

/** `qmd collection show <name>` → the registered directory path, or null when
 *  the output carries no recognizable `Path:` line. */
export function parseCollectionShow(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const m = /^\s*Path:\s+(.*?)\s*$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}
