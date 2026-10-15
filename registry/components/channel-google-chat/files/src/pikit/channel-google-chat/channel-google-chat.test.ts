// Owner: skeleton. The component composed and started on both targets' shapes, its shared helpers, and the fake Google itself.
/**
 * channel-google-chat's skeleton tests. They are copied with the component and keep running in your
 * project.
 *
 * - The component composes in a server's App (the default export only, no `actor.*`), starts, serves
 *   its routes and stops; in a Durable Object's App (`actor.inbox` scope `"one"`) it registers its
 *   inbox handlers; the Worker's half composes with `secrets` and `actor.mailbox`. Start makes no
 *   request to Google and calls no handler.
 * - instance.ts and event.ts: secrets, keys, the setting, the tolerant parser.
 * - `fake-google-chat.test-support.ts` behaves as Google does where the other tests rely on it.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ActorCallHandler, ActorInboxHandler, AgentRuntime, ConversationRegistry, Settings, SettingsSchema, SettingsValue, Wakeups } from "@pikit/contracts";
import { createMemoryKeyValueStorage, createMemorySubmissions } from "@pikit/contracts/testing";
import { eventKind, readEvent, spaceOf } from "./event.ts";
import {
  addedEvent,
  clickEvent,
  type FakeGoogleChat,
  type JsonWebKey,
  messageEvent,
  removedEvent,
  signAssertion,
  startFakeGoogleChat,
  verifyJwt,
} from "./fake-google-chat.test-support.ts";
import channelGoogleChat, { CLICK_TYPE, EVENT_TYPE, NAME, SWEEP, worker, WORKER_NAME } from "./index.ts";
import {
  addOnEmail,
  conversationKey,
  conversationModeOf,
  instanceOfKey,
  instancesOf,
  parseAllowedSpaces,
  parseConversationKey,
  parseServiceAccount,
  readCredentials,
  settingsDefaultsOf,
} from "./instance.ts";

const fakes: FakeGoogleChat[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.stop().catch(() => {});
  for (const fake of fakes.splice(0)) await fake.stop();
});

async function fake(): Promise<FakeGoogleChat> {
  const google = await startFakeGoogleChat();
  fakes.push(google);
  return google;
}

const provider = <T,>(name: string, capability: string, value: T): ComponentDefinition =>
  defineComponent({ name, setup: (pikit) => pikit.provide(capability as "secrets", value as never) });

const secretsWith = (values: Record<string, string>) => provider("secrets-test", "secrets", { get: async (name: string) => values[name] || undefined });

/** Nothing here may be called by a start: every one throws. */
const untouched = <T extends object>(what: string): T =>
  new Proxy({} as T, {
    get: (_target, property) => (property === "then" ? undefined : () => Promise.reject(new Error(`${what}.${String(property)} called`))),
  });

/** `wakeups` that records requests and runs nothing. */
function recordingWakeups() {
  const handled: string[] = [];
  const requested: string[] = [];
  const wakeups: Wakeups = {
    handle: (name) => void handled.push(name),
    at: async (name) => void requested.push(name),
    cancel: async () => {},
  };
  return { component: provider("wakeups-test", "wakeups", wakeups), handled, requested };
}

/** `settings` that records declarations and answers their defaults. */
function recordingSettings() {
  const declared = new Map<string, { schema: SettingsSchema; defaults: SettingsValue }>();
  const settings: Settings = {
    declare: (component, schema, defaults) => void declared.set(component, { schema, defaults }),
    get: async <T extends SettingsValue>(component: string) => declared.get(component)?.defaults as T,
  };
  return { component: provider("settings-test", "settings", settings), declared };
}

/** `actor.inbox` with the scope `"one"` (a Durable Object), recording what is registered, and an `actor.mailbox`. */
function objectActors() {
  const handled = new Map<string, ActorInboxHandler>();
  const answered = new Map<string, ActorCallHandler>();
  const component = defineComponent({
    name: "actors-test",
    setup(pikit) {
      pikit.provide("actor.inbox", {
        scope: "one",
        handle: (type, handler) => void handled.set(type, handler),
        answer: (type, handler) => void answered.set(type, handler),
        answerStream: () => {},
      });
      pikit.provide("actor.mailbox", untouched("actor.mailbox"));
    },
  });
  return { component, handled, answered };
}

/** The capabilities the default export requires, none of which a start may call but storage and secrets. */
function required(secrets: Record<string, string>) {
  const wakeups = recordingWakeups();
  return {
    wakeups,
    components: [
      secretsWith(secrets),
      provider("registry-test", "conversations.registry", untouched<ConversationRegistry>("conversations.registry")),
      provider("runtime-test", "agent.runtime", untouched<AgentRuntime>("agent.runtime")),
      provider("submissions-test", "agent.submissions", createMemorySubmissions().submissions),
      provider("kv-test", "storage.kv", createMemoryKeyValueStorage()),
      wakeups.component,
    ],
  };
}

/** The routes an App provides, by key. */
function routesOf() {
  let keys: string[] = [];
  const component = defineComponent({
    name: "routes-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return { start: () => void (keys = routes.keys().sort()) };
    },
  });
  return { component, keys: () => keys };
}

async function started(components: ComponentDefinition[], config: Record<string, unknown>): Promise<App> {
  const app = await defineApp({ components, config, logger: silentLogger }).create();
  apps.push(app);
  await app.start();
  return app;
}

/** Why a start failed: the component's own error (the App wraps it). */
async function startFailure(components: ComponentDefinition[], config: Record<string, unknown>): Promise<string> {
  try {
    await started(components, config);
  } catch (error) {
    const cause = (error as Error).cause;
    return cause instanceof Error ? cause.message : String(error);
  }
  throw new Error("it started");
}

const configFor = (google: FakeGoogleChat, instances: string[] = []) => ({ apiBase: google.apiBase, jwksUrl: google.jwksUrl, instances });

// ---------------------------------------------------------------------------------------------------
// The component, composed

test("on a server (the default export alone, no actors): it starts with no request to Google, serves each app's route, declares its setting, and stops", async () => {
  const google = await fake();
  const { components, wakeups } = required({ ...google.secrets(["spaces/AAA"]), ...google.secrets([], "GOOGLE_CHAT_OPS_") });
  const settings = recordingSettings();
  const routes = routesOf();
  const app = await started([...components, settings.component, channelGoogleChat, routes.component], { [NAME]: configFor(google, ["ops"]) });

  expect(routes.keys()).toEqual(["POST /google-chat", "POST /google-chat/ops"]);
  expect(google.calls).toEqual([]);
  // The crash's placeholders are swept by a wakeup, never in start.
  expect(wakeups.handled).toContain(SWEEP);
  expect(wakeups.requested).toContain(SWEEP);
  expect(wakeups.handled).toContain(`${NAME}.answers`);
  expect(settings.declared.get(NAME)?.defaults).toEqual({
    googlechat: { conversations: { default: "thread", chats: {} } },
    "googlechat:ops": { conversations: { default: "thread", chats: {} } },
  });
  await app.stop();
});

test("a missing or unusable secret fails the start, naming it", async () => {
  const google = await fake();
  const { components } = required({ ...google.secrets(), GOOGLE_CHAT_SERVICE_ACCOUNT: "" });
  expect(await startFailure([...components, channelGoogleChat], { [NAME]: configFor(google) })).toMatch(/GOOGLE_CHAT_SERVICE_ACCOUNT is not set/);
  const broken = required({ ...google.secrets(), GOOGLE_CHAT_ALLOWED_SPACES: "spaces/a/b" });
  expect(await startFailure([...broken.components, channelGoogleChat], { [NAME]: configFor(google) })).toMatch(/GOOGLE_CHAT_ALLOWED_SPACES/);
});

test("in a conversation's object (actor.inbox scope one): it answers the Worker's events and clicks through actor.inbox; without actor.mailbox it refuses to start", async () => {
  const google = await fake();
  const actors = objectActors();
  const { components } = required(google.secrets(["spaces/AAA"]));
  await started([...components, actors.component, channelGoogleChat], { [NAME]: configFor(google) });
  expect([...actors.handled.keys()]).toEqual([EVENT_TYPE]);
  expect([...actors.answered.keys()]).toEqual([CLICK_TYPE]);

  const lonely = defineComponent({
    name: "inbox-only",
    setup: (pikit) => pikit.provide("actor.inbox", { scope: "one", handle: () => {}, answer: () => {}, answerStream: () => {} }),
  });
  const again = required(google.secrets(["spaces/AAA"]));
  expect(await startFailure([...again.components, lonely, channelGoogleChat], { [NAME]: configFor(google) })).toMatch(/actor\.mailbox, which is not installed/);
});

test("the Worker's half: its routes with secrets and actor.mailbox, its setting declared too", async () => {
  const google = await fake();
  const settings = recordingSettings();
  const routes = routesOf();
  const app = await started(
    [secretsWith(google.secrets(["spaces/AAA"])), provider("mailbox-test", "actor.mailbox", untouched("actor.mailbox")), settings.component, worker, routes.component],
    { [WORKER_NAME]: configFor(google) },
  );
  expect(routes.keys()).toEqual(["POST /google-chat"]);
  expect(settings.declared.has(NAME)).toBe(true);
  expect(google.calls).toEqual([]);
  const described = (name: string) => app.describe().components.find((component) => component.name === name);
  expect(described(WORKER_NAME)).toMatchObject({ provides: ["http.route"], requires: ["secrets", "actor.mailbox"], optional: ["settings"] });
});

test("what setup declares, as component.json's halves say", async () => {
  const google = await fake();
  const { components } = required(google.secrets());
  const app = await defineApp({ components: [...components, channelGoogleChat], config: { [NAME]: configFor(google) }, logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === NAME)).toMatchObject({
    provides: ["http.route"],
    requires: ["secrets", "conversations.registry", "agent.runtime", "agent.submissions", "storage.kv", "wakeups"],
    optional: ["outbound.queue", "settings", "workspace", "execution", "actor.inbox", "actor.mailbox"],
  });
});

// ---------------------------------------------------------------------------------------------------
// instance.ts and event.ts

test("instances: the default app and named ones, each with its path and secrets", () => {
  const [main, ops] = instancesOf(["ops-eu"]);
  expect(main).toMatchObject({ instance: "googlechat", path: "/google-chat", secrets: { serviceAccount: "GOOGLE_CHAT_SERVICE_ACCOUNT", allowedSpaces: "GOOGLE_CHAT_ALLOWED_SPACES" } });
  expect(ops).toMatchObject({ instance: "googlechat:ops-eu", path: "/google-chat/ops-eu", secrets: { projectNumber: "GOOGLE_CHAT_OPS_EU_PROJECT_NUMBER", audience: "GOOGLE_CHAT_OPS_EU_AUDIENCE" } });
});

test("conversation keys: a thread's and a whole chat's, read back, and the instance they belong to", () => {
  expect(conversationKey("googlechat", "spaces/AAA", "spaces/AAA/threads/BBB")).toBe("googlechat:spaces/AAA:threads/BBB");
  expect(conversationKey("googlechat:ops", "spaces/AAA")).toBe("googlechat:ops:spaces/AAA");
  expect(() => conversationKey("googlechat", "spaces/AAA", "spaces/ZZZ/threads/BBB")).toThrow(/not of the space/);
  expect(parseConversationKey("googlechat:ops:spaces/AAA:threads/BBB")).toEqual({ instance: "googlechat:ops", space: "spaces/AAA", thread: "spaces/AAA/threads/BBB" });
  expect(parseConversationKey("googlechat:spaces/AAA")).toEqual({ instance: "googlechat", space: "spaces/AAA" });
  expect(parseConversationKey("telegram:123")).toBeUndefined();
  const instances = instancesOf(["ops"]);
  expect(instanceOfKey(instances, "googlechat:ops:spaces/AAA")?.instance).toBe("googlechat:ops");
  expect(instanceOfKey(instances, "googlechat:spaces/AAA:threads/B")?.instance).toBe("googlechat");
  expect(instanceOfKey(instances, "googlechat:other:spaces/AAA")).toBeUndefined();
});

test("the conversations setting: a chat listed, else the default; the config's when there is none", () => {
  const fallback = { default: "thread" as const, chats: { "spaces/CCC": "chat" as const } };
  const settings = { googlechat: { conversations: { default: "chat" as const, chats: { "spaces/AAA": "thread" as const } } } };
  expect(conversationModeOf(settings, "googlechat", "spaces/AAA", fallback)).toBe("thread");
  expect(conversationModeOf(settings, "googlechat", "spaces/BBB", fallback)).toBe("chat");
  expect(conversationModeOf(undefined, "googlechat", "spaces/CCC", fallback)).toBe("chat");
  expect(conversationModeOf(settings, "googlechat:ops", "spaces/BBB", fallback)).toBe("thread");
  expect(settingsDefaultsOf(instancesOf([]), fallback)).toEqual({ googlechat: { conversations: fallback } });
});

test("secrets: the service account's key, the allowed spaces, the token's email", async () => {
  const google = await fake();
  expect(parseServiceAccount("{")).toBeInstanceOf(Error);
  expect(parseServiceAccount(JSON.stringify({ type: "authorized_user" }))).toBeInstanceOf(Error);
  expect(parseServiceAccount(google.serviceAccount.json)).toMatchObject({ client_email: google.serviceAccount.clientEmail, token_uri: google.tokenUri });
  expect(parseAllowedSpaces(" spaces/AAA, BBB\nspaces/C-c_1 ")).toEqual(new Set(["spaces/AAA", "spaces/BBB", "spaces/C-c_1"]));
  expect(parseAllowedSpaces("")).toEqual(new Set());
  expect(parseAllowedSpaces("spaces/a/b")).toBeInstanceOf(Error);
  const [main] = instancesOf([]);
  const credentials = await readCredentials(main!, async (name) => google.secrets(["spaces/AAA"])[name]);
  expect(credentials.tokenEmail).toBe(addOnEmail(google.idTokens.projectNumber));
  expect(credentials.audience).toBe(google.idTokens.audience);
  await expect(readCredentials(main!, async (name) => ({ ...google.secrets(), GOOGLE_CHAT_PROJECT_NUMBER: "abc" })[name])).rejects.toThrow(/PROJECT_NUMBER is not a project number/);
  await expect(readCredentials(main!, async (name) => ({ ...google.secrets(), GOOGLE_CHAT_AUDIENCE: "pikit.test" })[name])).rejects.toThrow(/AUDIENCE is not a URL/);
});

test("events: read tolerantly, told apart by their payload, their space found", () => {
  const message = messageEvent({ text: "hi" });
  expect(readEvent(JSON.parse(JSON.stringify(message)))).toEqual(message);
  expect(eventKind(message)).toBe("message");
  expect(eventKind(addedEvent())).toBe("added");
  expect(eventKind(removedEvent())).toBe("removed");
  expect(eventKind(clickEvent({ message: message.chat.messagePayload!.message }))).toBe("click");
  expect(eventKind({ chat: { widgetUpdatedPayload: {} } as never })).toBe("other");
  expect(spaceOf(addedEvent({ space: "spaces/ZZZ" }))?.name).toBe("spaces/ZZZ");
  expect(readEvent({ chat: { messagePayload: { message: {} }, futureField: 1 } })).toBeDefined();
  for (const wrong of [null, [], {}, { chat: 1 }, { chat: { user: { name: "x" } } }, { chat: { messagePayload: {} } }, { chat: { addedToSpacePayload: {} } }, { chat: { space: { name: "rooms/1" } } }]) {
    expect(readEvent(wrong)).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------------------------------
// The fake Google, where the other tests rely on it

/** An access token from the fake, as auth.ts must get one. */
async function accessToken(google: FakeGoogleChat): Promise<string> {
  const response = await google.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signAssertion(google.serviceAccount) }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

test("the fake: a token for a signed assertion, and none for a wrong one; every API call needs one", async () => {
  const google = await fake();
  const token = await accessToken(google);
  expect(google.tokensIssued).toBe(1);
  const refused = await google.fetch(google.tokenUri, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "a.b.c" }) });
  expect(refused.status).toBe(400);
  expect((await google.fetch(`${google.apiBase}/v1/spaces/AAA`)).status).toBe(401);
  const space = await google.fetch("https://chat.googleapis.com/v1/spaces/AAA", { headers: { authorization: `Bearer ${token}` } });
  expect(await space.json()).toMatchObject({ name: "spaces/AAA", spaceThreadingState: "THREADED_MESSAGES" });
});

test("the fake: a requestId repeated returns the first message; a messageId repeated once Google forgot it is refused ALREADY_EXISTS", async () => {
  const google = await fake();
  const headers = { authorization: `Bearer ${await accessToken(google)}`, "content-type": "application/json" };
  const create = (query: string, text: string) =>
    google.fetch(`${google.apiBase}/v1/spaces/AAA/messages?${query}`, { method: "POST", headers, body: JSON.stringify({ text, thread: { name: "spaces/AAA/threads/T1" } }) });
  const ids = "requestId=0b5e9d1c-1f5a-4c39-8a39-3d4f5e6a7b8c&messageId=client-abc&messageReplyOption=REPLY_MESSAGE_OR_FAIL";
  const first = (await (await create(ids, "one")).json()) as { name: string; thread: { name: string } };
  expect(first).toMatchObject({ name: "spaces/AAA/messages/client-abc", thread: { name: "spaces/AAA/threads/T1" } });
  expect(await (await create(ids, "two")).json()).toMatchObject({ name: first.name, text: "one" });
  google.forgetRequests();
  const late = await create(ids, "one");
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ error: { status: "ALREADY_EXISTS" } });
  expect((await create("messageId=Client_Bad", "x")).status).toBe(400);

  const patched = await google.fetch(`${google.apiBase}/v1/${first.name}?updateMask=text`, { method: "PATCH", headers, body: JSON.stringify({ text: "edited", cardsV2: [] }) });
  expect(await patched.json()).toMatchObject({ text: "edited" });
  expect((await google.fetch(`${google.apiBase}/v1/${first.name}`, { headers })).status).toBe(200);
  expect((await google.fetch(`${google.apiBase}/v1/${first.name}`, { method: "DELETE", headers })).status).toBe(200);
  expect((await google.fetch(`${google.apiBase}/v1/${first.name}`, { headers })).status).toBe(404);
});

test("the fake: failures on demand, media, a removed space", async () => {
  const google = await fake();
  const headers = { authorization: `Bearer ${await accessToken(google)}` };
  google.fail({ method: "GET", path: "/v1/spaces/AAA" }, { status: 429, headers: { "retry-after": "2" }, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } } });
  const limited = await google.fetch(`${google.apiBase}/v1/spaces/AAA`, { headers });
  expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "2"]);
  expect((await google.fetch(`${google.apiBase}/v1/spaces/AAA`, { headers })).status).toBe(200);
  google.fail({ path: /^\/v1\/spaces\/AAA$/ }, "network");
  await expect(google.fetch(`${google.apiBase}/v1/spaces/AAA`, { headers })).rejects.toThrow(TypeError);
  google.fail({ path: "/v1/spaces/AAA" }, "hang");
  const cut = new AbortController();
  const hanging = google.fetch(`${google.apiBase}/v1/spaces/AAA`, { headers, signal: cut.signal });
  await google.waitForCall({ path: "/v1/spaces/AAA" }, { after: google.calls.length - 1 });
  cut.abort();
  await expect(hanging).rejects.toThrow();

  google.addMedia("spaces/AAA/attachments/x", "a,b\n1,2\n", "text/csv");
  const media = await google.fetch(`${google.apiBase}/v1/media/spaces/AAA/attachments/x?alt=media`, { headers });
  expect([media.headers.get("content-type"), await media.text()]).toEqual(["text/csv", "a,b\n1,2\n"]);
  google.removeSpace("spaces/AAA");
  expect((await google.fetch(`${google.apiBase}/v1/spaces/AAA`, { headers })).status).toBe(404);
});

test("the fake: ID tokens signed with its key verify against its JWKs, with Google's claims; another key's do not", async () => {
  const google = await fake();
  const certs = await google.fetch("https://www.googleapis.com/oauth2/v3/certs");
  expect(certs.headers.get("cache-control")).toContain("max-age=3600");
  const { keys } = (await certs.json()) as { keys: JsonWebKey[] };
  const key = await crypto.subtle.importKey("jwk", keys[0]!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const verified = await verifyJwt(await google.idTokens.sign(), key);
  expect(verified?.header).toMatchObject({ alg: "RS256", kid: google.idTokens.kid });
  expect(verified?.claims).toMatchObject({ iss: "https://accounts.google.com", aud: google.idTokens.audience, email: addOnEmail(google.idTokens.projectNumber), email_verified: true });
  expect(await verifyJwt(await google.idTokens.sign({}, { foreignKey: true }), key)).toBeUndefined();
  expect((await google.idTokens.bearer({ aud: "https://elsewhere" })).startsWith("Bearer ")).toBe(true);
});

test("events built for tests: a mention annotated in a space, none in a DM", () => {
  const inSpace = messageEvent({ text: "hello" }).chat.messagePayload?.message;
  expect(inSpace).toMatchObject({ text: "@Assistant hello", argumentText: " hello", annotations: [{ type: "USER_MENTION", startIndex: 0, length: 10 }] });
  const inDm = messageEvent({ text: "hello", spaceType: "DIRECT_MESSAGE", space: "spaces/DM1" }).chat.messagePayload?.message;
  expect(inDm).toMatchObject({ text: "hello", argumentText: "hello" });
  expect(inDm?.annotations).toBeUndefined();
  expect(messageEvent({ threading: null }).chat.space?.spaceThreadingState).toBeUndefined();
});
