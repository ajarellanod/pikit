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
 * - **Backoff across restarts.** A restart fixes what is broken in the process, not an outage outside
 *   it (Telegram down for an hour): the same component is down again after the restart, and the App
 *   would restart every minute. So each `down` verdict is counted in `storage.kv` (when installed;
 *   namespace `health-registry`, key `down-verdicts`), and a process starts with the grace doubled for
 *   each one before it (`graceMs` · 2ⁿ), up to `maxGraceMs`. Once no essential component has been down
 *   for `stableMs`, the count goes back to 0. Without `storage.kv` the grace is always `graceMs`. Mark
 *   essential only what a restart can fix: a component an outside service takes down still restarts the
 *   App, only less often.
 * - **Reports never throw or wait**; a reason is cut at `MAX_REASON` characters.
 *
 * - **Its view** (`view/`, the reference component with a view): `GET /admin/api/health-registry`
 *   answers the snapshot and the policy to an operator (`admin.auth`; without a provider, nobody).
 *
 * Targets: `server` and `durable`: plain code. On Cloudflare each object's App has its own.
 */

import { defineComponent } from "@pikit/core";
import type { ComponentHealth, HealthRegistry, HealthReporter, HealthStatus, KeyValueStore } from "@pikit/contracts";
import Type from "typebox";

/** A reason longer than this is cut: it is a line for an operator, not a log. */
export const MAX_REASON = 200;

const Config = Type.Object({
  /** Component names (as they report, `channel-telegram`, `channel-telegram:ops`) whose `down` can make the App `down`. */
  essential: Type.Array(Type.String({ minLength: 1 }), { default: [], uniqueItems: true }),
  /** How long an essential component is down before the App is: shorter outages are only `degraded`. */
  graceMs: Type.Integer({ minimum: 0, default: 30_000 }),
  /** The longest grace the backoff grows to, after `down` verdicts in a row that restarts did not fix. */
  maxGraceMs: Type.Integer({ minimum: 0, default: 600_000 }),
  /** How long no essential component is down before the backoff starts over. */
  stableMs: Type.Integer({ minimum: 0, default: 900_000 }),
});

/** Where the `down` verdicts in a row are counted, in `storage.kv`'s namespace `health-registry`. */
export const VERDICTS_KEY = "down-verdicts";

/** The grace of a process that starts after `verdicts` `down` verdicts in a row. */
export function graceAfter(verdicts: number, graceMs: number, maxGraceMs: number): number {
  return Math.min(graceMs * 2 ** Math.min(verdicts, 30), Math.max(graceMs, maxGraceMs));
}

/** One component's last report. */
type Entry = { status: HealthStatus; reason: string | undefined; since: number };

export default defineComponent({
  name: "health-registry",
  config: Config,
  setup(pikit, config) {
    const essential = new Set(config.essential);
    const entries = new Map<string, Entry>();
    const clock = pikit.clock;
    const kv = pikit.useOptional("storage.kv");

    /** `down` verdicts in a row before this process, read at start; the grace this process keeps. */
    let verdicts = 0;
    let grace = config.graceMs;
    /** Whether this process gave a `down` verdict (counted once); since when no essential component is down. */
    let struck = false;
    let calmSince = clock.now();
    let store: KeyValueStore | undefined;
    /** Writes in order, never thrown: health never fails its reporters. */
    let writing: Promise<void> = Promise.resolve();
    const save = (count: number): void => {
      const target = store;
      if (target === undefined) return;
      writing = writing
        .then(() => target.set(VERDICTS_KEY, count))
        .catch((error: unknown) => pikit.logger.warn("health-registry: the count of down verdicts was not saved", { error: error instanceof Error ? error.message : String(error) }));
    };

    /** The App's status now, and the backoff's bookkeeping: a `down` verdict counted, a calm period that resets it. */
    const judge = (): HealthStatus => {
      const now = clock.now();
      let status: HealthStatus = "up";
      let essentialDown = false;
      for (const [name, entry] of entries) {
        if (entry.status === "up") continue;
        const isEssential = essential.has(name);
        if (entry.status === "down" && isEssential) essentialDown = true;
        if (entry.status === "down" && isEssential && now - entry.since >= grace) status = "down";
        else if (status === "up") status = "degraded";
      }
      if (status === "down" && !struck) {
        struck = true;
        save(verdicts + 1);
      }
      if (essentialDown) calmSince = now;
      else if ((verdicts > 0 || struck) && now - calmSince >= config.stableMs) {
        verdicts = 0;
        struck = false;
        save(0);
      }
      return status;
    };

    const report = (name: string, status: HealthStatus, reason?: string) => {
      const previous = entries.get(name);
      const since = previous?.status === status ? previous.since : clock.now();
      entries.set(name, { status, reason: reason?.slice(0, MAX_REASON), since });
      judge();
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
        const components: ComponentHealth[] = [...entries]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, entry]) => ({ name, status: entry.status, ...(entry.reason !== undefined && { reason: entry.reason }), since: entry.since, essential: essential.has(name) }));
        return { status: judge(), components };
      },
    };
    pikit.provide("health", registry);

    // Its view (`view/`, SPEC §5) reads this: the snapshot and the policy, an operator's only.
    const auth = pikit.useOptional("admin.auth");
    pikit.provideKeyed("http.route", "GET /admin/api/health-registry", async (request, ctx) => {
      const verifier = auth.get();
      if (verifier === undefined || (await verifier.verify(request, ctx)) === undefined) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="pikit"', "cache-control": "no-store" } });
      }
      const view: HealthView = { ...registry.snapshot(), essential: [...essential].sort(), graceMs: grace, downVerdicts: verdicts, now: clock.now() };
      return Response.json(view, { headers: { "cache-control": "no-store" } });
    });

    return {
      async start(ctx) {
        store = kv.get()?.namespace("health-registry");
        const saved = store === undefined ? undefined : await store.get<number>(VERDICTS_KEY);
        verdicts = typeof saved === "number" && Number.isInteger(saved) && saved > 0 ? saved : 0;
        grace = graceAfter(verdicts, config.graceMs, config.maxGraceMs);
        calmSince = clock.now();
        if (verdicts > 0) {
          ctx.logger.warn("health-registry: the App was found down before its last restarts; the grace is longer this time", { downVerdicts: verdicts, graceMs: grace });
        }
      },
      async stop() {
        await writing;
      },
    };
  },
});

/**
 * What `GET /admin/api/health-registry` answers: the snapshot, the policy it follows (`graceMs`: this
 * process's grace, grown by `downVerdicts`, the `down` verdicts in a row before it), and the time it
 * was taken.
 */
export type HealthView = { status: HealthStatus; components: ComponentHealth[]; essential: string[]; graceMs: number; downVerdicts: number; now: number };
