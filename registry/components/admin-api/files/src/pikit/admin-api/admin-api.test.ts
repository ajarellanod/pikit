/**
 * admin-api's tests. They are copied with the component and keep running in your project.
 *
 * Every contract it uses is a double here; the routes are picked the way a server picks them
 * (`compareHttpRoutes`), so the most specific key serves each request.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { DeliveryReceipt, OutboundQueue, PendingPiece } from "@pikit/contracts";
import adminApi from "./index.ts";
import { AUTH, auth, Runtime, type Served, serve, sse, ZERO } from "./runtime.test-support.ts";

type Subject = Served & { runtime: Runtime };

const running: App[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop().catch(() => {});
});

async function started(config: Record<string, unknown> = {}, extra: ComponentDefinition[] = []): Promise<Subject> {
  const runtime = new Runtime();
  const served = await serve([auth, runtime.component(), adminApi, ...extra], { "admin-api": config });
  running.push(served.app);
  return { ...served, runtime };
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { ...AUTH, "content-type": "application/json" },
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const runtime = new Runtime();
  const app = await defineApp({ components: [auth, runtime.component(), adminApi], logger: silentLogger }).create();

  expect(app.describe().components.find((c) => c.name === "admin-api")).toEqual({
    name: "admin-api",
    provides: ["http.route"],
    requires: ["admin.auth", "agent.observe", "agent.runtime", "conversations.registry"],
    optional: ["outbound.queue", "actor.inbox", "actor.mailbox", "storage.sql"],
  });
});

test("every API route answers 401 without an operator, and reads nothing", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  const api = s.keys().filter((key) => key.includes("/admin/api"));
  expect(api.length).toBeGreaterThan(8);

  for (const key of api) {
    const [method = "GET", pattern = "/"] = key.split(" ");
    const path = pattern.replace(":id", "c1").replace("*", "anything");
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const response = await s.fetch(path, { method, headers, ...(method === "POST" && { body: JSON.stringify({ text: "hi" }) }) });
      expect({ key, status: response.status }).toEqual({ key, status: 401 });
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    }
  }
  expect(s.runtime.dispatched).toEqual([]);
  expect(s.runtime.aborted).toEqual([]);
  expect(s.runtime.pages).toEqual([]);
});

test("GET /admin/api/app: the composition the App describes, admin-api in it", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/app", { headers: AUTH });
  const body = (await response.json()) as { version: number; components: { name: string }[]; config: Record<string, unknown> };

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.version).toBe(1);
  expect(body.components.map((c) => c.name)).toContain("admin-api");
  expect(body.config["admin-api"]).toMatchObject({ heartbeatMs: 15_000 });
});

test("GET /admin/api/conversations: a page, each saying whether its key points to it now", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c0", key: "telegram:1", agent: "assistant" }, false);
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true, lastActivity: 5 });
  s.runtime.add({ conversationId: "c2" });

  const response = await s.fetch("/admin/api/conversations?limit=10", { headers: AUTH });
  const body = (await response.json()) as { items: Record<string, unknown>[]; next?: string };

  expect(response.status).toBe(200);
  expect(s.runtime.pages).toEqual([{ limit: 10 }]);
  expect(body.next).toBe("page-2");
  expect(body.items).toEqual([
    { conversationId: "c0", key: "telegram:1", agent: "assistant", busy: false, usage: ZERO, current: false },
    { conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true, lastActivity: 5, usage: ZERO, current: true },
    { conversationId: "c2", busy: false, usage: ZERO },
  ]);

  const last = await s.fetch(`/admin/api/conversations?cursor=${body.next}`, { headers: AUTH });
  expect(await last.json()).toEqual({ items: [] });
});

test("a page's limit and cursor are checked: 400, never a 500", async () => {
  const s = await started();

  for (const limit of ["0", "501", "-1", "1.5", "ten"]) {
    const response = await s.fetch(`/admin/api/conversations?limit=${limit}`, { headers: AUTH });
    expect({ limit, status: response.status }).toEqual({ limit, status: 400 });
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  }
  const forged = await s.fetch("/admin/api/conversations?cursor=forged", { headers: AUTH });
  expect(forged.status).toBe(400);
  expect(await forged.json()).toMatchObject({ error: "invalid_cursor" });
});

test("GET one conversation and its transcript; an unknown one is 404", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  s.runtime.transcripts.set("c1", [
    { id: "e2", kind: "message", messages: [{ role: "assistant", content: "hello" }] },
    { id: "e1", kind: "message", messages: [{ role: "user", content: "hi" }] },
  ]);

  const one = await s.fetch("/admin/api/conversations/c1", { headers: AUTH });
  expect(await one.json()).toMatchObject({ conversationId: "c1", current: true });

  const transcript = await s.fetch("/admin/api/conversations/c1/transcript?limit=1", { headers: AUTH });
  expect(await transcript.json()).toEqual({ items: [{ id: "e2", kind: "message", messages: [{ role: "assistant", content: "hello" }] }] });

  for (const path of ["/admin/api/conversations/nope", "/admin/api/conversations/nope/transcript", "/admin/api/conversations/%E0/transcript", "/admin/api/conversations/nope/events"]) {
    const response = await s.fetch(path, { headers: AUTH });
    expect({ path, status: response.status }).toEqual({ path, status: 404 });
  }
});

test("GET …/events: a snapshot, then each change, as server-sent events; the client leaving releases the watch", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  const client = new AbortController();

  const response = await s.fetch("/admin/api/conversations/c1/events", { headers: AUTH, signal: client.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const stream = sse(response);
  expect(await stream.take(1)).toEqual([{ type: "snapshot", conversationId: "c1" }]);
  s.runtime.push({ type: "message_update", text: "hel" });
  s.runtime.push({ type: "agent_end" });
  expect(await stream.take(2)).toEqual([{ type: "message_update", text: "hel" }, { type: "agent_end" }]);

  client.abort();
  await stream.reader.cancel();
  await Bun.sleep(10);
  expect(s.runtime.released).toBe(1);
});

test("GET …/events: a quiet stream gets a heartbeat comment", async () => {
  const s = await started({ heartbeatMs: 1000 });
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  const client = new AbortController();
  const response = await s.fetch("/admin/api/conversations/c1/events", { headers: AUTH, signal: client.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let text = "";
  const deadline = Date.now() + 3000;
  while (!text.includes(": heartbeat") && Date.now() < deadline) text += decoder.decode((await reader.read()).value);

  expect(text).toContain(": heartbeat\n\n");
  client.abort();
  await reader.cancel();
});

test("POST …/messages: a steer through agent.runtime, logged without its text", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true });

  const response = await s.fetch("/admin/api/conversations/c1/messages", post({ text: "stop and summarise" }));
  const body = (await response.json()) as { requestId: string; admission: string };

  expect(response.status).toBe(202);
  expect(body.admission).toBe("queued");
  expect(body.requestId).toMatch(/^admin:[0-9a-f-]{36}$/);
  expect(s.runtime.dispatched).toEqual([
    { requestId: body.requestId, conversation: { key: "telegram:1", agent: "assistant", conversationId: "c1" }, prompt: "stop and summarise", whenBusy: "steer" },
  ]);
  const log = s.logged.find((each) => each.message.includes("sent a message"));
  expect(log?.fields).toMatchObject({ operator: "ops", conversation: "telegram:1" });
  expect(JSON.stringify(s.logged)).not.toContain("summarise");
});

test("POST …/messages: the client's request id and followUp are kept", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const response = await s.fetch("/admin/api/conversations/c1/messages", post({ text: "hi", requestId: "ui:42", whenBusy: "followUp" }));

  expect(await response.json()).toEqual({ requestId: "ui:42", admission: "started" });
  expect(s.runtime.dispatched[0]).toMatchObject({ requestId: "ui:42", whenBusy: "followUp" });
});

test("POST …/messages: a bad body is 400 and dispatches nothing", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  for (const body of [{}, { text: "" }, { text: "hi", whenBusy: "now" }, { text: "hi", requestId: "a b" }, { text: "hi", extra: 1 }, "x".repeat(10)]) {
    const response = await s.fetch("/admin/api/conversations/c1/messages", post(body));
    expect({ body, status: response.status }).toEqual({ body, status: 400 });
  }
  const notJson = await s.fetch("/admin/api/conversations/c1/messages", { method: "POST", headers: AUTH, body: "{" });
  expect(notJson.status).toBe(400);
  expect(s.runtime.dispatched).toEqual([]);
});

test("actions reach only a conversation's current one: 409 when a reset left it behind or no message reached it", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c0", key: "telegram:1", agent: "assistant" }, false);
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });
  s.runtime.add({ conversationId: "c2" });

  for (const action of ["messages", "abort", "reset"]) {
    const behind = await s.fetch(`/admin/api/conversations/c0/${action}`, post({ text: "hi" }));
    expect(await behind.json()).toMatchObject({ error: "not_current" });
    expect(behind.status).toBe(409);
    const empty = await s.fetch(`/admin/api/conversations/c2/${action}`, post({ text: "hi" }));
    expect(await empty.json()).toMatchObject({ error: "no_agent" });
    const unknown = await s.fetch(`/admin/api/conversations/c9/${action}`, post({ text: "hi" }));
    expect(unknown.status).toBe(404);
  }
  expect(s.runtime.dispatched).toEqual([]);
  expect(s.runtime.aborted).toEqual([]);
  expect(s.runtime.pointers.get("telegram:1")?.conversationId).toBe("c1");
});

test("POST …/abort stops the run through agent.runtime", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant", busy: true });

  const response = await s.fetch("/admin/api/conversations/c1/abort", post());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conversationId: "c1" });
  expect(s.runtime.aborted).toEqual([{ key: "telegram:1", agent: "assistant", conversationId: "c1" }]);
});

test("POST …/reset points the key to a new conversation through conversations.registry", async () => {
  const s = await started();
  s.runtime.add({ conversationId: "c1", key: "telegram:1", agent: "assistant" });

  const response = await s.fetch("/admin/api/conversations/c1/reset", post());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ key: "telegram:1", previousConversationId: "c1", conversationId: "c100" });
  expect(s.runtime.pointers.get("telegram:1")?.conversationId).toBe("c100");
});

test("a path under /admin/api/ that no route serves is the API's 404, never the dashboard's page", async () => {
  const s = await started();

  const response = await s.fetch("/admin/api/nothing/here", { headers: AUTH });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
  expect((await s.fetch("/admin/api/nothing", { method: "DELETE", headers: AUTH })).status).toBe(404);
});

test("without a built dashboard the API still answers, and /admin/ says why there is no page", async () => {
  const s = await started();

  const page = await s.fetch("/admin/");
  expect(page.status).toBe(404);
  expect(await page.text()).toContain("no dashboard is built");
  expect((await s.fetch("/admin/api/app", { headers: AUTH })).status).toBe(200);
  expect(s.logged.some((each) => each.message.includes("no dashboard is built"))).toBe(true);
});

const PENDING: PendingPiece[] = [
  { idempotencyKey: "c1:m1", index: 0, channel: "telegram", conversationKey: "telegram:1", state: "retrying", attempts: 2, nextAttemptAt: 50, lastError: "rate_limited: wait", possibleDuplicate: false, storedAt: 10 },
  { idempotencyKey: "c1:m2", index: 0, channel: "telegram", conversationKey: "telegram:1", state: "queued", attempts: 0, possibleDuplicate: false, storedAt: 11 },
];
const RECEIPTS: DeliveryReceipt[] = [
  { idempotencyKey: "c1:m0", index: 0, channel: "telegram", conversationKey: "telegram:1", attempts: 1, outcome: { kind: "delivered", platformMessageId: "77", possibleDuplicate: true }, at: 5 },
  { idempotencyKey: "c2:m0", index: 0, channel: "telegram", conversationKey: "telegram:2", attempts: 3, outcome: { kind: "abandoned", reason: "permanent: chat not found" }, at: 6 },
];

/** An outbound queue holding PENDING and RECEIPTS, as admin-api reads it. */
const queue = defineComponent({
  name: "queue-test",
  setup(pikit) {
    const outbound: OutboundQueue = {
      enqueue: async () => {},
      attach: () => {},
      detach: async () => {},
      pending: async (page) => {
        if (page.cursor !== undefined && page.cursor !== "p2") throw new Error("not a cursor of this queue");
        return page.cursor === undefined ? { items: PENDING.slice(0, page.limit ?? 50), next: "p2" } : { items: [] };
      },
      receipts: {
        read: async (after, limit) => {
          if (after !== undefined && !/^r\d$/.test(after)) throw new Error("malformed cursor");
          const from = after === undefined ? 0 : Number(after.slice(1)) + 1;
          return { items: RECEIPTS.slice(from, from + limit).map((fact, i) => ({ cursor: `r${from + i}`, fact })), gap: false };
        },
      },
    };
    pikit.provide("outbound.queue", outbound);
  },
});

test("delivery: what is not delivered yet and what settled, read from outbound.queue; never a piece's text", async () => {
  const s = await started({}, [queue]);

  const pending = await s.fetch("/admin/api/delivery/pending?limit=10", { headers: AUTH });
  expect(pending.status).toBe(200);
  expect(await pending.json()).toEqual({ items: PENDING, next: "p2" });

  const receipts = await s.fetch("/admin/api/delivery/receipts?limit=1", { headers: AUTH });
  expect(await receipts.json()).toEqual({ items: [{ cursor: "r0", ...RECEIPTS[0] }], gap: false, next: "r0" });
  const after = await s.fetch("/admin/api/delivery/receipts?after=r0&limit=5", { headers: AUTH });
  expect(await after.json()).toEqual({ items: [{ cursor: "r1", ...RECEIPTS[1] }], gap: false, next: "r1" });
  // Past the last one, the cursor stays where it was: read on from it later.
  const end = await s.fetch("/admin/api/delivery/receipts?after=r1", { headers: AUTH });
  expect(await end.json()).toEqual({ items: [], gap: false, next: "r1" });

  for (const path of ["/admin/api/delivery/pending?cursor=forged", "/admin/api/delivery/receipts?after=forged", "/admin/api/delivery/receipts?limit=0"]) {
    expect({ path, status: (await s.fetch(path, { headers: AUTH })).status }).toEqual({ path, status: 400 });
  }
  expect((await s.fetch("/admin/api/delivery/pending")).status).toBe(401);
});

test("delivery without an outbound.queue: 404 not_installed, and the rest of the API as before", async () => {
  const s = await started();

  for (const path of ["/admin/api/delivery/pending", "/admin/api/delivery/receipts"]) {
    const response = await s.fetch(path, { headers: AUTH });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_installed" });
  }
});
