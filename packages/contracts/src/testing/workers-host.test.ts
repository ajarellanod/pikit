/**
 * `WORKERS_HOST` reaches a component's start context both ways a component sees it: from the parent
 * context `deployment-cloudflare`'s entrypoint passes to `app.start`, and from `withWorkersHost`,
 * which the tests of Cloudflare components use because the suites start their own apps.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { WORKERS_HOST, type WorkersHost } from "../cloudflare.ts";
import { withWorkersHost } from "./workers-host.ts";

const host: WorkersHost = { env: { TOKEN: "t" } };

/** A component that writes down the host each of its hooks saw. */
function reader(seen: { start?: WorkersHost | undefined; stop?: WorkersHost | undefined }) {
  return defineComponent({
    name: "host-reader",
    setup: () => ({
      start: (ctx) => void (seen.start = ctx.value(WORKERS_HOST)),
      stop: (ctx) => void (seen.stop = ctx.value(WORKERS_HOST)),
    }),
  });
}

test("the entrypoint's way: the host in app.start's parent context reaches every start", async () => {
  const seen: { start?: WorkersHost | undefined } = {};
  const app = await defineApp({ components: [reader(seen)], logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, host, BACKGROUND_CONTEXT));
  await app.stop();
  expect(seen.start).toBe(host);
});

test("withWorkersHost puts the host in start and stop, and keeps the component's name and declarations", async () => {
  const seen: { start?: WorkersHost | undefined; stop?: WorkersHost | undefined } = {};
  const provider = defineComponent({ name: "host-provider", setup: (pikit) => void pikit.provide("secrets", { get: async () => undefined }) });
  const app = await defineApp({ components: withWorkersHost(host, [provider, reader(seen)]), logger: silentLogger }).create();
  await app.start();
  await app.stop();
  expect(seen).toEqual({ start: host, stop: host });
  expect(app.describe().components.map((c) => [c.name, c.provides])).toEqual([
    ["host-provider", ["secrets"]],
    ["host-reader", []],
  ]);
});

test("without either, a component sees no host", async () => {
  const seen: { start?: WorkersHost | undefined } = { start: host };
  const app = await defineApp({ components: [reader(seen)], logger: silentLogger }).create();
  await app.start();
  await app.stop();
  expect(seen.start).toBeUndefined();
});
