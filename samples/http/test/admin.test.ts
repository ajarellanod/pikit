/**
 * The admin API on the real runtime (SPEC §5): admin-api and admin-auth-token over runtime-pi and
 * server-bun, on real HTTP. A conversation is started through channel-http, then read, watched and
 * acted on as the dashboard does.
 */

import { afterEach, expect, test } from "bun:test";
import { holdTool, scriptedAgent } from "@pikit/pi-adapter/testing";
import adminApi from "../../../registry/components/admin-api/files/src/pikit/admin-api/index.ts";
import adminAuthToken from "../../../registry/components/admin-auth-token/files/src/pikit/admin-auth-token/index.ts";
import { ADMIN_TOKEN, createSample, type Sample, TOKEN } from "./sample.ts";

const samples: Sample[] = [];
afterEach(async () => {
  for (const sample of samples.splice(0)) await sample.dispose();
});

/** A sample with the admin API, its agent's `hold` tool waiting for `release`. */
async function running() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let called!: () => void;
  const started = new Promise<void>((resolve) => (called = resolve));
  const tool = holdTool(async (context) => {
    called();
    await Promise.race([released, new Promise<void>((resolve) => context.abortSignal?.addEventListener("abort", () => resolve()))]);
    return "released";
  });
  const sample = await createSample({ agents: [scriptedAgent(tool)], extra: [adminAuthToken, adminApi] });
  samples.push(sample);
  await sample.app.start();
  const base = await sample.listening;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, base), { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  return { sample, base, admin, started, release };
}

type Listed = { items: { conversationId: string; key?: string; agent?: string; busy: boolean; current?: boolean; usage: unknown }[] };

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test("a conversation, read as the dashboard reads it: listed with its key and agent, its transcript, the composition", async () => {
  const { sample, admin } = await running();
  expect(await sample.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" })).toMatchObject({ status: 200 });

  const listed = (await (await admin("/admin/api/conversations")).json()) as Listed;
  const conversation = listed.items.find((each) => each.key === "http:c1");
  expect(conversation).toMatchObject({ agent: "scripted", busy: false, current: true });
  expect(conversation?.usage).toBeDefined();

  const transcript = await admin(`/admin/api/conversations/${conversation?.conversationId}/transcript`);
  expect(transcript.status).toBe(200);
  expect(JSON.stringify(await transcript.json())).toContain("answer: hello");

  const app = (await (await admin("/admin/api/app")).json()) as { components: { name: string }[] };
  expect(app.components.map((c) => c.name)).toEqual(expect.arrayContaining(["runtime-pi", "admin-api", "admin-auth-token"]));
});

test("the channel's token is not an operator's: 401", async () => {
  const { base } = await running();

  const response = await fetch(new URL("/admin/api/conversations", base), { headers: { authorization: `Bearer ${TOKEN}` } });

  expect(response.status).toBe(401);
});

test("a run watched live, steered by an operator, then aborted; the chat's request learns it was stopped", async () => {
  const { sample, admin, started } = await running();
  const asked = sample.post("/v1/messages", { conversationId: "c2", text: "hold", messageId: "m1" });
  await started;
  const { items } = (await (await admin("/admin/api/conversations")).json()) as Listed;
  const id = items.find((each) => each.key === "http:c2")?.conversationId ?? "";
  await until(async () => (await (await admin(`/admin/api/conversations/${id}`)).json()) as { busy: boolean }, (c) => c.busy, "the run to be busy");

  const client = new AbortController();
  const events = await admin(`/admin/api/conversations/${id}/events`, { signal: client.signal });
  expect(events.headers.get("content-type")).toContain("text/event-stream");
  const reader = events.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toStartWith("data: ");
  expect(JSON.parse(first.slice(6).split("\n")[0] ?? "")).toMatchObject({ type: "snapshot" });

  const steer = await admin(`/admin/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: "also this" }) });
  expect(steer.status).toBe(202);
  expect(await steer.json()).toMatchObject({ admission: "queued" });

  const aborted = await admin(`/admin/api/conversations/${id}/abort`, { method: "POST" });
  expect(aborted.status).toBe(200);
  expect(await asked).toEqual({ status: 409, body: { requestId: "m1", error: "aborted" } });
  await until(async () => (await (await admin(`/admin/api/conversations/${id}`)).json()) as { busy: boolean }, (c) => !c.busy, "the run to end");

  client.abort();
  await reader.cancel().catch(() => {});
});

test("a reset from the dashboard: the key points to a new conversation, the old one is listed and read-only", async () => {
  const { sample, admin } = await running();
  await sample.post("/v1/messages", { conversationId: "c3", text: "first", messageId: "m1" });
  const before = (await (await admin("/admin/api/conversations")).json()) as Listed;
  const old = before.items.find((each) => each.key === "http:c3")?.conversationId ?? "";

  const reset = await admin(`/admin/api/conversations/${old}/reset`, { method: "POST" });
  const body = (await reset.json()) as { key: string; previousConversationId: string; conversationId: string };
  expect(reset.status).toBe(200);
  expect(body).toMatchObject({ key: "http:c3", previousConversationId: old });

  // Before any message reaches it, the new one is the key's current one, with its agent: the dashboard talks to it at once.
  const fresh = (await (await admin(`/admin/api/conversations/${body.conversationId}`)).json()) as Listed["items"][number];
  expect(fresh).toMatchObject({ key: "http:c3", agent: "scripted", current: true });
  const continued = await admin(`/admin/api/conversations/${body.conversationId}/messages`, { method: "POST", body: JSON.stringify({ text: "after the reset" }) });
  expect(continued.status).toBe(202);

  await sample.post("/v1/messages", { conversationId: "c3", text: "second", messageId: "m2" });
  const after = (await (await admin("/admin/api/conversations")).json()) as Listed;
  expect(after.items.find((each) => each.conversationId === old)).toMatchObject({ current: false });
  expect(after.items.find((each) => each.conversationId === body.conversationId)).toMatchObject({ key: "http:c3", current: true });

  const again = await admin(`/admin/api/conversations/${old}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
  expect(again.status).toBe(409);
});

test("no dashboard built: /admin/ says so, and the API answers", async () => {
  const { base, admin } = await running();

  const page = await fetch(new URL("/admin/", base));
  expect(page.status).toBe(404);
  expect(await page.text()).toContain("no dashboard is built");
  expect((await admin("/admin/api/app")).status).toBe(200);
});
