/**
 * `wakeups` and `wakeup` (SPEC §4.1, C3 and C4): timers that wake a component, even where nothing
 * runs between events. The runtime driving a run, an outbox retrying a delivery, a reminder: each
 * asks for one of its handlers to run at or after a time, and the provider runs it then.
 *
 * - **Handlers are named.** A component provides each under the keyed capability `wakeup`, named
 *   after itself (`pikit.provideKeyed("wakeup", "outbound-durable", handler)`), and asks for it by
 *   that name.
 * - **One request per name.** `at` replaces the name's request, sooner or later; `cancel` drops it.
 * - **A request carries nothing but a time.** What to do is in the component's own durable state: a
 *   run reads it and does what is due. That is what makes the rules below safe.
 *
 * How a request is delivered:
 * - **Never early, maybe late.** A handler runs at or after `time`, on the app's clock (`ctx.clock`),
 *   never before. It may run late: a busy process, a machine that slept, a platform's alarm delay.
 * - **At least once.** A request is done only when its handler resolves. A run cut short (a crash, a
 *   deploy, an alarm the platform cut) runs again, so a handler may run twice for one request and
 *   must be idempotent.
 * - **One run per name at a time**, in one App: a request that comes due while its handler runs
 *   waits for that run to end. Handlers of different names may run at the same time.
 * - **A request made during a run stands after it.** A handler continues by calling `at` for its own
 *   name (`at(name, ctx.clock.now(), ctx)` to run again at once) and resolving.
 * - **A handler that rejects runs again**, after a wait that grows with its consecutive failures up
 *   to a cap, and never gives up: the provider declares its waits, and logs each failure. If a
 *   request for its name was made during the failed run, the earlier of the two stands; if the name
 *   was cancelled during it, the retry is dropped too.
 *
 * Slices (C4). A handler's `ctx` is its own, never the context of whoever called `at`: it carries
 * the App's values, and its cancellation fires when the App stops or when the provider's slice
 * deadline passes (on Cloudflare, so that every alarm stays far from its budgets). A handler honours
 * it: it stops at a consistent point, calls `at` again if work remains, and resolves. Long work is a
 * sequence of short runs; rejecting instead counts as a failure and waits.
 *
 * Whether a request survives a restart is the provider's: `wakeups-timers` keeps none, the
 * Cloudflare provider keeps them in the object's SQL. So, per K6, a component asks again at start for
 * what its durable state still needs; replacing a request that survived is harmless.
 *
 * Requests belong to one App. On Cloudflare each object's App has its own, kept as rows multiplexed
 * over the object's single alarm (the earliest time sets it), and a cut alarm is retried by the
 * platform, which is the "runs again" above.
 *
 * Open question: a component cannot both provide a `wakeup` handler and `use("wakeups")`, because
 * the provider depends on every handler it calls and the kernel sees a dependency cycle. Today the
 * two halves are two components of one module, the handler reaching the `Wakeups` its sibling holds
 * (the conformance suite does exactly that); a registry component cannot ship two yet. Lifting it is
 * a kernel or registry decision.
 */

import type { AppContext } from "@pikit/core";

export interface Wakeups {
  /**
   * Asks for the `wakeup` handler `name` to run at or after `time` (epoch milliseconds on the app's
   * clock), replacing the name's earlier request if there is one. A time already past runs as soon as
   * possible. Resolves once the request is recorded (durably, for a provider that persists them);
   * it does not wait for the run. Call it from `start` or later.
   *
   * Rejects, recording nothing, when no `wakeup` handler is provided under `name` (the error names
   * it) or `time` is not a finite number. `ctx` bounds this call only.
   */
  at(name: string, time: number, ctx: AppContext): Promise<void>;
  /**
   * Drops the request for `name`, if there is one: its handler will not run for it. A run already in
   * progress is not interrupted, but it will not be retried if it fails. Cancelling a name with no
   * request changes nothing.
   */
  cancel(name: string, ctx: AppContext): Promise<void>;
}

/**
 * Runs when a request for its name comes due. Resolve when done, or after calling `at` again for
 * what remains; reject to be run again after the provider's backoff. `ctx` is the handler's own:
 * cancelled at the provider's slice deadline or when the App stops.
 */
export type WakeupHandler = (ctx: AppContext) => Promise<void>;

declare module "@pikit/core" {
  interface AppCapabilities {
    wakeups: Wakeups;
  }
  interface AppKeyedCapabilities {
    /** Keyed by the name `wakeups.at` asks for, named after the component providing it. */
    wakeup: WakeupHandler;
  }
}
