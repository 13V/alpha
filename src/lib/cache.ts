/**
 * Tiny TTL cache so repeat lookups of the same contract do not pay for a fresh
 * Dune execution every time. Process-local: on a serverless host each instance
 * keeps its own copy, which is fine — worst case is a duplicate execution.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const MAX_ENTRIES = 200;

export function cacheGet<T>(key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  if (store.size >= MAX_ENTRIES) {
    // drop the oldest insertion; Map preserves insertion order
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function cacheKey(parts: Array<string | number>): string {
  return parts.join("|");
}
