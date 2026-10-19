/**
 * admin-approvals over approvals-sql: an operator lists and decides, held to the approvers like anyone,
 * and the conversation that asked is told once. The runtime is a recorder of `dispatch`.
 *
 * A repository test (it imports another component's files, SPEC P4).
 */

import { afterEach, expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AdminAuth, AgentRequest, AgentRuntime, HttpRoute } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import approvalsSql from "../approvals-sql/files/src/pikit/approvals-sql/index.ts";
import type { ApprovalRequest, ApprovalStore } from "./files/src/pikit/admin-approvals/contract.ts";
import adminApprovals from "./files/src/pikit/admin-approvals/index.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const AUTH = { authorization: "Bearer operator" };

async function start() {
  const dispatched: AgentRequest[] = [];
  let reached: { routes: { get(key: string): HttpRoute | undefined }; store: ApprovalStore } | undefined;
  const fakes = defineComponent({
    name: "fakes-test",
    setup(pikit) {
      const auth: AdminAuth = { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) };
      pikit.provide("admin.auth", auth);
      pikit.provide("agent.runtime", { dispatch: async (request: AgentRequest) => {
        const duplicate = dispatched.some((d) => d.requestId === request.requestId);
        dispatched.push(request);
        return { kind: duplicate ? "duplicate" : "started", requestId: request.requestId };
      } } as unknown as AgentRuntime);
    },
  });
  const server = defineComponent({
    name: "server-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      const approvals = pikit.use("approvals");
      return { start: () => void (reached = { routes, store: approvals.get() }) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), approvalsSql, fakes, adminApprovals, server], logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  if (reached === undefined) throw new Error("not started");
  const { routes, store } = reached;
  const call = async (method: string, path: string, body?: unknown) => {
    const key = method === "GET" ? "GET /admin/api/approvals" : "POST /admin/api/approvals/:id/decision";
    const response = await routes.get(key)?.(new Request(`http://pikit.test${path}`, { method, headers: AUTH, ...(body !== undefined && { body: JSON.stringify(body) }) }), app.context());
    if (response === undefined) throw new Error(`no route ${key}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const propose = (key: string, approvers: string[]) => {
    const request: ApprovalRequest = {
      idempotencyKey: key,
      action: { type: "tool:bash", payload: { command: "ls" } },
      title: "List",
      approvers,
      requestedBy: { conversation: { key: "telegram:1", agent: "assistant", conversationId: "c1" } },
    };
    return store.propose(request, app.context());
  };
  return { call, propose, dispatched, store, ctx: () => app.context() };
}

test("an operator approves as dashboard:<id>; the asking conversation is told once, however often they click", async () => {
  const s = await start();
  const { id } = await s.propose("k1", ["dashboard:*"]);

  expect((await s.call("GET", "/admin/api/approvals?status=pending")).body.items).toMatchObject([{ id, status: "pending" }]);
  const first = await s.call("POST", `/admin/api/approvals/${id}/decision`, { verdict: "approve" });
  const again = await s.call("POST", `/admin/api/approvals/${id}/decision`, { verdict: "approve" });

  expect([first.status, again.status]).toEqual([200, 200]);
  expect(first.body.approval).toMatchObject({ id, status: "approved", decidedBy: { channel: "dashboard", id: "ops" } });
  expect(s.dispatched.map((d) => [d.requestId, d.conversation.conversationId, d.sender])).toEqual([
    [`approval-decided:${id}`, "c1", { channel: "dashboard", id: "ops" }],
    [`approval-decided:${id}`, "c1", { channel: "dashboard", id: "ops" }],
  ]);
  expect(s.dispatched[0]?.prompt).toBe(`[approvals] Approval ${id} ("List") was approved by dashboard:ops.`);
  expect((await s.call("POST", `/admin/api/approvals/${id}/decision`, { verdict: "reject" })).status).toBe(409);
});

test("an operator the approvers do not name is forbidden; nothing is recorded or told", async () => {
  const s = await start();
  const { id } = await s.propose("k1", ["telegram:1"]);

  const refused = await s.call("POST", `/admin/api/approvals/${id}/decision`, { verdict: "approve" });

  expect([refused.status, refused.body.error]).toEqual([403, "forbidden"]);
  expect(s.dispatched).toEqual([]);
  expect((await s.store.list({ status: "pending" }, s.ctx())).items.map((a) => a.id)).toEqual([id]);
});

test("a decision taken in the chat is not told again from the dashboard", async () => {
  const s = await start();
  const { id } = await s.propose("k1", ["telegram:1", "dashboard:*"]);
  await s.store.decide(id, { verdict: "approve", by: { channel: "telegram", id: "1" } }, s.ctx());

  expect((await s.call("POST", `/admin/api/approvals/${id}/decision`, { verdict: "approve" })).status).toBe(200);
  expect(s.dispatched).toEqual([]);
});

test("bad requests: an unknown approval, a verdict that is neither, a bad status", async () => {
  const s = await start();

  expect((await s.call("POST", "/admin/api/approvals/nope/decision", { verdict: "approve" })).status).toBe(404);
  expect((await s.call("POST", "/admin/api/approvals/nope/decision", { verdict: "maybe" })).status).toBe(400);
  expect((await s.call("GET", "/admin/api/approvals?status=lost")).status).toBe(400);
});
