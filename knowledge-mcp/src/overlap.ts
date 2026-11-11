/** Copy-overlap math — the one owner of the rule "these two directories hold
 *  the same notes". Both the doctor (root overlap verdicts) and discovery
 *  (candidate `copyOf`) compare roots by a sample of `<relative path, size>`
 *  pairs, because hashing whole trees is too slow for a status call and path
 *  containment alone says nothing about cloud copies of the same vault.
 *
 *  A pair of directories is a copy when they share at least COPY_FRACTION of
 *  the smaller sample and the smaller directory has strictly fewer notes —
 *  the smaller side is the duplicate, the bigger side stays canonical until
 *  the user decides otherwise. Identical paths are never compared (the config
 *  already rejects one directory owned twice). */

export interface NotePair {
  rel: string;
  size: number;
}

export const COPY_SAMPLE_LIMIT = 200;
export const COPY_FRACTION = 0.6;

function keyOf(pair: NotePair): string {
  return `${pair.rel}\u0000${pair.size}`;
}

/** Shared-pair count of two samples; a directory's sample is its first
 *  COPY_SAMPLE_LIMIT note pairs. */
export function sharedPairs(a: NotePair[], b: NotePair[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const keys = new Set(b.map(keyOf));
  let shared = 0;
  for (const pair of a) {
    if (keys.has(keyOf(pair))) shared++;
  }
  return shared;
}

/** When `a` is a copy of `b`, returns the shared count; otherwise null.
 *  `notesA`/`notesB` are the full note counts (not sample sizes). */
export function copyOf(a: NotePair[], b: NotePair[], notesA: number, notesB: number): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const shared = sharedPairs(a, b);
  const smallerSample = Math.min(a.length, b.length);
  if (shared / smallerSample < COPY_FRACTION) return null;
  if (notesA >= notesB) return null;
  return shared;
}
