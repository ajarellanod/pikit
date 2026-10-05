/**
 * admin-api on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`): each conversation's object runs its App (storage-do,
 * platform-cloudflare, runtime-pi with the scripted model, conversations-kv, a channel's object half,
 * and admin-api's default export), and the Worker's App serves admin-api's Worker half through
 * deployment-cloudflare's own server. Messages reach two chats; then the Worker lists them from the
 * index object (`admin-api:index`), reads one and its transcript, follows it live (a polled snapshot),
 * resets one and is refused an action on the one left behind; the operator starts a conversation of the
 * dashboard's own, listed first as soon as its message is dispatched, and its agent answers there. The
 * index object, which runs the same App, holds no conversation.
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, AdminAuth } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it, vi } from "vitest";
import { OPERATOR_NOTE } from "../../../registry/components/admin-api/files/src/pikit/admin-api/api.ts";
import adminApi, { worker as adminApiWorker } from "../../../registry/components/admin-api/files/src/pikit/admin-api/index.ts";
import { INDEX_KEY } from "../../../registry/components/admin-api/files/src/pikit/admin-api/conversation-index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(() => resetObjects());

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The scripted agent and model: each run answers `answer: <message>`. */
function model(): ComponentDefinition[] {
  const agent = scriptedAgent(holdTool(async () => "released"));
  const provider = scriptedProvider();
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/** A channel's object half: each message to its key's conversation, through the registry; answers pushed to `answers`. */
function channelActor(answers: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result) => void answers.push(`${result.conversation.key}: ${result.text}`));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text } = message as { id: string; text: string };
            const conversation = await registry.get().resolve(key, "scripted", ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
        },
      };
    },
  });
}

/** The Worker's App: admin-api's Worker half, served by deployment-cloudflare's server; a mailbox to send messages. */
async function workerApp() {
  const server = createWorkerServer(silentLogger);
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({
    components: [platformCloudflare, auth, adminApiWorker, channel, server.component],
    config: { "platform-cloudflare": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    mailbox: () => mailbox as ActorMailbox,
    send: (key: string, id: string, text: string) => mailbox?.send(key, "test.message", { id, text }, app.context()),
    fetch: (path: string, init: RequestInit = {}) => server.serve(new Request(`https://pikit.test${path}`, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } })),
    stop: () => app.stop(),
  };
}

type Listed = { items: { conversationId: string; key?: string; current?: boolean; busy: boolean }[]; next?: string };
const id = (value: string) => encodeURIComponent(value);

it("the Worker lists the objects' conversations from the index, reads and follows one, resets one, and refuses the one left behind", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, platformCloudflare, ...model(), runtimePi, conversationsKv, auth, adminApi, channelActor(answers)]);
  const worker = await workerApp();
  const [a, b] = [`test:${crypto.randomUUID()}`, `test:${crypto.randomUUID()}`];
  try {
    await worker.send(a, "m1", "hello");
    await vi.waitFor(() => expect(answers).toContain(`${a}: answer: hello`), { timeout: 10_000 });
    await worker.send(b, "m2", "hi there");
    await vi.waitFor(() => expect(answers).toContain(`${b}: answer: hi there`), { timeout: 10_000 });

    // The newest activity first; each object's first conversation is its "1".
    const listed = await vi.waitFor(
      async () => {
        const page = (await (await worker.fetch("/admin/api/conversations")).json()) as Listed;
        expect(page.items.map((each) => each.conversationId)).toEqual([`${b}~1`, `${a}~1`]);
        return page;
      },
      { timeout: 10_000 },
    );
    expect(listed.items.map(({ key, current, busy }) => ({ key, current, busy }))).toEqual([
      { key: b, current: true, busy: false },
      { key: a, current: true, busy: false },
    ]);

    const one = await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}`);
    expect(await one.json()).toMatchObject({ conversationId: `${a}~1`, key: a, agent: "scripted", current: true });
    const transcript = (await (await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/transcript`)).json()) as { items: { messages: { role: string }[] }[] };
    expect(transcript.items.flatMap((entry) => entry.messages.map((message) => message.role))).toEqual(expect.arrayContaining(["user", "assistant"]));
    expect((await worker.fetch(`/admin/api/conversations/${id(`${a}~9`)}`)).status).toBe(404);

    // Live: the object's snapshot, polled, as server-sent events.
    const client = new AbortController();
    const events = await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/events`, { signal: client.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^data: \{"type":"snapshot"/);
    client.abort();
    await reader.cancel();

    // A reset in a's object: a new conversation there (pi-durable numbers it); the old one is kept, left behind.
    const reset = (await (await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/reset`, { method: "POST" })).json()) as { conversationId: string };
    expect(reset).toEqual({ key: a, previousConversationId: `${a}~1`, conversationId: expect.stringMatching(new RegExp(`^${a}~[0-9]+$`)) });
    expect(reset.conversationId).not.toBe(`${a}~1`);
    const refused = await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "not_current" });
    const after = (await (await worker.fetch("/admin/api/conversations")).json()) as Listed;
    // Listed at once, the newest activity; it has no key until a message reaches it, as on a server: its id says whose object it is in.
    expect(after.items.filter((each) => each.conversationId.startsWith(`${a}~`)).map(({ conversationId, key, current }) => ({ conversationId, key, current }))).toEqual([
      { conversationId: reset.conversationId, key: undefined, current: undefined },
      { conversationId: `${a}~1`, key: a, current: false },
    ]);

    // A conversation of the dashboard's own: its key's object, listed first once its message is dispatched; the agent answers there.
    const started = (await (
      await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text: "status?" }) })
    ).json()) as { key: string; conversationId: string; admission: string };
    expect(started).toMatchObject({ key: expect.stringMatching(/^dashboard:/), conversationId: expect.stringMatching(/^dashboard:.+~1$/), admission: "started" });
    const newest = (await (await worker.fetch("/admin/api/conversations?limit=1")).json()) as Listed;
    expect(newest.items.map((each) => each.conversationId)).toEqual([started.conversationId]);
    await vi.waitFor(() => expect(answers).toContain(`${started.key}: answer: ${OPERATOR_NOTE}.]\nstatus?`), { timeout: 10_000 });
    const unknown = await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "nobody", text: "hi" }) });
    expect(unknown.status).toBe(400);

    // The composition is the objects' App; the index object, which runs it too, holds no conversation.
    const app = (await (await worker.fetch("/admin/api/app")).json()) as { target: string; components: { name: string }[] };
    expect(app.target).toBe("durable");
    expect(app.components.map((c) => c.name)).toEqual(expect.arrayContaining(["runtime-pi", "admin-api"]));
    await expect(worker.mailbox().call(INDEX_KEY, "admin-api.conversation", { conversationId: "1" }, worker.app.context())).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await worker.stop();
  }
});
