/** Time source (the kernel's clock, SPEC §3). Injectable for tests and for Durable Object alarms. */
export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
