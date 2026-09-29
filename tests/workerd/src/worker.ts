/**
 * The Worker of the workerd lane: one SQLite-backed Durable Object class, empty. The suites run inside
 * its instances (`runInDurableObject`) and give its storage to the components under test, as
 * `deployment-cloudflare`'s entrypoint will (`test/host.ts`).
 */

import { DurableObject } from "cloudflare:workers";

export class TestObject extends DurableObject {}

export default {
  fetch: () => new Response("pikit workerd lane: the tests run through Vitest, not through requests"),
} satisfies ExportedHandler;
