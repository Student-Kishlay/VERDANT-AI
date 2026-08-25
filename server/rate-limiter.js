// Tiny in-memory sliding-window rate limiter. State is deliberately
// ephemeral (resets on server restart) — a mock backend's rate limits don't
// need to survive a redeploy any more than a real one's hot-path counters
// would in, say, Redis with no persistence configured.
export function createRateLimiter() {
  const hits = new Map(); // key -> timestamps[]

  return {
    // Returns true if the call is allowed (and records it); false if the
    // caller is over `limit` within the trailing `windowMs`.
    checkAndRecord(key, limit, windowMs) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

      if (timestamps.length >= limit) {
        hits.set(key, timestamps);
        return false;
      }

      timestamps.push(now);
      hits.set(key, timestamps);
      return true;
    },
  };
}
