/**
 * The sample's composition root, checked as `pikit doctor` will: create the app (every setup, the
 * derived graph, the config) without starting it. No port, no model call, no credential read.
 */

import { expect, test } from "bun:test";
import definition from "../pikit.config.ts";

test("pikit.config.ts composes: every capability a component requires has a provider", async () => {
  const app = await definition.create();
  const described = app.describe();

  const provided = new Set(described.components.flatMap((component) => component.provides));
  const missing = described.components.flatMap((component) => component.requires.filter((name) => !provided.has(name)));
  expect(missing).toEqual([]);
  expect(described.capabilities["http.route"]?.keys).toEqual({
    "POST /v1/messages": "channel-http",
    "POST /v1/conversations/:id/reset": "channel-http",
  });
  expect(described.capabilities["model.provider"]?.keys).toEqual({ anthropic: "provider-anthropic" });
  expect(described.capabilities["agent.definition"]?.keys).toEqual({ assistant: "agents" });
  expect(described.pipelines["inbound.authenticate"]).toEqual([{ id: "channel-http-bearer", priority: 100 }]);
  expect(described.pipelines["route.resolve"]).toEqual([{ id: "router-basic", priority: 0 }]);
  // The server starts last: it serves routes only once everything they use is up.
  expect(described.components.at(-1)?.name).toBe("server-bun");
});
