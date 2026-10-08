/**
 * agents-live and router-rules on Cloudflare, in real Durable Objects (deployment-cloudflare's
 * `Conversation` class, as `PlatformConversation`, `src/platform.ts`): the objects' App has
 * settings-store, agents-live (`agent.directory`), router-rules, router-basic and runtime-pi; the
 * Worker's App serves settings-store's Worker half. An operator creates a live agent and a rule that
 * routes a sender to it through the Worker (the settings object stores both); a conversation's object
 * routes that sender's next message to the live agent, which answers with its own prompt, with no
 * restart; a rule naming no agent halts the message. And the `agent.directory` suite on agents-live
 * over settings-store's table on storage-do, in a real object's SQLite (each case in an object of its own).
 */

import { BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type AdminAuth, type AgentDirectory, admitInbound, type DirectoryAgent, type Settings } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { createAgentDirectoryConformance, withWorkersHost } from "@pikit/contracts/testing";
import { holdTool, scriptedAgent, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it, vi } from "vitest";
import agentsLive from "../../../registry/components/agents-live/files/src/pikit/agents-live/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import routerRules from "../../../registry/components/router-rules/files/src/pikit/router-rules/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import settingsStore, { worker as settingsStoreWorker } from "../../../registry/components/settings-store/files/src/pikit/settings-store/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

afterEach(() => resetObjects());

/** The scripted agent (`scripted`, the code's) and model (`faux/scripted`), recording the instructions of each request in `told`. */
function model(told: string[]): ComponentDefinition[] {
  const agent = { ...scriptedAgent(holdTool(async () => "released")), systemPrompt: "The code's." };
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

for (const c of createAgentDirectoryConformance(async () => {
  let directory: AgentDirectory | undefined;
  let settings: Settings | undefined;
  const reader = defineComponent({
    name: "reader-test",
    setup(pikit) {
      const handles = { directory: pikit.use("agent.directory"), settings: pikit.use("settings") };
      return {
        start() {
          directory = handles.directory.get();
          settings = handles.settings.get();
        },
      };
    },
  });
  const app = await defineApp({ components: withWorkersHost(objectHost(), [storageDo, ...model([]), settingsStore, agentsLive, reader]), logger: silentLogger }).create();
  await app.start();
  const ctx = app.context();
  return {
    directory: directory as AgentDirectory,
    ctx,
    put: async (agents: readonly DirectoryAgent[]) => {
      await settings?.set("agents-live", Object.fromEntries(agents.map(({ name, ...fields }) => [name, fields])), { id: "ops" }, ctx);
    },
    model: "faux/scripted",
    definedAgent: "scripted",
    dispose: () => app.stop(),
  };
})) {
  it(`agents-live over settings-store on storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** A channel's object half: each message through the inbound path (routing included); answers and outcomes recorded. */
function channelActor(answers: string[], outcomes: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result) => void answers.push(`${result.conversation.agent}: ${result.text}`));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text, sender } = message as { id: string; text: string; sender: string };
            const inbound = { id, channel: "test", conversationId: key, actor: { id: sender }, text, raw: {}, receivedAt: ctx.clock.now() };
            const outcome = await admitInbound(ctx, inbound, { conversations: registry.get(), runtime: runtime.get(), key });
            outcomes.push(outcome.kind === "halted" ? `halted: ${outcome.reason}` : outcome.kind);
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
    send: (key: string, id: string, text: string, sender: string) => mailbox?.send(key, "test.message", { id, text, sender }, app.context()),
    put: (component: string, value: unknown) =>
      server.serve(new Request(`https://pikit.test/admin/api/settings/${component}`, { method: "PUT", body: JSON.stringify(value), headers: { ...AUTH, "content-type": "application/json" } })),
    stop: () => app.stop(),
  };
}

it("an operator's live agent and rule, set through the Worker, route a sender's next message to it, which answers with its own prompt; a rule naming no agent halts", async () => {
  const answers: string[] = [];
  const outcomes: string[] = [];
  const told: string[] = [];
  composeObjects(
    [storageDo, storageKvSql, platformCloudflare, ...model(told), runtimePi, conversationsKv, auth, settingsStore, agentsLive, routerRules, routerBasic, channelActor(answers, outcomes)],
    { "router-basic": { defaultAgent: "scripted" } },
  );
  const worker = await workerApp();
  try {
    // Before any setting: the code's agent answers.
    await worker.send(`test:${crypto.randomUUID()}`, "m1", "hello", "ana");
    await vi.waitFor(() => expect(answers).toContain("scripted: answer: hello"), { timeout: 10_000 });
    expect(told.at(-1)).toContain("The code's.");

    expect((await worker.put("agents-live", { support: { model: "faux/scripted", systemPrompt: "Help customers." } })).status).toBe(200);
    expect((await worker.put("router-rules", { rules: [{ actor: "ana", agent: "support" }, { actor: "bob", agent: "nobody" }] })).status).toBe(200);
    // Refused by the settings object: a code agent's name, a model no provider has.
    expect((await worker.put("agents-live", { scripted: { model: "faux/scripted" } })).status).toBe(400);
    expect((await worker.put("agents-live", { other: { model: "gone/model" } })).status).toBe(400);

    // A new chat's object reads them at its first admission.
    await worker.send(`test:${crypto.randomUUID()}`, "m2", "my order?", "ana");
    await vi.waitFor(() => expect(answers).toContain("support: answer: my order?"), { timeout: 10_000 });
    expect(told.at(-1)).toContain("Help customers.");
    expect(told.at(-1)).not.toContain("The code's.");

    await worker.send(`test:${crypto.randomUUID()}`, "m3", "hi", "bob");
    await vi.waitFor(() => expect(outcomes.at(-1)).toContain('halted: router-rules: the rule for this message names "nobody", which is no agent'), { timeout: 10_000 });
  } finally {
    await worker.stop();
  }
});
