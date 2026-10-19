/**
 * admin-approvals' own tests, copied with it: what setup declares, and that nobody but an operator
 * reaches `approvals`. The routes over a real store are the repository's `app.test.ts`.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentRuntime, HttpRoute } from "@pikit/contracts";
import type { ApprovalStore } from "./contract.ts";
import adminApprovals from "./index.ts";

const asked: string[] = [];
const fakes = defineComponent({
  name: "fakes-test",
  setup(pikit) {
    pikit.provide("approvals", { list: async () => void asked.push("list") } as unknown as ApprovalStore);
    pikit.provide("agent.runtime", {} as AgentRuntime);
  },
});

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [fakes, adminApprovals], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "admin-approvals")).toMatchObject({
    provides: ["http.route"],
    requires: ["approvals", "agent.runtime"],
    optional: ["admin.auth"],
  });
});

test("without admin.auth nobody is an operator: 401, and approvals is not asked", async () => {
  let routes: { get(key: string): HttpRoute | undefined } | undefined;
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const handle = pikit.useKeyed("http.route");
      return { start: () => void (routes = handle) };
    },
  });
  const app = await defineApp({ components: [fakes, adminApprovals, server], logger: silentLogger }).create();
  await app.start();
  try {
    const response = await routes?.get("GET /admin/api/approvals")?.(new Request("http://pikit.test/admin/api/approvals"), app.context());
    expect(response?.status).toBe(401);
    expect(asked).toEqual([]);
  } finally {
    await app.stop();
  }
});
