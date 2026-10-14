/**
 * The users' message rate (`messagesPerMinute`): a sliding minute per user, in memory. Where it counts
 * is where every message of a user passes: on a server the App (`index.ts`), on Cloudflare the accounts
 * actor, which the Worker asks before each message (`channel-web.rate`, `calls.ts`). A restart or an
 * eviction forgets it: a bound on abuse, not an account of it.
 */

const MINUTE = 60_000;
/** Users kept before the idle ones are dropped. */
const KEPT = 10_000;

export interface RateLimiter {
  /** One message of `key` at `now` (epoch ms): `undefined` when it may go, else the seconds until one may. */
  take(key: string, now: number): number | undefined;
}

export function createRateLimiter(perMinute: number): RateLimiter {
  const taken = new Map<string, number[]>();
  return {
    take(key, now) {
      const since = now - MINUTE;
      const times = (taken.get(key) ?? []).filter((at) => at > since);
      if (times.length >= perMinute) {
        taken.set(key, times);
        return Math.max(1, Math.ceil(((times[0] as number) + MINUTE - now) / 1000));
      }
      times.push(now);
      // Kept in the order of their last message: past `KEPT` users, the longest idle go first.
      taken.delete(key);
      taken.set(key, times);
      for (const each of taken.keys()) {
        if (taken.size <= KEPT) break;
        taken.delete(each);
      }
      return undefined;
    },
  };
}
