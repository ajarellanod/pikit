/**
 * A clock that moves only when a test says so: `now()` is fixed until `advance(ms)`, and a
 * `sleep(ms)` resolves when the clock passes its end. For components that wait (retries, schedules)
 * and must be tested without waiting.
 */

import type { Clock } from "../contracts/clock.ts";

export interface ManualClock extends Clock {
  /** Moves time forward by `ms`, resolving every sleep that ends by then, then lets their work run. */
  advance(ms: number): Promise<void>;
}

export function createManualClock(start = 1_700_000_000_000): ManualClock {
  let now = start;
  let sleepers: { until: number; wake: () => void }[] = [];
  return {
    now: () => now,
    sleep(ms) {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((wake) => sleepers.push({ until: now + ms, wake }));
    },
    async advance(ms) {
      now += ms;
      const due = sleepers.filter((s) => s.until <= now);
      sleepers = sleepers.filter((s) => s.until > now);
      for (const sleeper of due) sleeper.wake();
      // Let what the sleepers resumed run (promise chains, a timer or two) before the test looks.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}
