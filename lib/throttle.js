// Counts failures per key (an email, a network address) in a fixed time window, in memory.
// Enough for one laptop: it resets when the server restarts, and nothing is stored.

export function createThrottle({ limit, windowMs }) {
  const failures = new Map(); // key -> { count, resetAt }
  const current = (key) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= Date.now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    /** True once `key` has failed `limit` times in the current window. */
    isBlocked: (key) => (current(key)?.count ?? 0) >= limit,
    recordFailure(key) {
      const entry = current(key) ?? { count: 0, resetAt: Date.now() + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    clear: (key) => failures.delete(key),
  };
}
