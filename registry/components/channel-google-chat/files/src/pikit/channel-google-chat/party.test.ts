// Owner: admission. Who a conversation is with (party.ts), against the fake Google.
/**
 * channel-google-chat's describer (`conversation.describe`, under `googlechat`): the conformance suite
 * on the component in a Durable Object's App (`actor.inbox` scope `"one"`), each message handed to its
 * inbox handler as the Worker hands it; and what it says of a space, a group chat, a direct message,
 * a thread and a named app. With no router installed a message is not admitted (`no_route`): what it
 * said of its space is kept before that.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ActorInboxHandler, AgentRuntime, ConversationRegistry, KeyValueStorage, Wakeups } from "@pikit/contracts";
import { createConversationDescribeConformance, createMemoryKeyValueStorage, createMemorySubmissions, HOSTILE_NAME } from "@pikit/contracts/testing";
import type { AddOnEvent } from "./event.ts";
import { type FakeGoogleChat, messageEvent, type MessageEventOptions, PERSON, startFakeGoogleChat } from "./fake-google-chat.test-support.ts";
import channelGoogleChat, { EVENT_TYPE, NAME } from "./index.ts";
import { conversationKey, instancesOf } from "./instance.ts";
import { partyKey, partyOf, type SeenSpace, seenSpaceOf } from "./party.ts";

const fakes: FakeGoogleChat[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

const provider = <T,>(name: string, capability: string, value: T): ComponentDefinition =>
  defineComponent({ name, setup: (pikit) => pikit.provide(capability as "secrets", value as never) });

/** Nothing here may be called: every one throws (no router: a message is never resolved nor dispatched). */
const untouched = <T extends object>(what: string): T =>
  new Proxy({} as T, { get: (_target, property) => (property === "then" ? undefined : () => Promise.reject(new Error(`${what}.${String(property)} called`))) });

/** The component in a Durable Object's App over `google`, its `storage.kv` `kv`; `send` hands it an event of a key, as the Worker does. */
function objectApp(google: FakeGoogleChat, kv: KeyValueStorage, instances: string[] = []) {
  const handlers = new Map<string, ActorInboxHandler>();
  const wakeups: Wakeups = { handle: () => {}, at: async () => {}, cancel: async () => {} };
  const secrets = { ...google.secrets(["spaces/AAA", "spaces/DM1", "spaces/GRP"]), ...(instances.includes("ops") ? google.secrets(["spaces/AAA"], "OPS_") : {}) };
  const components = [
    provider("secrets-test", "secrets", { get: async (name: string) => secrets[name] || undefined }),
    provider("registry-test", "conversations.registry", untouched<ConversationRegistry>("conversations.registry")),
    provider("runtime-test", "agent.runtime", untouched<AgentRuntime>("agent.runtime")),
    provider("submissions-test", "agent.submissions", createMemorySubmissions().submissions),
    provider("kv-test", "storage.kv", kv),
    provider("wakeups-test", "wakeups", wakeups),
    defineComponent({
      name: "actors-test",
      setup(pikit) {
        pikit.provide("actor.inbox", { scope: "one", handle: (type, handler) => void handlers.set(type, handler), answer: () => {}, answerStream: () => {} });
        pikit.provide("actor.mailbox", untouched("actor.mailbox"));
      },
    }),
    channelGoogleChat,
  ];
  const config = { [NAME]: { apiBase: google.apiBase, jwksUrl: google.jwksUrl, instances } };
  const send = async (app: App, key: string, event: AddOnEvent): Promise<void> => {
    const handler = handlers.get(EVENT_TYPE);
    if (handler === undefined) throw new Error("the object's App registered no event handler");
    await handler(key, JSON.parse(JSON.stringify(event)), app.context());
  };
  return { components, config, send };
}

async function fake(): Promise<FakeGoogleChat> {
  const google = await startFakeGoogleChat();
  fakes.push(google);
  return google;
}

/** A message of `options` to the conversation of its whole space, in the App's object. */
const message = (options: MessageEventOptions) => messageEvent({ ...options, threading: "UNTHREADED_MESSAGES" });

for (const c of createConversationDescribeConformance(async () => {
  const google = await fake();
  const kv = createMemoryKeyValueStorage();
  const object = objectApp(google, kv);
  const key = conversationKey("googlechat", "spaces/AAA");
  return {
    components: object.components,
    config: object.config,
    kind: "googlechat",
    async known(app) {
      await object.send(app, key, message({ space: "spaces/AAA", text: "hello" }));
      return {
        key,
        check(party) {
          expect(party).toEqual({ name: "Space AAA", detail: "Space", ids: [{ label: "Space", value: "spaces/AAA" }] });
        },
      };
    },
    unknown: "googlechat:spaces/ZZZ:threads/T1",
    // A named app this App does not run, and no space.
    foreign: ["googlechat:ops:spaces/AAA", "googlechat:AAA", "googlechat:spaces/AAA/threads/T1"],
    async hostile(app) {
      const dm = conversationKey("googlechat", "spaces/DM1");
      await object.send(app, dm, message({ space: "spaces/DM1", spaceType: "DIRECT_MESSAGE", user: { ...PERSON, displayName: HOSTILE_NAME } }));
      return dm;
    },
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

test("what a message says of its space is kept, once it changed: a direct message's person, a group chat's kind, a space's name", async () => {
  const google = await fake();
  const kv = createMemoryKeyValueStorage();
  const object = objectApp(google, kv);
  const app = await defineApp({ components: object.components, config: object.config, logger: silentLogger }).create();
  await app.start();
  try {
    await object.send(app, "googlechat:spaces/DM1", message({ space: "spaces/DM1", spaceType: "DIRECT_MESSAGE" }));
    await object.send(app, "googlechat:spaces/GRP", message({ space: "spaces/GRP", spaceType: "GROUP_CHAT" }));
    const store = kv.namespace(NAME);
    expect(await store.get<SeenSpace>(partyKey("spaces/DM1"))).toEqual({ kind: "dm", person: "Ada Lovelace" });
    expect(await store.get<SeenSpace>(partyKey("spaces/GRP"))).toEqual({ kind: "group", displayName: "Space GRP" });
    // A space not allowed keeps nothing.
    await object.send(app, "googlechat:spaces/BBB", message({ space: "spaces/BBB" }));
    expect(await store.get(partyKey("spaces/BBB"))).toBeUndefined();
  } finally {
    await app.stop();
  }
});

test("who a conversation is with: a space, a thread of it, a named app's, a direct message, one with no record", () => {
  const [main, ops] = instancesOf(["ops"]);
  if (main === undefined || ops === undefined) throw new Error("no instances");
  expect(partyOf(main, "spaces/AAA", "spaces/AAA/threads/T1", { kind: "space", displayName: "Ops team" })).toEqual({
    name: "Ops team",
    detail: "Space",
    ids: [
      { label: "Space", value: "spaces/AAA" },
      { label: "Thread", value: "spaces/AAA/threads/T1" },
    ],
  });
  expect(partyOf(ops, "spaces/DM1", undefined, { kind: "dm", person: "Ada" })).toEqual({
    name: "Ada",
    detail: "Direct message",
    ids: [
      { label: "Space", value: "spaces/DM1" },
      { label: "App", value: "ops" },
    ],
    instance: "ops",
  });
  expect(partyOf(main, "spaces/AAA", undefined, undefined)).toEqual({ ids: [{ label: "Space", value: "spaces/AAA" }] });
  expect(seenSpaceOf({ name: "spaces/X", spaceType: "SPACE", displayName: "  " }, PERSON)).toEqual({ kind: "space" });
});
