/**
 * settings-store on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class,
 * as `PlatformConversation`, `src/platform.ts`): the objects' App has settings-store's default export,
 * router-basic and runtime-pi (which declare their settings), and the Worker's App serves
 * settings-store's Worker half through deployment-cloudflare's own server. The Worker lists the
 * sections from the settings object (`settings-store:settings`), which validates and stores an
 * operator's change in its own SQLite; a conversation's object reads it at its next admission, and its
 * agent runs with the operator's system prompt. The settings object, which runs the same App, holds no
 * conversation. And the `settings` suite on settings-store's table over storage-do, in a real object's
 * SQLite (each case in an object of its own; a restart is a second App over it).
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { ActorMailbox, AdminAuth } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createSettingsConformance, withWorkersHost } from "@pikit/contracts/testing";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it, vi } from "vitest";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { SETTINGS_KEY } from "../../../registry/components/settings-store/files/src/pikit/settings-store/calls.ts";
import settingsStore, { worker as settingsStoreWorker } from "../../../registry/components/settings-store/files/src/pikit/settings-store/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

afterEach(() => resetObjects());

for (const c of createSettingsConformance(() => ({ components: () => withWorkersHost(objectHost(), [storageDo, settingsStore]) }))) {
  it(`settings-store over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The scripted agent and model (`answer: <message>`), recording the instructions of each request in `told`. */
function model(told: string[]): ComponentDefinition[] {
  const agent = { ...scriptedAgent(holdTool(async () => "released")), systemPrompt: "Be brief." };
  const provider = scriptedProvider({
    onRequest: (request) => {
      const sections = request.messages.flatMap((message) => {
        const instructions = (message as { role: string; sections?: { instructions?: string } }).sections?.instructions;
        return message.role === "system" && instructions !== undefined ? [instructions] : [];
      });
      told.push(sections.at(-1) ?? "");
    },
  });
  return [
    defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) }),
    defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
  ];
}

/** A channel's object half: each message to its key's conversation of the default agent; answers pushed to `answers`. */
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

/** The Worker's App: settings-store's Worker half, served by deployment-cloudflare's server; a mailbox to send messages. */
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
    components: [platformCloudflare, auth, settingsStoreWorker, channel, server.component],
    config: { "platform-cloudflare": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    mailbox: () => mailbox as ActorMailbox,
    send: (key: string, id: string, text: string) => mailbox?.send(key, "test.message", { id, text }, app.context()),
    fetch: (path: string, init: RequestInit = {}) =>
      server.serve(new Request(`https://pikit.test${path}`, { ...init, headers: { ...AUTH, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } })),
    stop: () => app.stop(),
  };
}

type Section = { component: string; value: Record<string, unknown>; defaults: Record<string, unknown> };

it("the Worker reads and sets the objects' settings in the settings object; a conversation's next run takes the operator's system prompt", async () => {
  const answers: string[] = [];
  const told: string[] = [];
  composeObjects(
    [storageDo, storageKvSql, platformCloudflare, ...model(told), runtimePi, conversationsKv, auth, settingsStore, routerBasic, channelActor(answers)],
    { "router-basic": { defaultAgent: "scripted" } },
  );
  const worker = await workerApp();
  const chat = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(chat, "m1", "hello");
    await vi.waitFor(() => expect(answers).toContain(`${chat}: answer: hello`), { timeout: 10_000 });
    expect(told.at(-1)).toContain("Be brief.");

    const listed = (await (await worker.fetch("/admin/api/settings")).json()) as { items: Section[] };
    expect(listed.items.map((each) => [each.component, each.value])).toEqual([
      ["router-basic", { defaultAgent: "scripted" }],
      ["runtime-pi", {}],
    ]);

    const set = await worker.fetch("/admin/api/settings/runtime-pi", { method: "PUT", body: JSON.stringify({ scripted: { systemPrompt: "Answer in French." } }) });
    expect(set.status).toBe(200);
    expect(((await set.json()) as Section).value).toEqual({ scripted: { systemPrompt: "Answer in French." } });
    const refused = await worker.fetch("/admin/api/settings/runtime-pi", { method: "PUT", body: JSON.stringify({ scripted: { model: "nobody/nothing" } }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_value" });
    expect((await worker.fetch("/admin/api/settings/nobody")).status).toBe(404);

    // The conversation's object read the settings at its last admission: past its second, it asks again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await worker.send(chat, "m2", "hello again");
    await vi.waitFor(() => expect(answers).toContain(`${chat}: answer: hello again`), { timeout: 10_000 });
    expect(told.at(-1)).toContain("Answer in French.");
    expect(told.at(-1)).not.toContain("Be brief.");

    // The settings object answered from its own storage, and holds no conversation.
    expect(await worker.mailbox().call(SETTINGS_KEY, "settings-store.read", { version: -1 }, worker.app.context())).toEqual({
      version: 1,
      values: { "runtime-pi": { scripted: { systemPrompt: "Answer in French." } } },
    });
  } finally {
    await worker.stop();
  }
});
