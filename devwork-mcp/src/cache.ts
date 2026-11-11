/**
 * Read cache shared by every call of one installation. Keys start with the
 * installation id, so two repositories in the same process can never read each
 * other's cached work items.
 */
interface CacheEntry {
  ts: number;
  value: unknown;
}

const store = new Map<string, CacheEntry>();

function key(installationId: string, name: string): string {
  return `${installationId}\u0000${name}`;
}

export function cacheGet<T>(installationId: string, name: string, ttlSeconds: number): T | undefined {
  if (ttlSeconds <= 0) return undefined;
  const entry = store.get(key(installationId, name));
  if (!entry) return undefined;
  if (Date.now() - entry.ts > ttlSeconds * 1000) {
    store.delete(key(installationId, name));
    return undefined;
  }
  return entry.value as T;
}

export function cachePut(installationId: string, name: string, value: unknown): void {
  store.set(key(installationId, name), { ts: Date.now(), value });
}

export function invalidate(installationId: string, ref: string): void {
  // Keys are `<installation>\u0000<kind>:<scope>:<id>`; match the id suffix only,
  // so "1" never invalidates "11".
  const suffix = `:${ref}`;
  for (const existing of store.keys()) {
    if (existing.startsWith(`${installationId}\u0000`) && existing.endsWith(suffix)) store.delete(existing);
  }
}

export function clearCache(): void {
  store.clear();
}
