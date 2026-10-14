// Owner: admission. Keys and threads, the handler, attachments and quotes, against the fake Google.
/**
 * channel-google-chat's admission: which conversation an event is (key.ts), where its answer goes,
 * what a message becomes before `admitInbound` (handler.ts, attachments.ts, quote.ts), and what the
 * channel says itself, once, however often Google repeats an event.
 *
 * The Chat API here is a small client over the fake's `fetch` (`testApi`), not api.ts: these tests
 * check admission, whatever the transport's client does.
 */

import { afterEach, expect, test } from "bun:test";
import { type AppContext, defineApp, defineComponent, halt, silentLogger } from "@pikit/core";
import type { AgentRequest, AgentRuntime, ConversationRef, ConversationRegistry, KeyValueStore } from "@pikit/contracts";
import { answerKey } from "@pikit/contracts";
import { createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { ATTACHMENT_LIMITS, base64Of, readAttachments, safeName, writeFiles } from "./attachments.ts";
import type { AddOnEvent, ChatAttachment, ChatMessage } from "./event.ts";
import { addedEvent, clickEvent, type FakeGoogleChat, messageEvent, removedEvent, signAssertion, startFakeGoogleChat } from "./fake-google-chat.test-support.ts";
import { commandSeenKey, createEventHandler, REPLIES, replyIds, textOf } from "./handler.ts";
import { type ConversationMode, type Credentials, instancesOf } from "./instance.ts";
import { createAnswerTargets, createSpaceThreading, eventKey, KEY_PARAMETER } from "./key.ts";
import { QUOTE_CHARS, quoteOf } from "./quote.ts";
import { strangerText } from "./route.ts";
import { type AdmissionDeps, type ChatApi, ChatApiError, type ModeOf } from "./types.ts";

const fakes: FakeGoogleChat[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

async function fake(): Promise<FakeGoogleChat> {
  const google = await startFakeGoogleChat();
  fakes.push(google);
  return google;
}

const [MAIN] = instancesOf([]);
const main = MAIN!;

/** A small Chat API client over the fake (not api.ts): what admission calls, as Google answers it. */
async function testApi(google: FakeGoogleChat): Promise<ChatApi> {
  const response = await google.fetch(google.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signAssertion(google.serviceAccount) }),
  });
  const { access_token: token } = (await response.json()) as { access_token: string };
  const call = async (method: string, path: string, options: { body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> => {
    const query = options.query === undefined ? "" : `?${new URLSearchParams(options.query)}`;
    let answer: Response;
    try {
      answer = await google.fetch(`${google.apiBase}/v1/${path}${query}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        ...(options.signal !== undefined && { signal: options.signal }),
      });
    } catch (error) {
      throw new ChatApiError(0, String(error), { cause: error });
    }
    if (!answer.ok) {
      const body = (await answer.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
      throw new ChatApiError(answer.status, body.error?.message ?? "failed", body.error?.status === undefined ? {} : { code: body.error.status });
    }
    return answer;
  };
  return {
    async createMessage(space, message, options, signal) {
      const query: Record<string, string> = {
        ...(options.requestId !== undefined && { requestId: options.requestId }),
        ...(options.messageId !== undefined && { messageId: options.messageId }),
        ...(options.thread !== undefined && { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" }),
      };
      const body = { ...message, ...(options.thread !== undefined && { thread: { name: options.thread } }) };
      return (await call("POST", `${space}/messages`, { body, query, ...(signal !== undefined && { signal }) })).json() as Promise<ChatMessage>;
    },
    async updateMessage(name, message, fields, signal) {
      return (await call("PATCH", name, { body: message, query: { updateMask: fields.join(",") }, ...(signal !== undefined && { signal }) })).json() as Promise<ChatMessage>;
    },
    async deleteMessage(name, signal) {
      await call("DELETE", name, signal === undefined ? {} : { signal });
    },
    async getMessage(name, signal) {
      return (await call("GET", name, signal === undefined ? {} : { signal })).json() as Promise<ChatMessage>;
    },
    async getSpace(name, signal) {
      return (await call("GET", name, signal === undefined ? {} : { signal })).json() as never;
    },
    async downloadMedia(resourceName, maxBytes, signal) {
      const answer = await call("GET", `media/${resourceName}`, { query: { alt: "media" }, ...(signal !== undefined && { signal }) });
      const bytes = new Uint8Array(await answer.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new ChatApiError(413, "too large");
      return { bytes, contentType: answer.headers.get("content-type") ?? undefined };
    },
  };
}

const store = (): KeyValueStore => createMemoryKeyValueStorage().namespace("channel-google-chat");
const always = (mode: ConversationMode): ModeOf => async () => mode;

/** An App's context with a router to `support` (or a stage of `stages`). */
async function contextWith(stages?: (pikit: Parameters<Parameters<typeof defineComponent>[0]["setup"]>[0]) => void): Promise<AppContext> {
  const router = defineComponent({
    name: "router-test",
    setup(pikit) {
      stages?.(pikit);
      pikit.pipeline("route.resolve", (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: "support", access: "allow" } }), { priority: -100 });
    },
  });
  return (await defineApp({ components: [router], logger: silentLogger }).create()).context();
}

/** A registry of conversations (`<key>#<n>`, reset makes the next) and a runtime that records what it is given. */
function ends() {
  const pointers = new Map<string, ConversationRef>();
  const resets: string[] = [];
  const conversations: ConversationRegistry = {
    async resolve(key, agent, channel) {
      const found = pointers.get(key) ?? { key, agent, channel, conversationId: `${key}#1` };
      pointers.set(key, found);
      return found;
    },
    get: async (key) => pointers.get(key),
    async reset(key) {
      resets.push(key);
      const previous = pointers.get(key);
      if (previous === undefined) return undefined;
      const next = { ...previous, conversationId: `${key}#${Number(previous.conversationId.split("#")[1]) + 1}` };
      pointers.set(key, next);
      return { conversation: next, previousConversationId: previous.conversationId, newConversationId: next.conversationId };
    },
  };
  const dispatched: AgentRequest[] = [];
  const runtime: AgentRuntime = {
    async dispatch(request) {
      const seen = dispatched.some((each) => each.requestId === request.requestId);
      dispatched.push(request);
      return { kind: seen ? "duplicate" : "started", requestId: request.requestId };
    },
    abort: async () => {},
    resume: async () => {},
  };
  return { conversations, runtime, dispatched, resets };
}

/** An `ExecutionEnv` that keeps files in memory (only what writeFiles calls), or fails writing. */
function memoryEnv(options: { failWrites?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const env = {
    createDir: async (path: string) => {
      dirs.push(path);
      return { ok: true, value: undefined };
    },
    writeFile: async (path: string, content: string | Uint8Array) => {
      if (options.failWrites) return { ok: false, error: Object.assign(new Error("no space left on device"), { code: "unknown" }) };
      files.set(path, typeof content === "string" ? new TextEncoder().encode(content) : content);
      return { ok: true, value: undefined };
    },
  } as unknown as ExecutionEnv;
  return { env, files, dirs };
}

const credentialsFor = (allowed: string[]): Credentials => ({
  serviceAccount: { client_email: "x@y", private_key: "", token_uri: "" },
  projectNumber: "1",
  audience: "https://pikit.test/google-chat",
  tokenEmail: "service-1@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
  allowedSpaces: new Set(allowed),
});

/** A handler of the default instance over the fake, with `spaces/AAA` (and `spaces/DM1`) allowed. */
async function handlerSetup(options: { workspace?: WorkspaceProvider; execution?: ExecutionEnv; allowed?: string[] } = {}) {
  const google = await fake();
  const api = await testApi(google);
  const kv = store();
  const e = ends();
  const targets = createAnswerTargets(kv);
  const deps: AdmissionDeps = {
    instance: main,
    credentials: credentialsFor(options.allowed ?? ["spaces/AAA", "spaces/DM1", "spaces/OLD"]),
    api,
    targets,
    conversations: e.conversations,
    runtime: e.runtime,
    store: kv,
    workspace: options.workspace,
    execution: options.execution,
    clock: { now: () => Date.now() } as AdmissionDeps["clock"],
  };
  const handle = createEventHandler(deps);
  const keyOf = (event: AddOnEvent, mode: ConversationMode = "thread") =>
    eventKey(event, { instance: main, threading: createSpaceThreading(api, kv), mode: always(mode) }, silentContext);
  return { google, api, kv, targets, handle, keyOf, ...e };
}

const silentContext = await contextWith();
const created = (google: FakeGoogleChat) => google.callsTo({ method: "POST", path: /^\/v1\/spaces\/[^/]+\/messages$/ });
const message = (event: AddOnEvent): ChatMessage => event.chat.messagePayload!.message;

// ---------------------------------------------------------------------------------------------------
// key.ts

test("the key: a thread's in a threaded space, the whole chat's when the setting says chat, in an unthreaded chat, for an add or a removal; none for a payload dropped", async () => {
  const google = await fake();
  const api = await testApi(google);
  const deps = (mode: ConversationMode) => ({ instance: main, threading: createSpaceThreading(api, undefined), mode: always(mode) });
  const event = messageEvent({ space: "spaces/AAA", thread: "spaces/AAA/threads/T1" });
  expect(await eventKey(event, deps("thread"), silentContext)).toBe("googlechat:spaces/AAA:threads/T1");
  expect(await eventKey(event, deps("chat"), silentContext)).toBe("googlechat:spaces/AAA");
  expect(await eventKey(messageEvent({ space: "spaces/OLD", threading: "UNTHREADED_MESSAGES" }), deps("thread"), silentContext)).toBe("googlechat:spaces/OLD");
  expect(await eventKey(messageEvent({ space: "spaces/DM1", spaceType: "DIRECT_MESSAGE", thread: "spaces/DM1/threads/D" }), deps("thread"), silentContext)).toBe("googlechat:spaces/DM1:threads/D");
  expect(await eventKey(addedEvent(), deps("thread"), silentContext)).toBe("googlechat:spaces/AAA");
  expect(await eventKey(removedEvent({ space: "spaces/ZZZ" }), deps("thread"), silentContext)).toBe("googlechat:spaces/ZZZ");
  expect(await eventKey({ chat: { space: { name: "spaces/AAA" } } }, deps("thread"), silentContext)).toBeUndefined();
  const [, ops] = instancesOf(["ops"]);
  expect(await eventKey(event, { ...deps("thread"), instance: ops! }, silentContext)).toBe("googlechat:ops:spaces/AAA:threads/T1");
  // The setting is read per space: a chat listed as one conversation.
  const mode: ModeOf = async (space) => (space === "spaces/AAA" ? "chat" : "thread");
  expect(await eventKey(event, { ...deps("thread"), mode }, silentContext)).toBe("googlechat:spaces/AAA");
  expect(google.calls.filter((call) => call.path.startsWith("/v1/"))).toEqual([]);
});

test("the key of a click: its card's message's thread; in a dialog (no message), the key its action names, only of this app and space", async () => {
  const google = await fake();
  const api = await testApi(google);
  const deps = { instance: main, threading: createSpaceThreading(api, undefined), mode: always("thread") };
  const card: ChatMessage = { name: "spaces/AAA/messages/c1", thread: { name: "spaces/AAA/threads/T9" } };
  expect(await eventKey(clickEvent({ message: card }), deps, silentContext)).toBe("googlechat:spaces/AAA:threads/T9");
  const named = "googlechat:spaces/AAA:threads/T9";
  expect(await eventKey(clickEvent({ parameters: { [KEY_PARAMETER]: named } }), deps, silentContext)).toBe(named);
  expect(await eventKey(clickEvent({ parameters: { [KEY_PARAMETER]: "googlechat:spaces/ZZZ:threads/T9" } }), deps, silentContext)).toBeUndefined();
  expect(await eventKey(clickEvent({ parameters: { [KEY_PARAMETER]: "googlechat:ops:spaces/AAA" } }), deps, silentContext)).toBeUndefined();
  expect(await eventKey(clickEvent({}), deps, silentContext)).toBeUndefined();
});

test("threads: the event's state first; else spaces.get once, kept in storage.kv (another isolate reads it there); a space that cannot be read counts as threaded and is asked again", async () => {
  const google = await fake();
  const api = await testApi(google);
  google.addSpace({ name: "spaces/OLD", spaceType: "GROUP_CHAT", spaceThreadingState: "UNTHREADED_MESSAGES" });
  const kv = store();
  const threading = createSpaceThreading(api, kv);
  const gets = () => google.callsTo({ method: "GET", path: "/v1/spaces/OLD" }).length;

  expect(await threading.threaded({ name: "spaces/OLD", spaceThreadingState: "THREADED_MESSAGES" }, silentContext)).toBe(true);
  expect(gets()).toBe(0);
  expect(await threading.threaded({ name: "spaces/OLD" }, silentContext)).toBe(false);
  expect(await threading.threaded({ name: "spaces/OLD" }, silentContext)).toBe(false);
  expect(gets()).toBe(1);
  expect(await kv.get("space:spaces/OLD")).toBe(false);
  expect(await createSpaceThreading(api, kv).threaded({ name: "spaces/OLD" }, silentContext)).toBe(false);
  expect(gets()).toBe(1);

  google.fail({ method: "GET", path: "/v1/spaces/NEW" }, { status: 500 });
  const memoryOnly = createSpaceThreading(api, undefined);
  expect(await memoryOnly.threaded({ name: "spaces/NEW" }, silentContext)).toBe(true);
  expect(await memoryOnly.threaded({ name: "spaces/NEW" }, silentContext)).toBe(true);
  expect(google.callsTo({ method: "GET", path: "/v1/spaces/NEW" }).length).toBe(2);
});

test("answer targets: a thread's from its key; a whole chat's from the thread remembered for that answer, its top when none", async () => {
  const kv = store();
  const targets = createAnswerTargets(kv);
  expect(await targets.of("googlechat:spaces/AAA:threads/T1", "c#1:m1")).toEqual({ space: "spaces/AAA", thread: "spaces/AAA/threads/T1" });
  await targets.remember("c#1:m2", "spaces/AAA/threads/T2");
  await targets.remember("c#1:m2", "spaces/AAA/threads/T2");
  await targets.remember("c#1:m3", undefined);
  expect(await targets.of("googlechat:spaces/AAA", "c#1:m2")).toEqual({ space: "spaces/AAA", thread: "spaces/AAA/threads/T2" });
  expect(await targets.of("googlechat:spaces/AAA", "c#1:m3")).toEqual({ space: "spaces/AAA" });
  expect(await targets.of("googlechat:spaces/AAA", "c#1:unknown")).toEqual({ space: "spaces/AAA" });
  expect(await targets.of("telegram:42", "c#1:m2")).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------------
// handler.ts

test("a message in a space: its name the id, the space the conversation id, its sender the actor, its text without the mention after the sender's name; a DM's without a name", async () => {
  const s = await handlerSetup();
  const event = messageEvent({ text: "what is the plan?", thread: "spaces/AAA/threads/T1" });
  const key = (await s.keyOf(event))!;
  expect(await s.handle(key, event, silentContext)).toBe("admitted");
  expect(s.dispatched[0]).toMatchObject({
    requestId: message(event).name,
    prompt: "Ada Lovelace: what is the plan?",
    sender: { channel: "googlechat", id: "users/1001" },
    conversation: { key: "googlechat:spaces/AAA:threads/T1", channel: "googlechat" },
  });
  expect(s.dispatched[0]).not.toHaveProperty("images");

  const dm = messageEvent({ text: "hi there", space: "spaces/DM1", spaceType: "DIRECT_MESSAGE" });
  expect(await s.handle((await s.keyOf(dm))!, dm, silentContext)).toBe("admitted");
  expect(s.dispatched[1]?.prompt).toBe("hi there");
  expect(created(s.google)).toEqual([]);
});

test("the mention is cut by its annotation when Google gives no argumentText", () => {
  const event = messageEvent({ text: "hello there" });
  const { argumentText: _, ...rest } = message(event);
  expect(textOf(rest)).toBe("hello there");
  expect(textOf({ text: "ask @Bob about it", annotations: [{ type: "USER_MENTION", startIndex: 4, length: 4, userMention: { user: { name: "users/2", type: "HUMAN" } } }] })).toBe("ask @Bob about it");
});

test("a message Google delivers again is a duplicate: nothing runs twice, and nothing is sent to the space", async () => {
  const s = await handlerSetup();
  const event = messageEvent({ text: "once" });
  const key = (await s.keyOf(event))!;
  expect(await s.handle(key, event, silentContext)).toBe("admitted");
  expect(await s.handle(key, event, silentContext)).toBe("duplicate");
  expect(created(s.google)).toEqual([]);
});

test("a whole chat keeps each answer's thread when its message is admitted; an unthreaded chat's answers go to its top", async () => {
  const s = await handlerSetup();
  const event = messageEvent({ text: "one", thread: "spaces/AAA/threads/T7" });
  const key = (await s.keyOf(event, "chat"))!;
  expect(key).toBe("googlechat:spaces/AAA");
  await s.handle(key, event, silentContext);
  const conversation = s.dispatched[0]!.conversation;
  expect(await s.targets.of(key, answerKey(conversation, message(event).name!))).toEqual({ space: "spaces/AAA", thread: "spaces/AAA/threads/T7" });

  const old = messageEvent({ text: "two", space: "spaces/OLD", threading: "UNTHREADED_MESSAGES" });
  const oldKey = (await s.keyOf(old))!;
  await s.handle(oldKey, old, silentContext);
  expect(await s.targets.of(oldKey, answerKey(s.dispatched[1]!.conversation, message(old).name!))).toEqual({ space: "spaces/OLD" });
});

test("/new resets the conversation once per message and says so in its thread once, however often Google repeats it", async () => {
  const s = await handlerSetup();
  const first = messageEvent({ text: "hello", thread: "spaces/AAA/threads/T1" });
  const key = (await s.keyOf(first))!;
  await s.handle(key, first, silentContext);
  const reset = messageEvent({ text: "/new", thread: "spaces/AAA/threads/T1" });
  expect(await s.handle(key, reset, silentContext)).toBe("done");
  expect(await s.handle(key, reset, silentContext)).toBe("done");
  s.google.forgetRequests();
  expect(await s.handle(key, reset, silentContext)).toBe("done");
  expect(s.resets).toEqual([key]);
  expect(await s.kv.get(commandSeenKey(message(reset).name!))).toBe(REPLIES.reset);
  const replies = [...s.google.messages.values()].filter((each) => each.text === REPLIES.reset);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.thread?.name).toBe("spaces/AAA/threads/T1");
  expect(s.dispatched.map((each) => each.prompt)).toEqual(["Ada Lovelace: hello"]);
});

test("a message stopped, denied or not routed is told so briefly in its thread, once; nothing admitted", async () => {
  for (const [stage, said] of [
    [(pikit: Parameters<Parameters<typeof defineComponent>[0]["setup"]>[0]) => pikit.pipeline("inbound.normalize", () => halt("no")), REPLIES.halted],
    [(pikit: Parameters<Parameters<typeof defineComponent>[0]["setup"]>[0]) => pikit.pipeline("route.resolve", (v) => ({ ...v, decision: { agent: "support", access: "deny" as const } }), { priority: 10 }), REPLIES.denied],
  ] as const) {
    const s = await handlerSetup();
    const ctx = await contextWith(stage);
    const event = messageEvent({ text: "hi", thread: "spaces/AAA/threads/T3" });
    const key = (await s.keyOf(event))!;
    expect(await s.handle(key, event, ctx)).toBe("done");
    expect(await s.handle(key, event, ctx)).toBe("done");
    const told = [...s.google.messages.values()].filter((each) => each.text === said);
    expect(told.map((each) => each.thread?.name)).toEqual(["spaces/AAA/threads/T3"]);
    expect(s.dispatched).toEqual([]);
  }
  const s = await handlerSetup();
  const unrouted = (await defineApp({ components: [], logger: silentLogger }).create()).context();
  const event = messageEvent({ text: "hi" });
  expect(await s.handle((await s.keyOf(event))!, event, unrouted)).toBe("done");
  expect([...s.google.messages.values()].map((each) => each.text)).toEqual([REPLIES.noRoute]);
});

test("added to an allowed space: a welcome, once per add; to another: the stranger text with its id; removed: nothing sent", async () => {
  const s = await handlerSetup();
  const added = addedEvent();
  expect(await s.handle("googlechat:spaces/AAA", added, silentContext)).toBe("done");
  expect(await s.handle("googlechat:spaces/AAA", added, silentContext)).toBe("done");
  expect([...s.google.messages.values()].map((each) => each.text)).toEqual([expect.stringContaining("Mention me")]);

  const stranger = addedEvent({ space: "spaces/ZZZ" });
  await s.handle("googlechat:spaces/ZZZ", stranger, silentContext);
  const told = [...s.google.messages.values()].find((each) => each.space?.name === "spaces/ZZZ");
  expect(told?.text).toBe(strangerText(main, "spaces/ZZZ"));
  expect(told?.text).toContain("GOOGLE_CHAT_ALLOWED_SPACES");

  const before = s.google.calls.length;
  expect(await s.handle("googlechat:spaces/AAA", removedEvent(), silentContext)).toBe("done");
  expect(s.google.calls.length).toBe(before);
});

test("guards: a message from a space not allowed, from a bot, or with nothing to say admits nothing; a key of another space is refused", async () => {
  const s = await handlerSetup();
  const stranger = messageEvent({ space: "spaces/ZZZ" });
  expect(await s.handle("googlechat:spaces/ZZZ", stranger, silentContext)).toBe("done");
  const bot = messageEvent({ user: { name: "users/9", type: "BOT", displayName: "Other bot" } });
  expect(await s.handle((await s.keyOf(bot))!, bot, silentContext)).toBe("done");
  const empty = messageEvent({ text: "" });
  expect(await s.handle((await s.keyOf(empty))!, empty, silentContext)).toBe("done");
  expect(s.dispatched).toEqual([]);
  await expect(s.handle("googlechat:spaces/OTHER", messageEvent(), silentContext)).rejects.toThrow(/not a conversation of googlechat in spaces\/AAA/);
});

test("the channel's own replies: the same seed, the same ids (a UUID and a client- id Google takes)", async () => {
  const a = await replyIds("spaces/AAA/messages/m1:new");
  expect(a).toEqual(await replyIds("spaces/AAA/messages/m1:new"));
  expect(a.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a.messageId).toMatch(/^client-[0-9a-f]{56}$/);
  expect((await replyIds("spaces/AAA/messages/m2:new")).messageId).not.toBe(a.messageId);
});

// ---------------------------------------------------------------------------------------------------
// Quotes

test("a quoted message is read and put before the text as a quote, bounded; one the app cannot read is named", async () => {
  const s = await handlerSetup();
  s.google.addMessage({ name: "spaces/AAA/messages/q1", sender: { name: "users/2", displayName: "Grace Hopper" }, text: "Ship it on Friday.\nNot before." });
  const event = messageEvent({ text: "do you agree?", quoted: "spaces/AAA/messages/q1" });
  await s.handle((await s.keyOf(event))!, event, silentContext);
  expect(s.dispatched[0]?.prompt).toBe("Grace Hopper wrote, quoted in this reply:\n> Ship it on Friday.\n> Not before.\n\nAda Lovelace: do you agree?");

  s.google.addMessage({ name: "spaces/AAA/messages/q2", sender: { name: "users/2", displayName: "Grace" }, text: "x".repeat(QUOTE_CHARS + 50) });
  const long = await quoteOf({ quotedMessageMetadata: { name: "spaces/AAA/messages/q2" } }, s.api, AbortSignal.timeout(2_000));
  expect(long).toContain(`> ${"x".repeat(QUOTE_CHARS)}…`);
  expect(long).not.toContain("x".repeat(QUOTE_CHARS + 1));

  expect(await quoteOf({ quotedMessageMetadata: { name: "spaces/AAA/messages/gone" } }, s.api, AbortSignal.timeout(2_000))).toBe("(This replies to a message the app could not read.)");
  expect(await quoteOf({ text: "no quote" }, s.api, AbortSignal.timeout(2_000))).toBeUndefined();
});

// ---------------------------------------------------------------------------------------------------
// Attachments

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const attachment = (name: string, contentType: string, resource = `spaces/AAA/attachments/${name}`): ChatAttachment => ({
  name: `spaces/AAA/messages/m/attachments/${name}`,
  contentName: name,
  contentType,
  attachmentDataRef: { resourceName: resource },
  source: "UPLOADED_CONTENT",
});

test("a message's files: images to the model, text files in its text, other files written to the conversation's workspace before dispatch, a Drive file named", async () => {
  const workspace = memoryEnv();
  const resolved: ConversationRef[] = [];
  const provider: WorkspaceProvider = {
    resolve: async (conversation) => {
      resolved.push(conversation);
      return { env: workspace.env };
    },
  };
  const s = await handlerSetup({ workspace: provider });
  s.google.addMedia("spaces/AAA/attachments/photo.png", PNG, "image/png");
  s.google.addMedia("spaces/AAA/attachments/notes.txt", "first line\nsecond ``` line\n", "text/plain");
  s.google.addMedia("spaces/AAA/attachments/report.pdf", new Uint8Array([37, 80, 68, 70]), "application/pdf");
  const event = messageEvent({
    text: "look",
    name: "spaces/AAA/messages/M1.M1",
    attachments: [
      attachment("photo.png", "image/png"),
      attachment("notes.txt", "text/plain"),
      attachment("report.pdf", "application/pdf"),
      { contentName: "plan.gdoc", contentType: "application/vnd.google-apps.document", driveDataRef: { driveFileId: "d1" }, source: "DRIVE_FILE" },
    ],
  });
  expect(await s.handle((await s.keyOf(event))!, event, silentContext)).toBe("admitted");
  const request = s.dispatched[0]!;
  expect(request.images).toEqual([{ mimeType: "image/png", data: base64Of(PNG) }]);
  expect(request.prompt).toBe(
    [
      "Ada Lovelace: look",
      [
        "Files attached to this message:",
        "- photo.png: an image, shown to you",
        "- notes.txt: its text is below",
        "- report.pdf (application/pdf, 4 bytes): saved in your workspace at attachments/M1.M1/report.pdf",
        "- plan.gdoc: not read (a Google Drive file, which the app cannot open: attach the file itself)",
      ].join("\n"),
      "File notes.txt:\n````\nfirst line\nsecond ``` line\n````",
    ].join("\n\n"),
  );
  expect([...workspace.files.keys()]).toEqual(["attachments/M1.M1/report.pdf"]);
  expect(resolved.map((each) => each.conversationId)).toEqual([request.conversation.conversationId]);

  // Delivered again: the same file, under the same name; the runtime answers duplicate.
  expect(await s.handle((await s.keyOf(event))!, event, silentContext)).toBe("duplicate");
  expect([...workspace.files.keys()]).toEqual(["attachments/M1.M1/report.pdf"]);
});

test("without a workspace, other files go to execution; with neither, they are named as not read and not downloaded", async () => {
  const execution = memoryEnv();
  const withExecution = await handlerSetup({ execution: execution.env });
  withExecution.google.addMedia("spaces/AAA/attachments/a.zip", "PK", "application/zip");
  const event = messageEvent({ name: "spaces/AAA/messages/Z1", attachments: [attachment("a.zip", "application/zip")] });
  await withExecution.handle((await withExecution.keyOf(event))!, event, silentContext);
  expect([...execution.files.keys()]).toEqual(["attachments/Z1/a.zip"]);

  const bare = await handlerSetup();
  bare.google.addMedia("spaces/AAA/attachments/a.zip", "PK", "application/zip");
  await bare.handle((await bare.keyOf(event))!, event, silentContext);
  expect(bare.dispatched[0]?.prompt).toContain("- a.zip: not read (no workspace is installed to keep files in)");
  expect(bare.google.callsTo({ path: /^\/v1\/media\// })).toEqual([]);
});

test("a file that cannot be written fails the message: nothing dispatched, the handler rejects, and Google sends it again", async () => {
  const broken = memoryEnv({ failWrites: true });
  const s = await handlerSetup({ execution: broken.env });
  s.google.addMedia("spaces/AAA/attachments/a.pdf", "%PDF", "application/pdf");
  const event = messageEvent({ attachments: [attachment("a.pdf", "application/pdf")] });
  await expect(s.handle((await s.keyOf(event))!, event, silentContext)).rejects.toThrow(/could not be written/);
  expect(s.dispatched).toEqual([]);
});

test("bounds: files per message, bytes each, bytes in all, images in all, characters of text; a download that fails is named", async () => {
  const google = await fake();
  const api = await testApi(google);
  const limits = { perMessage: 4, bytesEach: 100, bytesTotal: 150, imageBytes: 20, textChars: 10 };
  google.addMedia("r/big", "x".repeat(101), "application/pdf");
  google.addMedia("r/ok", "y".repeat(90), "application/pdf");
  google.addMedia("r/more", "z".repeat(90), "application/pdf");
  google.addMedia("r/img", PNG, "image/png");
  google.addMedia("r/img2", PNG, "image/png");
  const read = await readAttachments(
    { name: "spaces/AAA/messages/B1", attachment: [attachment("big.pdf", "application/pdf", "r/big"), attachment("ok.pdf", "application/pdf", "r/ok"), attachment("more.pdf", "application/pdf", "r/more"), attachment("img.png", "image/png", "r/img"), attachment("img2.png", "image/png", "r/img2")] },
    { api, canWrite: true, limits },
    silentContext,
    AbortSignal.timeout(2_000),
  );
  expect(read.text.split("\n").slice(1)).toEqual([
    "- big.pdf: not read (larger than the 100 bytes a file may be)",
    "- ok.pdf (application/pdf, 90 bytes): saved in your workspace at attachments/B1/ok.pdf",
    "- more.pdf: not read (past what is left of the 150 bytes a message may bring)",
    "- img.png: an image, shown to you",
    "- img2.png: not read (only the first 4 files of a message are read)",
  ]);
  expect(read.files.map((each) => each.path)).toEqual(["attachments/B1/ok.pdf"]);
  expect(read.images).toHaveLength(1);

  google.addMedia("r/a.txt", "abcdefgh", "text/plain");
  google.addMedia("r/b.csv", "1,2,3,4,5,6", "text/csv");
  google.addMedia("r/c.json", "{}", "application/json");
  const texts = await readAttachments(
    { name: "spaces/AAA/messages/T1", attachment: [attachment("a.txt", "text/plain", "r/a.txt"), attachment("b.csv", "text/csv", "r/b.csv"), attachment("c.json", "application/json", "r/c.json"), attachment("img.png", "image/png", "r/img"), attachment("gone.png", "image/png", "r/gone")] },
    { api, canWrite: false, limits: { ...limits, perMessage: 10, imageBytes: 5 } },
    silentContext,
    AbortSignal.timeout(2_000),
  );
  expect(texts.text).toContain("- b.csv: its text is below, cut");
  expect(texts.text).toContain("File b.csv (its first 2 characters of 11):\n```\n1,\n```");
  expect(texts.text).toContain("- c.json: not read (past the 10 characters of text files a message may bring)");
  expect(texts.text).toContain("- img.png: not read (past the 5 bytes of images a message may bring)");
  expect(texts.text).toContain("- gone.png: not read (the app may not download it)");
  expect(texts.images).toEqual([]);
});

test("the default bounds: 10 files, 10 MB each, 25 MB in all, 1 MB of images, 50,000 characters of text", () => {
  expect(ATTACHMENT_LIMITS).toEqual({ perMessage: 10, bytesEach: 10 * 1024 * 1024, bytesTotal: 25 * 1024 * 1024, imageBytes: 1024 * 1024, textChars: 50_000 });
});

test("file names are made safe, and two of one name in a message kept apart", async () => {
  expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
  expect(safeName(".env")).toBe("env");
  expect(safeName("informe final (v2).pdf")).toBe("informe final _v2_.pdf");
  expect(safeName("")).toBe("file");
  expect(safeName(`${"a".repeat(200)}.pdf`)).toBe(`${"a".repeat(96)}.pdf`);
  const google = await fake();
  const api = await testApi(google);
  google.addMedia("r/1", "a", "application/pdf");
  google.addMedia("r/2", "b", "application/pdf");
  const read = await readAttachments(
    { name: "spaces/AAA/messages/N1", attachment: [attachment("same.pdf", "application/pdf", "r/1"), attachment("same.pdf", "application/pdf", "r/2")] },
    { api, canWrite: true },
    silentContext,
    AbortSignal.timeout(2_000),
  );
  expect(read.files.map((each) => each.path)).toEqual(["attachments/N1/same.pdf", "attachments/N1/same-2.pdf"]);
});

test("writeFiles: into the conversation's workspace when there is one, else execution; nowhere to write rejects", async () => {
  const conversation: ConversationRef = { key: "googlechat:spaces/AAA", agent: "support", conversationId: "c1", channel: "googlechat" };
  const files = [{ path: "attachments/X/a.bin", bytes: new Uint8Array([1]), contentType: undefined }];
  const workspace = memoryEnv();
  const execution = memoryEnv();
  await writeFiles(files, conversation, { workspace: { resolve: async () => ({ env: workspace.env }) }, execution: execution.env }, silentContext);
  expect([...workspace.files.keys()]).toEqual(["attachments/X/a.bin"]);
  expect(workspace.dirs).toEqual(["attachments/X"]);
  expect(execution.files.size).toBe(0);
  await expect(writeFiles(files, conversation, { workspace: undefined, execution: undefined }, silentContext)).rejects.toThrow(/nowhere to be written/);
  await writeFiles([], conversation, { workspace: undefined, execution: undefined }, silentContext);
});
