/**
 * Text helpers shared by both providers: HTML entity decoding, tag stripping
 * and snippet clamping.
 *
 * Ordering matters and is the defect fixed here (research §3): the old server
 * decoded entities before stripping tags and then decoded again, which turned
 * `&lt;int&gt;` into a tag and deleted it. The rule now is single-pass:
 * strip real tags, decode entities once, leave literal `<...>` text intact.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

/** Decode HTML entities once. Unknown entities are left untouched. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Strip markup and decode entities, preserving literal angle-bracket text.
 *
 * Entities are decoded once, after tag removal, so `std::vector&lt;int&gt;`
 * survives as `std::vector<int>` instead of being mistaken for a tag.
 */
export function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface ClampedSnippet {
  snippet: string;
  truncated: boolean;
}

/**
 * Clamp a snippet to the output budget, cutting on a word boundary when one is
 * reasonably close so the text stays readable. Reports truncation explicitly
 * instead of silently dropping the remainder (research §3).
 */
export function clampSnippet(text: string, maxChars: number): ClampedSnippet {
  const normalized = stripHtml(text);
  if (normalized.length <= maxChars) return { snippet: normalized, truncated: false };
  const hardCut = normalized.slice(0, maxChars);
  const lastSpace = hardCut.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
  return { snippet: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * Keep only http(s) URLs. The old parser passed `javascript:` and any other
 * scheme through to the model (research §3: prompt-injection surface).
 */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
