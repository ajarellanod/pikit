/**
 * admin-api on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`): each conversation's object runs its App (storage-do,
 * actors-do, runtime-pi with the scripted model, conversations-kv, a channel's object half,
 * and admin-api's default export), and the Worker's App serves admin-api's Worker half through
 * deployment-cloudflare's own server. The conversation directory is admin-api's test double
 * (`directory.test-support.ts`: the contracts' `createMemoryDirectory`, recorded from each object's
 * runtime events), one for the Worker and every object (they share the tests' isolate); the integrator
 * puts conversations-directory in its place. Messages reach two chats; then the Worker lists them from
 * the directory, reads one and its transcript, follows it live (the object's stream: its state whole,
 * then the ops that change it and the entries a run adds), resets one and is refused an action on the
 * one left behind, while the new one takes a message at once; the operator starts a conversation of the
 * dashboard's own, listed first as soon as its message is dispatched, titled by it, and its agent
 * answers there. The object the Worker asks for the App (`admin-api:app`) holds no conversation. And an
 * operator's images, the most a message carries on Cloudflare (1 MB), stored in a real object's SQLite,
 * answered, and read back. `/name` and a delete for everyone (its key reset in its object), and a
 * conversation whose runs fail (a model error), listed from its dispatch.
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, AdminAuth } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_DURABLE_IMAGE_BYTES, OPERATOR_NOTE, type ApiTranscriptEntry } from "../../../registry/components/admin-api/files/src/pikit/admin-api/api.ts";
import { INITIAL, type LiveEvent, reduce } from "../../../registry/dashboard/files/src/lib/transcript.ts";
import adminApi, { worker as adminApiWorker } from "../../../registry/components/admin-api/files/src/pikit/admin-api/index.ts";
import { Directory } from "../../../registry/components/admin-api/files/src/pikit/admin-api/directory.test-support.ts";
import { APP_KEY } from "../../../registry/components/admin-api/files/src/pikit/admin-api/remote.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(() => resetObjects());

/** The mailbox the directory's delete for everyone resets a key through, in its object (`test.reset`): the running test's Worker's. */
let resetMailbox: (() => ActorMailbox) | undefined;
/** The conversation directory of this file's tests: a new one each test (`fresh`). */
let directory: Directory;
const fresh = (): Directory => {
  directory = new Directory(async (key, ctx) => void (await resetMailbox?.().call(key, "test.reset", null, ctx)));
  return directory;
};

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The scripted agent and model: each run answers `answer: <message>` (with `failing`, each model call fails). */
function model(failing?: string): ComponentDefinition[] {
  const agent = scriptedAgent(holdTool(async () => "released"));
  const provider = scriptedProvider(failing === undefined ? {} : { fail: () => Promise.resolve(failing) });
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
            const conversation = await registry.get().resolve(key, "scripted", { channel: "test" }, ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
          // The directory's delete for everyone: the key reset where its conversation is.
          inbox.get().answer("test.reset", async (key, _message, ctx) => {
            await registry.get().reset(key, undefined, ctx);
            return null;
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
    components: [actorsDo, auth, directory.component(), adminApiWorker, channel, server.component],
    config: { "actors-do": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  resetMailbox = () => mailbox as ActorMailbox;
  return {
    app,
    mailbox: () => mailbox as ActorMailbox,
    send: (key: string, id: string, text: string) => mailbox?.send(key, "test.message", { id, text }, app.context()),
    fetch: (path: string, init: RequestInit = {}) => server.serve(new Request(`https://pikit.test${path}`, { ...init, headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) } })),
    stop: () => app.stop(),
  };
}

type Listed = { items: { conversationId: string; key?: string; current?: boolean; currentId?: string; busy: boolean; title?: string; state?: string }[]; next?: string };
const id = (value: string) => encodeURIComponent(value);

it("the Worker lists the objects' conversations from the directory, reads and follows one, resets one, and refuses the one left behind", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, ...model(), runtimePi, conversationsKv, auth, fresh().component(), adminApi, channelActor(answers)]);
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

    // Live: the object's stream (one RPC), as server-sent events: its state whole, then the ops that change it,
    // folded by the dashboard's own reducer; entries the transcript gained, the same as the transcript gives.
    const client = new AbortController();
    const events = await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/events`, { signal: client.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const seen: LiveEvent[] = [];
    const partials: string[] = [];
    let wasBusy = false;
    let liveState = INITIAL;
    const until = async (done: () => boolean, what: string) => {
      while (!done()) {
        const { value, done: ended } = await reader.read();
        if (ended) throw new Error(`the live events ended before ${what} (seen: ${JSON.stringify(seen)})`);
        text += decoder.decode(value, { stream: true });
        for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
          const frame = text.slice(0, end);
          text = text.slice(end + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)) as LiveEvent;
            seen.push(event);
            liveState = reduce(liveState, { type: "event", event });
            wasBusy ||= liveState.busy;
            const partial = liveState.partial?.content.map((block) => block.type === "text" ? block.text : "").join("");
            if (partial) partials.push(partial);
          }
        }
      }
    };
    const answeredLive = () =>
      liveState.entries.some((entry) => entry.messages.some((m) => JSON.stringify(m).includes('"text":"answer: followed live"')));
    try {
      await until(() => seen.length > 0, "the first event");
      // The first event is the state whole: idle.
      expect(seen[0]).toEqual({ type: "live", ops: [["r", expect.objectContaining({ busy: false, tools: [] })]] });
      await worker.send(a, "m-live", "followed live");
      await until(() => wasBusy && !liveState.busy && answeredLive(), "the run's answer and its end");
      // The real UI consumer must understand Pi's JSON, not merely recognize event names.
      expect(seen.filter((event) => event.type === "live" && event.ops.some((op) => op[0] === "r"))).toHaveLength(1);
      for (const partial of partials) expect("answer: followed live".startsWith(partial)).toBe(true);
      expect(liveState.partial).toBeUndefined();
      expect(liveState.failure).toBeUndefined();
      expect(liveState.entries.flatMap((entry) => entry.messages)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: expect.arrayContaining([{ type: "text", text: "answer: followed live" }]) }),
      ]));
      const stored = (await (await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/transcript`)).json()) as { items: ApiTranscriptEntry[] };
      for (const entry of liveState.entries) expect(stored.items.find((each) => each.id === entry.id)).toEqual(entry);
      await vi.waitFor(() => expect(answers).toContain(`${a}: answer: followed live`), { timeout: 10_000 });
    } finally {
      client.abort();
      await reader.cancel();
    }

    // A reset in a's object: a new conversation there (pi-durable numbers it); the old one is kept, left behind.
    const reset = (await (await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/reset`, { method: "POST" })).json()) as { conversationId: string };
    expect(reset).toEqual({ key: a, previousConversationId: `${a}~1`, conversationId: expect.stringMatching(new RegExp(`^${a}~[0-9]+$`)) });
    expect(reset.conversationId).not.toBe(`${a}~1`);
    const refused = await worker.fetch(`/admin/api/conversations/${id(`${a}~1`)}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "not_current" });
    const after = (await (await worker.fetch("/admin/api/conversations")).json()) as Listed;
    // The one behind points to its key's current one, which the directory lists once it has activity.
    expect(after.items.filter((each) => each.conversationId.startsWith(`${a}~`)).map(({ conversationId, key, current, currentId }) => ({ conversationId, key, current, currentId }))).toEqual([
      { conversationId: `${a}~1`, key: a, current: false, currentId: reset.conversationId },
    ]);
    // Its key's current one, with the key's agent, before any message reaches it.
    expect(await (await worker.fetch(`/admin/api/conversations/${id(reset.conversationId)}`)).json()).toMatchObject({ key: a, agent: "scripted", current: true });
    // Talked to at once: the operator's message runs there, and its agent answers.
    const continued = await worker.fetch(`/admin/api/conversations/${id(reset.conversationId)}/messages`, { method: "POST", body: JSON.stringify({ text: "after the reset" }) });
    expect(continued.status).toBe(202);
    await vi.waitFor(() => expect(answers.some((each) => each.startsWith(`${a}: answer: `) && each.endsWith("after the reset"))).toBe(true), { timeout: 10_000 });
    const listedAfter = (await (await worker.fetch("/admin/api/conversations?limit=1")).json()) as Listed;
    expect(listedAfter.items.map((each) => each.conversationId)).toEqual([reset.conversationId]);

    // A conversation of the dashboard's own: its key's object, listed first once its message is dispatched; the agent answers there.
    const started = (await (
      await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text: "status?" }) })
    ).json()) as { key: string; conversationId: string; admission: string };
    expect(started).toMatchObject({ key: expect.stringMatching(/^dashboard:/), conversationId: expect.stringMatching(/^dashboard:.+~1$/), admission: "started" });
    const newest = (await (await worker.fetch("/admin/api/conversations?limit=1")).json()) as Listed;
    expect(newest.items.map(({ conversationId, title }) => ({ conversationId, title }))).toEqual([{ conversationId: started.conversationId, title: "Status?" }]);
    await vi.waitFor(() => expect(answers).toContain(`${started.key}: answer: ${OPERATOR_NOTE}.]\nstatus?`), { timeout: 10_000 });
    const unknown = await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "nobody", text: "hi" }) });
    expect(unknown.status).toBe(400);

    // The composition is the objects' App; the object the Worker asks for it, which runs it too, holds no conversation.
    const app = (await (await worker.fetch("/admin/api/app")).json()) as { target: string; components: { name: string }[] };
    expect(app.target).toBe("durable");
    expect(app.components.map((c) => c.name)).toEqual(expect.arrayContaining(["runtime-pi", "admin-api"]));
    await expect(worker.mailbox().call(APP_KEY, "admin-api.conversation", { conversationId: "1" }, worker.app.context())).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await worker.stop();
  }
});

it("an operator's images, 1 MB in all, are stored in the object, reach the agent and come back in the transcript; the agents are the objects' App's", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, ...model(), runtimePi, conversationsKv, auth, fresh().component(), adminApi, channelActor(answers)]);
  const worker = await workerApp();
  try {
    const agents = (await (await worker.fetch("/admin/api/agents")).json()) as { items: { name: string; tools: string[] }[] };
    expect(agents.items.map(({ name, tools }) => ({ name, tools }))).toEqual([{ name: "scripted", tools: ["hold"] }]);

    // The most a message carries on Cloudflare, in two images: a Durable Object row holds 2 MB.
    const half = btoa("x".repeat(MAX_DURABLE_IMAGE_BYTES / 2 - 2));
    const attachments = [
      { kind: "image", mimeType: "image/png", data: half },
      { kind: "image", mimeType: "image/jpeg", data: half },
    ];
    const started = (await (
      await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text: "look", attachments }) })
    ).json()) as { key: string; conversationId: string };
    await vi.waitFor(() => expect(answers).toContain(`${started.key}: answer: ${OPERATOR_NOTE}.]\nlook`), { timeout: 10_000 });

    const transcript = (await (await worker.fetch(`/admin/api/conversations/${id(started.conversationId)}/transcript`)).json()) as {
      items: { messages: { role: string; content: unknown }[] }[];
    };
    const user = transcript.items.flatMap((entry) => entry.messages).find((message) => message.role === "user");
    expect(user?.content).toEqual([
      { type: "text", text: `${OPERATOR_NOTE}.]\nlook` },
      { type: "image", mimeType: "image/png", data: half },
      { type: "image", mimeType: "image/jpeg", data: half },
    ]);
    // More is refused in the Worker, before any object is asked.
    const big = await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text: "look", attachments: [...attachments, attachments[0]] }) });
    expect(big.status).toBe(413);
  } finally {
    await worker.stop();
  }
});

it("slash commands in real objects: listed from an object's App, run in the conversation's object; the first message titles a dashboard chat, /name renames it, a delete for everyone resets its key there", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, ...model(), runtimePi, conversationsKv, auth, fresh().component(), adminApi, channelActor(answers)]);
  const worker = await workerApp();
  try {
    const commands = (await (await worker.fetch("/admin/api/commands")).json()) as { items: { name: string }[] };
    expect(commands.items.map((each) => each.name)).toEqual(["cancel", "compact", "name", "new", "status", "stop", "tasks"]);

    const started = (await (
      await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text: "Plan a weekend in Porto" }) })
    ).json()) as { key: string; conversationId: string };
    await vi.waitFor(() => expect(answers).toContain(`${started.key}: answer: ${OPERATOR_NOTE}.]\nPlan a weekend in Porto`), { timeout: 10_000 });
    // Its first title: the operator's words (the directory's).
    expect(await (await worker.fetch(`/admin/api/conversations/${id(started.conversationId)}`)).json()).toMatchObject({ title: "Plan a weekend in Porto", state: "listed", hidden: false });

    const path = (name: string) => `/admin/api/conversations/${id(started.conversationId)}/commands/${name}`;
    const compacted = await worker.fetch(path("compact"), { method: "POST" });
    expect(await compacted.json()).toEqual({ text: "Nothing to compact: the conversation is short enough as it is." });
    // `/name` runs in the object, through the directory.
    const named = await worker.fetch(path("name"), { method: "POST", body: JSON.stringify({ args: "Porto weekend" }) });
    expect(await named.json()).toEqual({ text: "Titled “Porto weekend”." });
    const listed = (await (await worker.fetch("/admin/api/conversations?limit=1")).json()) as Listed;
    expect(listed.items).toMatchObject([{ conversationId: started.conversationId, title: "Porto weekend" }]);
    const found = async (q: string) => ((await (await worker.fetch(`/admin/api/conversations?q=${encodeURIComponent(q)}`)).json()) as Listed).items.map((each) => each.conversationId);
    expect(await found("PORTO WEEK")).toEqual([started.conversationId]);
    expect(await found(started.key)).toEqual([started.conversationId]);
    expect((await worker.fetch(path("nope"), { method: "POST" })).status).toBe(404);

    // Delete for everyone: listed only as deleted, its key reset in its object (the next message starts a new conversation).
    const deleted = await worker.fetch(`/admin/api/conversations/${id(started.conversationId)}/delete`, { method: "POST" });
    expect(await deleted.json()).toEqual({ conversationId: started.conversationId, state: "deleted", hidden: false });
    expect(await found("porto")).toEqual([]);
    expect(((await (await worker.fetch("/admin/api/conversations?state=deleted")).json()) as Listed).items.map((each) => each.conversationId)).toEqual([started.conversationId]);
    const behind = (await (await worker.fetch(`/admin/api/conversations/${id(started.conversationId)}`)).json()) as Listed["items"][number];
    expect(behind).toMatchObject({ current: false, currentId: expect.stringMatching(new RegExp(`^${started.key}~[0-9]+$`)) });
    expect(behind.currentId).not.toBe(started.conversationId);
    expect((await worker.fetch(path("name"), { method: "POST", body: JSON.stringify({ args: "late" }) })).status).toBe(409);
  } finally {
    await worker.stop();
  }
});

it("a conversation the dashboard starts is in its operator's space in its object (the operator crosses the call), the same for each one it starts", async () => {
  const answers: string[] = [];
  const seen: string[] = [];
  const places = defineComponent({
    name: "places-test",
    setup(pikit) {
      pikit.on("agent.dispatched", ({ conversation }) => void seen.push(`${conversation.key} ${conversation.space ?? "none"}`));
    },
  });
  composeObjects([storageDo, storageKvSql, actorsDo, ...model(), runtimePi, conversationsKv, auth, fresh().component(), adminApi, channelActor(answers), places]);
  const worker = await workerApp();
  try {
    const start = async (text: string) =>
      (await (await worker.fetch("/admin/api/conversations", { method: "POST", body: JSON.stringify({ agent: "scripted", text }) })).json()) as { key: string };
    const one = await start("first");
    const two = await start("second");
    await vi.waitFor(() => expect(answers.length).toBe(2), { timeout: 10_000 });
    expect(seen).toEqual([`${one.key} dashboard:operator:ops`, `${two.key} dashboard:operator:ops`]);
  } finally {
    await worker.stop();
  }
});

it("a conversation whose runs fail is listed from its dispatch (the directory's activity), readable, and found by its key", async () => {
  const answers: string[] = [];
  composeObjects([storageDo, storageKvSql, actorsDo, ...model("Provider is not configured: anthropic"), runtimePi, conversationsKv, auth, fresh().component(), adminApi, channelActor(answers)]);
  const worker = await workerApp();
  const key = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(key, "m1", "Plan a trip to Lisbon");
    await vi.waitFor(
      async () => {
        const listed = (await (await worker.fetch("/admin/api/conversations?limit=1")).json()) as Listed;
        expect(listed.items.map((each) => each.conversationId)).toEqual([`${key}~1`]);
      },
      { timeout: 10_000 },
    );
    const found = async (q: string) => ((await (await worker.fetch(`/admin/api/conversations?q=${encodeURIComponent(q)}`)).json()) as Listed).items.map((each) => each.conversationId);
    expect(await found(key.toUpperCase())).toEqual([`${key}~1`]);
    // Its run failed: nothing answered; no channel gave it a title here (a channel's first message would).
    expect(answers).toEqual([]);
    await vi.waitFor(async () => expect(await (await worker.fetch(`/admin/api/conversations/${id(`${key}~1`)}`)).json()).toMatchObject({ busy: false, state: "listed" }), { timeout: 10_000 });
  } finally {
    await worker.stop();
  }
});
