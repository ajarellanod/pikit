/**
 * The inbound pipelines are typed on `AppPipelines` (SPEC §5): a channel and a router meet on
 * them without importing each other.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent } from "./app.ts";
import { silentLogger } from "./contracts/logger.ts";
import type { InboundMessage } from "./inbound.ts";

const message: InboundMessage = {
  id: "m1",
  channel: "test",
  conversationId: "c1",
  actor: { id: "someone" },
  text: "hello",
  raw: { text: "hello" },
  receivedAt: 0,
};

test("a router fills in route.resolve's decision; a channel reads it", async () => {
  const router = defineComponent({
    name: "router-test",
    setup(pikit) {
      pikit.pipeline("route.resolve", (value) =>
        value.decision !== undefined ? value : { ...value, decision: { agent: "support", access: "allow" } },
      );
    },
  });
  const app = await defineApp({ components: [router], logger: silentLogger }).create();

  const resolved = await app.context().run("route.resolve", { message });

  expect(resolved).toEqual({ message, decision: { agent: "support", access: "allow" } });
});

test("no stage in inbound.authenticate leaves no verdict: the request is not authenticated", async () => {
  const app = await defineApp({ components: [], logger: silentLogger }).create();

  const checked = await app.context().run("inbound.authenticate", { channel: "test", request: new Request("http://localhost/") });

  expect("verdict" in checked && checked.verdict).toBeFalsy();
});
