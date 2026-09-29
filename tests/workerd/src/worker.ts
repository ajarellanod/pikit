/**
 * The Worker of the workerd lane. `TestObject`, an empty SQLite-backed Durable Object class: the storage
 * suites run inside its instances (`runInDurableObject`) and give its storage to the components under
 * test, as `deployment-cloudflare`'s entrypoint does (`test/host.ts`). `Conversation`: that entrypoint's
 * own class, over the small Apps of `src/deployment.ts`.
 */

import { DurableObject } from "cloudflare:workers";
import { entrypoint } from "./deployment.ts";

export class TestObject extends DurableObject {}

export const Conversation = entrypoint.Conversation;

export default {
  fetch: () => new Response("pikit workerd lane: the tests run through Vitest, not through requests"),
} satisfies ExportedHandler;
