/**
 * For the tests of Cloudflare components: `WORKERS_HOST` in their start and stop context, as
 * `deployment-cloudflare`'s entrypoint puts it (`app.start(withContextValue(WORKERS_HOST, host, …))`).
 *
 * The conformance suites start their own apps with no parent context, so a component under test gets
 * the host by being wrapped instead:
 *
 *   for (const c of createSqlDatabaseConformance(() => ({ components: withWorkersHost(host, [storageDo]) })))
 *
 * A wrapped component keeps its name and its setup: `describe()` sees the same component.
 */

import { type AppContext, type ComponentDefinition, type ComponentLifecycle, withContextValue } from "@pikit/core";
import { WORKERS_HOST, type WorkersHost } from "../workers-host.ts";

/** `components`, each receiving `host` as `WORKERS_HOST` in the context of its `start` and `stop`. */
export function withWorkersHost(host: WorkersHost, components: readonly ComponentDefinition[]): ComponentDefinition[] {
  const hosted = (ctx: AppContext): AppContext => ctx.derive((context) => withContextValue(WORKERS_HOST, host, context));
  return components.map((component) => ({
    ...component,
    setup(pikit, config) {
      const lifecycle = component.setup(pikit, config);
      if (!lifecycle) return;
      const { start, stop } = lifecycle;
      const wrapped: ComponentLifecycle = {};
      if (start !== undefined) wrapped.start = (ctx) => start.call(lifecycle, hosted(ctx));
      if (stop !== undefined) wrapped.stop = (ctx) => stop.call(lifecycle, hosted(ctx));
      return wrapped;
    },
  }));
}
