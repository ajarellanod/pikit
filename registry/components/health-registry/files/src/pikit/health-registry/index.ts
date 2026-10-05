/**
 * health-registry: what is up, degraded or down in this App (`health`, @pikit/contracts' health.ts).
 * Components report their own state through `useOptional("health")`; the dashboard reads
 * `snapshot()`, and server-bun's `GET /health` answers 503 when it is `down`, so the supervisor
 * restarts the process.
 *
 * - **The policy is here**, never in a reporter: a component degraded, or a non-essential one down,
 *   makes the App `degraded`; an essential one (`essential` in config) down for `graceMs` makes it
 *   `down`. Shorter outages count as `degraded`, so a blip restarts nothing.
 * - **In memory**, on purpose: health is this process's, and a restart starts it over (every
 *   component reports again). Time is the App's clock.
 * - **Reports never throw or wait**; a reason is cut at `MAX_REASON` characters.
 *
 * Targets: `server` and `durable`: plain code. On Cloudflare each object's App has its own.
 */

import { defineComponent } from "@pikit/core";
import type { ComponentHealth, HealthRegistry, HealthReporter, HealthStatus } from "@pikit/contracts";
import Type from "typebox";

/** A reason longer than this is cut: it is a line for an operator, not a log. */
export const MAX_REASON = 200;

const Config = Type.Object({
  /** Component names (as they report, `channel-telegram`, `channel-telegram:ops`) whose `down` can make the App `down`. */
  essential: Type.Array(Type.String({ minLength: 1 }), { default: [], uniqueItems: true }),
  /** How long an essential component is down before the App is: shorter outages are only `degraded`. */
  graceMs: Type.Integer({ minimum: 0, default: 30_000 }),
});

/** One component's last report. */
type Entry = { status: HealthStatus; reason: string | undefined; since: number };

export default defineComponent({
  name: "health-registry",
  config: Config,
  setup(pikit, config) {
    const essential = new Set(config.essential);
    const entries = new Map<string, Entry>();
    const clock = pikit.clock;

    const report = (name: string, status: HealthStatus, reason?: string) => {
      const previous = entries.get(name);
      const since = previous?.status === status ? previous.since : clock.now();
      entries.set(name, { status, reason: reason?.slice(0, MAX_REASON), since });
    };

    const registry: HealthRegistry = {
      reporter(name): HealthReporter {
        return {
          up: () => report(name, "up"),
          degraded: (reason) => report(name, "degraded", reason),
          down: (reason) => report(name, "down", reason),
        };
      },

      snapshot() {
        const now = clock.now();
        let status: HealthStatus = "up";
        const components: ComponentHealth[] = [];
        for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
          const isEssential = essential.has(name);
          components.push({ name, status: entry.status, ...(entry.reason !== undefined && { reason: entry.reason }), since: entry.since, essential: isEssential });
          if (entry.status === "up") continue;
          if (entry.status === "down" && isEssential && now - entry.since >= config.graceMs) status = "down";
          else if (status === "up") status = "degraded";
        }
        return { status, components };
      },
    };
    pikit.provide("health", registry);
  },
});
