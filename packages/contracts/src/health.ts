/**
 * `health`: what is up, degraded or down in a running App, as its components report it. A component
 * that breaks after `start` (a stuck poller, a dead connection) says so; the dashboard shows it
 * (SPEC §5), and the server's `GET /health` fails when what broke is essential, so that the
 * supervisor restarts the process. Health is not in the kernel (SPEC §3.2): a component reports
 * through `useOptional("health")`, so without a provider nothing changes.
 *
 *   const health = pikit.useOptional("health");
 *   // in start:
 *   const reporter = health.get()?.reporter("channel-telegram");
 *   reporter?.degraded("getUpdates failed: 409");
 *
 * What every provider guarantees:
 * - **A component's state is its last report.** `up()`, `degraded(reason)`, `down(reason)` replace
 *   it; `since` is when it last changed status (a new reason in the same status keeps `since`). A
 *   component that never reported is not listed: absence is not failure.
 * - **The overall status follows one policy**, the provider's to apply and never a reporter's:
 *   - every listed component `up` (or none listed): `up`;
 *   - a component `degraded`, or a non-essential one `down`: at least `degraded`;
 *   - an essential component `down` for at least the grace period: `down`. Down for less than the
 *     grace, it counts as `degraded`, so a blip does not restart the process (no flapping).
 *   Which components are essential, and the grace, are the provider's (per deployment: config).
 * - **The snapshot is the truth.** It is read, never pushed: a reader polls it.
 * - **Reporting never throws** and never waits: a component reports from its hot path.
 *
 * What a reporter promises: a reason is short operator text (`getUpdates failed 5 times: 401`),
 * never a secret, a token, a URL holding one, or a person's message text. The snapshot is shown to
 * operators and may be logged.
 *
 * A component name is the reporting component's name (`channel-telegram`), or `<name>:<part>` for
 * one part of it that fails on its own (`channel-telegram:ops`, a second bot). Names are matched
 * exactly: an essential part is listed as such.
 */

/** A component's state, and the App's. */
export type HealthStatus = "up" | "degraded" | "down";

/** How one component reports its own state. Every call replaces the previous one. */
export interface HealthReporter {
  up(): void;
  /** It works, worse: retrying, slower, a part of it failing. */
  degraded(reason: string): void;
  /** It does not work. */
  down(reason: string): void;
}

/** One component in a snapshot. JSON. */
export type ComponentHealth = {
  name: string;
  status: HealthStatus;
  /** Why, for `degraded` and `down`. */
  reason?: string;
  /** When it entered `status`, in epoch ms on the App's clock. */
  since: number;
  /** Whether its `down` can make the App `down`. */
  essential: boolean;
};

/** The App's health now. JSON. */
export type HealthSnapshot = {
  status: HealthStatus;
  /** Every component that reported, sorted by name. */
  components: ComponentHealth[];
};

export interface HealthRegistry {
  /** The reporter of `component`: its name, or `<name>:<part>`. */
  reporter(component: string): HealthReporter;
  snapshot(): HealthSnapshot;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    health: HealthRegistry;
  }
}
