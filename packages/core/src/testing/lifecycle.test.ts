import { expect, test } from "bun:test";
import type { HarnessContext } from "../harness.ts";
import { defineComponent } from "../harness.ts";
import { createLifecycleConformance, type LifecycleFixture } from "./index.ts";

/** Resolves after `ms`, or rejects as soon as `signal` aborts when `cooperative`. */
function wait(ms: number, ctx: HarnessContext, cooperative: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!cooperative) return;
    ctx.abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(ctx.abortSignal?.reason);
    });
  });
}

/** A component that opens one "socket" in start (after 30 ms) and closes it in stop (after 30 ms). */
function socketFixture(behaviour: { start: "cooperative" | "ignores-abort" | "hangs"; stop?: "cooperative" | "hangs" }) {
  return (): LifecycleFixture => {
    let open = 0;
    const component = defineComponent({
      name: "socket",
      setup: () => ({
        async start(ctx) {
          if (behaviour.start === "hangs" && ctx.abortSignal) {
            // Reacts to nothing: never settles once it is waiting.
            await wait(30, ctx, false);
            await new Promise<void>(() => {});
          }
          await wait(30, ctx, behaviour.start === "cooperative");
          open++;
        },
        async stop(ctx) {
          if (behaviour.stop === "hangs" && ctx.abortSignal) await new Promise<void>(() => {});
          // Cooperative: on abort, close at once instead of draining.
          await wait(30, ctx, true).catch(() => {});
          open = 0;
        },
      }),
    });
    return { component, openResources: () => open };
  };
}

const run = (fixture: () => LifecycleFixture) =>
  Object.fromEntries(createLifecycleConformance(fixture, { settleMs: 200 }).map((c) => [c.name, () => c.run()]));

test("a cooperative component passes every lifecycle case", async () => {
  const cases = createLifecycleConformance(socketFixture({ start: "cooperative" }), { settleMs: 200 });
  expect(cases.map((c) => `${c.group}: ${c.name}`)).toEqual([
    "lifecycle: starts and stops, leaving nothing open",
    "lifecycle: an aborted start settles promptly and leaves nothing open",
    "lifecycle: an aborted stop settles promptly and leaves nothing open",
  ]);
  for (const c of cases) await c.run();
});

test("a start that ignores the abort and opens a resource afterwards is caught", async () => {
  const cases = run(socketFixture({ start: "ignores-abort" }));
  await cases["starts and stops, leaving nothing open"]?.();
  await expect(cases["an aborted start settles promptly and leaves nothing open"]?.()).rejects.toThrow(
    'component "socket": 1 resource(s) still open after an aborted start',
  );
});

test("a start that never settles after the abort is caught", async () => {
  const cases = run(socketFixture({ start: "hangs" }));
  await expect(cases["an aborted start settles promptly and leaves nothing open"]?.()).rejects.toThrow(
    'component "socket": start was still running 200 ms after its abort',
  );
});

test("a stop that never settles after the abort is caught", async () => {
  const cases = run(socketFixture({ start: "cooperative", stop: "hangs" }));
  await expect(cases["an aborted stop settles promptly and leaves nothing open"]?.()).rejects.toThrow(
    'component "socket": stop was still running 200 ms after its abort',
  );
});
