/**
 * channel-google-chat on a server, as `pikit add` composes it there: the default export only (no
 * Worker half, no `actor.*`), `server-bun` serving its route over real HTTP on a free port,
 * `storage-sqlite` with `storage-kv-sql` over it, `wakeups-timers`, `outbound-durable`,
 * `execution-local` with `workspace-local`, `conversations-kv`, `router-basic`, `runtime-pi`,
 * `tool-ask-user`, and the faux provider's scripted model (`faux/scripted`, provider-faux's grammar,
 * which also records what the model was sent). Google is the channel's fake
 * (`fake-google-chat.test-support.ts`), over HTTP too: its REST API, token endpoint and signing keys.
 *
 * - A signed message is admitted; "Thinking…" is created in its thread and edited into the answer.
 * - The `conversations` setting (the config's, no `settings`): a whole chat is one conversation, and
 *   each answer still goes to its message's thread.
 * - A command typed in the chat that `commands` allows runs with its sender in its conversation, whose
 *   space conversations-kv recorded (the chat's key), and its note is said in the thread; another goes
 *   to the model as text.
 * - An image reaches the model's request; a PDF the conversation's workspace.
 * - `ask_user`: the question drawn as a card, clicked, the answer admitted, a new run answers it.
 * - A restart in the middle of an answer's send: the next process delivers it (outbound-durable), with
 *   no new run.
 * - A token refused is 401, and nothing is admitted.
 * - With `mailbox-local` installed (`actor.inbox`, scope `"all"`: a server's App is every key's actor),
 *   events are handled in process as with no inbox: answered, a question drawn and its click answered,
 *   and no handler of the channel's registered with the inbox (nothing goes through the mailbox).
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppEvents, BACKGROUND_CONTEXT, type ComponentDefinition, type Context, defineApp, defineComponent, silentLogger, withAbortSignal } from "@pikit/core";
import { type ActorMailbox, defineAgent } from "@pikit/contracts";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@pikit/pi-adapter/providers/faux";
import conversationsKv from "../conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionLocal from "../execution-local/files/src/pikit/execution-local/index.ts";
import mailboxLocal from "../mailbox-local/files/src/pikit/mailbox-local/index.ts";
import outboundDurable from "../outbound-durable/files/src/pikit/outbound-durable/index.ts";
import { scriptedReply } from "../provider-faux/files/src/pikit/provider-faux/index.ts";
import routerBasic from "../router-basic/files/src/pikit/router-basic/index.ts";
import { createRuntimePi } from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { createSecretsEnv } from "../secrets-env/files/src/pikit/secrets-env/index.ts";
import { createServerBun } from "../server-bun/files/src/pikit/server-bun/index.ts";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import storageSqlite from "../storage-sqlite/files/src/pikit/storage-sqlite/index.ts";
import toolAskUser, { ASK_USER_TOOL } from "../tool-ask-user/files/src/pikit/tool-ask-user/index.ts";
import wakeupsTimers from "../wakeups-timers/files/src/pikit/wakeups-timers/index.ts";
import workspaceLocal from "../workspace-local/files/src/pikit/workspace-local/index.ts";
import type { AddOnEvent, ChatAttachment, ChatMessage } from "./files/src/pikit/channel-google-chat/event.ts";
import { clickEvent, eventRequest, type FakeCall, type FakeGoogleChat, messageEvent, startFakeGoogleChat } from "./files/src/pikit/channel-google-chat/fake-google-chat.test-support.ts";
import { messageNameOf, pieceIds, pieceKeyOf } from "./files/src/pikit/channel-google-chat/ids.ts";
import channelGoogleChat, { CLICK_TYPE, EVENT_TYPE, NAME } from "./files/src/pikit/channel-google-chat/index.ts";

const AGENT = "assistant";
const THREADED = "spaces/AAA";
const WHOLE = "spaces/BBB";
/** A DM with the app: its messages are not prefixed with their sender's name, so the scripted model reads `call:` there. */
const DM = "spaces/DM1";
const THINKING = "Thinking…";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
}, 30_000);

/** What the model was sent: each request's newest user message, its text and images. */
interface ModelCall {
  text: string;
  images: { mimeType: string; data: string }[];
}

/** provider-faux's scripted model (`call: <tool> <json>` calls a tool, anything else is `faux: <text>`), recording each request. */
function recordingFaux(calls: ModelCall[]) {
  return defineComponent({
    name: "provider-faux",
    setup(pikit) {
      const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted (tests only)" }] });
      const answer: FauxResponseFactory = (context) => {
        faux.appendResponses([answer]);
        const newest = [...context.messages].reverse().find((message) => message.role === "user");
        const content = newest === undefined ? [] : typeof newest.content === "string" ? [{ type: "text" as const, text: newest.content }] : newest.content;
        calls.push({
          text: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
          images: content.flatMap((part) => (part.type === "image" ? [{ mimeType: part.mimeType, data: part.data }] : [])),
        });
        const reply = scriptedReply(context.messages);
        return "call" in reply ? fauxAssistantMessage(fauxToolCall(reply.call, reply.arguments), { stopReason: "toolUse" }) : fauxAssistantMessage(reply.text);
      };
      faux.setResponses([answer]);
      pikit.provideKeyed("model.provider", faux.provider.id, faux.provider);
    },
  });
}

interface Server {
  app: App;
  /** Stops the App (once), within `parent`'s deadline. */
  stop(parent?: Context): Promise<void>;
  url: URL;
  /** The runs started, in order. */
  started: AppEvents["agent.started"][];
}

/** The App over `dataDir`, started, serving on a free port; with `extra` components (mailbox-local) and `channel` config. */
async function serve(dataDir: string, google: FakeGoogleChat, calls: ModelCall[], extra: ComponentDefinition[] = [], channel: Record<string, unknown> = {}): Promise<Server> {
  let listened!: (url: URL) => void;
  const listening = new Promise<URL>((resolve) => (listened = resolve));
  const started: AppEvents["agent.started"][] = [];
  const app = await defineApp({
    components: [
      createSecretsEnv({ env: google.secrets([THREADED, WHOLE, DM]) }),
      storageSqlite,
      storageKvSql,
      executionLocal,
      workspaceLocal,
      recordingFaux(calls),
      defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", AGENT, defineAgent({ name: AGENT, model: "faux/scripted", tools: [ASK_USER_TOOL] })) }),
      toolAskUser,
      createRuntimePi(),
      conversationsKv,
      routerBasic,
      wakeupsTimers,
      outboundDurable,
      channelGoogleChat,
      createServerBun({ onListening: listened }),
      defineComponent({ name: "runs-test", setup: (pikit) => pikit.on("agent.started", (event) => void started.push(event)) }),
      ...extra,
    ],
    config: {
      "storage-sqlite": { path: join(dataDir, "pikit.db") },
      "execution-local": { root: join(dataDir, "execution") },
      "workspace-local": { root: join(dataDir, "workspaces") },
      "router-basic": { defaultAgent: AGENT },
      "server-bun": { port: 0, hostname: "127.0.0.1" },
      [NAME]: { apiBase: google.apiBase, jwksUrl: google.jwksUrl, conversations: { default: "thread", chats: { [WHOLE]: "chat" } }, ...channel },
    },
    logger: silentLogger,
  }).create();
  await app.start();
  let stopped = false;
  const stop = async (parent?: Context) => {
    if (stopped) return;
    stopped = true;
    await app.stop(parent);
  };
  cleanup.push(() => stop());
  return { app, stop, url: await listening, started };
}

async function setup(extra: ComponentDefinition[] = [], channel: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pikit-google-chat-server-"));
  const google = await startFakeGoogleChat();
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  cleanup.push(() => google.stop());
  const calls: ModelCall[] = [];
  const server = await serve(dataDir, google, calls, extra, channel);
  return {
    dataDir,
    google,
    calls,
    server,
    /** Posts `event` to the endpoint as Google does, with a token for the app (or `authorization`). */
    async post(event: AddOnEvent, authorization?: string | null, to: Server = server): Promise<{ status: number; body: unknown }> {
      const response = await fetch(eventRequest(new URL("/google-chat", to.url).href, event, authorization === undefined ? await google.idTokens.bearer() : authorization));
      const text = await response.text();
      return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
    },
  };
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** The name of the message of `requestId`'s answer's piece #0 in `space`: where its placeholder and its answer are. */
async function answerMessage(google: FakeGoogleChat, space: string, conversationId: string, requestId: string): Promise<string> {
  return messageNameOf(space, (await pieceIds(pieceKeyOf(`${conversationId}:${requestId}`, 0))).messageId);
}

/** The app's messages in `thread`. */
const inThread = (google: FakeGoogleChat, thread: string): ChatMessage[] => [...google.messages.values()].filter((message) => message.thread?.name === thread && message.sender?.type === "BOT");

const sends = (google: FakeGoogleChat, name: string): FakeCall[] => google.callsTo((call) => (call.method === "POST" && call.query.messageId !== undefined && `${call.path.slice(4)}/${call.query.messageId}` === name) || (call.method === "PATCH" && call.path === `/v1/${name}`));

test("a signed message is admitted; Thinking… is created in its thread under piece #0's ids and edited into the answer", async () => {
  const s = await setup();
  const event = messageEvent({ space: THREADED, thread: `${THREADED}/threads/T1`, name: `${THREADED}/messages/M1`, text: "hello" });
  expect(await s.post(event)).toEqual({ status: 200, body: {} });

  const [run] = await until(() => (s.server.started.length > 0 ? s.server.started : undefined), "the run to start");
  expect(run?.conversation.key).toBe(`googlechat:${THREADED}:threads/T1`);
  expect(run?.requestId).toBe(`${THREADED}/messages/M1`);
  const name = await answerMessage(s.google, THREADED, run!.conversation.conversationId, run!.requestId);
  const answered = await until(() => (s.google.messages.get(name)?.text === "faux: Ada Lovelace: hello" ? s.google.messages.get(name) : undefined), "the answer");
  expect(answered.thread?.name).toBe(`${THREADED}/threads/T1`);
  // Created as Thinking… in the thread (REPLY_MESSAGE_OR_FAIL), then edited into the answer: one message.
  const [created, ...edits] = sends(s.google, name);
  expect(created).toMatchObject({ method: "POST", query: { messageReplyOption: "REPLY_MESSAGE_OR_FAIL" }, body: { text: THINKING, thread: { name: `${THREADED}/threads/T1` } } });
  expect(edits.at(-1)).toMatchObject({ method: "PATCH", query: { updateMask: "text,cardsV2" }, body: { text: "faux: Ada Lovelace: hello" } });
  expect(inThread(s.google, `${THREADED}/threads/T1`)).toHaveLength(1);
  expect(s.calls.map((call) => call.text)).toEqual(["Ada Lovelace: hello"]);

  // Google sending it again (a timeout on its side): the same message, nothing runs again.
  expect(await s.post(event)).toEqual({ status: 200, body: {} });
  await Bun.sleep(300);
  expect(s.server.started).toHaveLength(1);
  expect(s.calls).toHaveLength(1);
}, 30_000);

test("the conversations setting: a chat listed as one conversation is one across its threads, each answer in its message's thread; a threaded space's threads are apart", async () => {
  const s = await setup();
  await s.post(messageEvent({ space: WHOLE, thread: `${WHOLE}/threads/T1`, text: "one" }));
  await until(() => (inThread(s.google, `${WHOLE}/threads/T1`).some((message) => message.text === "faux: Ada Lovelace: one") ? true : undefined), "the first answer");
  await s.post(messageEvent({ space: WHOLE, thread: `${WHOLE}/threads/T2`, text: "two" }));
  await until(() => (inThread(s.google, `${WHOLE}/threads/T2`).some((message) => message.text === "faux: Ada Lovelace: two") ? true : undefined), "the second answer, in its own thread");
  const [first, second] = s.server.started;
  expect([first?.conversation.key, second?.conversation.key]).toEqual([`googlechat:${WHOLE}`, `googlechat:${WHOLE}`]);
  expect(second?.conversation.conversationId).toBe(first?.conversation.conversationId);
  expect(inThread(s.google, `${WHOLE}/threads/T1`)).toHaveLength(1);

  await s.post(messageEvent({ space: THREADED, thread: `${THREADED}/threads/T1`, text: "three" }));
  await s.post(messageEvent({ space: THREADED, thread: `${THREADED}/threads/T2`, text: "four" }));
  await until(() => (s.server.started.length >= 4 ? true : undefined), "both threads' runs");
  const [third, fourth] = s.server.started.slice(2);
  expect(new Set([third?.conversation.key, fourth?.conversation.key])).toEqual(new Set([`googlechat:${THREADED}:threads/T1`, `googlechat:${THREADED}:threads/T2`]));
  expect(third?.conversation.conversationId).not.toBe(fourth?.conversation.conversationId);
}, 30_000);

test("a command typed in the chat (one `commands` allows) runs in its thread's conversation with its sender, in the space conversations-kv recorded; its note said in the thread; another goes to the model", async () => {
  const ran: { key: string; space: string | undefined; args: string; sender: string | undefined }[] = [];
  const commands = defineComponent({
    name: "commands-test",
    setup(pikit) {
      for (const name of ["ping", "secret"]) {
        pikit.provideKeyed("agent.command", name, {
          description: `The ${name} command`,
          async run(conversation, args, _ctx, sender) {
            ran.push({ key: conversation.key, space: conversation.space, args, sender: sender?.id });
            return { text: `pong ${args}` };
          },
        });
      }
    },
  });
  const s = await setup([commands], { commands: ["ping"] });
  expect(await s.post(messageEvent({ space: THREADED, thread: `${THREADED}/threads/C1`, text: "/ping now" }))).toEqual({ status: 200, body: {} });
  expect(inThread(s.google, `${THREADED}/threads/C1`).map((message) => message.text)).toEqual(["pong now"]);
  expect(ran).toEqual([{ key: `googlechat:${THREADED}:threads/C1`, space: `googlechat:${THREADED}`, args: "now", sender: "users/1001" }]);

  await s.post(messageEvent({ space: THREADED, thread: `${THREADED}/threads/C2`, text: "/secret" }));
  await until(() => (inThread(s.google, `${THREADED}/threads/C2`).some((message) => message.text === "faux: Ada Lovelace: /secret") ? true : undefined), "the model's answer");
  expect(ran).toHaveLength(1);
  expect(s.calls.map((call) => call.text)).toEqual(["Ada Lovelace: /secret"]);
}, 30_000);

test("an image reaches the model's request; a PDF is written to the conversation's workspace and named", async () => {
  const s = await setup();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  s.google.addMedia(`${THREADED}/attachments/photo`, png, "image/png");
  s.google.addMedia(`${THREADED}/attachments/report`, new Uint8Array([37, 80, 68, 70]), "application/pdf");
  const attachment = (contentName: string, contentType: string, resource: string): ChatAttachment => ({ contentName, contentType, attachmentDataRef: { resourceName: `${THREADED}/attachments/${resource}` }, source: "UPLOADED_CONTENT" });
  await s.post(messageEvent({ space: THREADED, name: `${THREADED}/messages/P1`, text: "look", attachments: [attachment("photo.png", "image/png", "photo"), attachment("report.pdf", "application/pdf", "report")] }));

  const [call] = await until(() => (s.calls.length > 0 ? s.calls : undefined), "the model's request");
  expect(call?.images).toEqual([{ mimeType: "image/png", data: Buffer.from(png).toString("base64") }]);
  expect(call?.text).toContain("Ada Lovelace: look");
  expect(call?.text).toContain("report.pdf (application/pdf, 4 bytes): saved in your workspace at attachments/P1/report.pdf");
  const saved = readdirSync(join(s.dataDir, "workspaces"), { recursive: true }).map(String);
  expect(saved.some((path) => path.endsWith(join("attachments", "P1", "report.pdf")))).toBe(true);
}, 30_000);

test("ask_user: the question drawn as a card in the thread; a click admits the answer once and a new run answers it", async () => {
  const s = await setup();
  const thread = `${DM}/threads/Q1`;
  const question = { title: "Deploy now?", fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }] };
  await s.post(messageEvent({ space: DM, spaceType: "DIRECT_MESSAGE", thread, text: `call: ${ASK_USER_TOOL} ${JSON.stringify(question)}` }));

  const card = await until(() => inThread(s.google, thread).find((message) => message.cardsV2?.some((each) => each.cardId.startsWith("question:"))), "the question's card");
  // The run ended with the question alone: the placeholder became the card.
  expect(inThread(s.google, thread)).toHaveLength(1);
  const buttons = card.cardsV2?.flatMap((each) => each.card.sections?.flatMap((section) => section.widgets.flatMap((widget) => widget.buttonList?.buttons ?? [])) ?? []) ?? [];
  expect(buttons.map((button) => button.text)).toEqual(["Yes", "No"]);
  const yes = buttons[0]?.onClick?.action;
  expect(yes?.function).toBe(s.google.idTokens.audience);
  const parameters = Object.fromEntries((yes?.parameters ?? []).map((each) => [each.key, each.value]));
  expect(parameters).toMatchObject({ key: `googlechat:${DM}:threads/Q1`, step: "answer", field: "go", value: "true" });

  const clicked = await s.post(clickEvent({ space: DM, spaceType: "DIRECT_MESSAGE", message: card, parameters, invokedFunction: s.google.idTokens.audience }));
  expect(clicked.status).toBe(200);
  expect(JSON.stringify(clicked.body)).toContain("Answered by Ada Lovelace");

  const answer = await until(() => inThread(s.google, thread).find((message) => message.text?.startsWith("faux: Answer to") === true), "the new run's answer");
  expect(answer.text).toContain("Deploy: yes");
  expect(s.server.started.map((run) => run.conversation.key)).toEqual([`googlechat:${DM}:threads/Q1`, `googlechat:${DM}:threads/Q1`]);
  expect(s.server.started[1]?.conversation.conversationId).toBe(s.server.started[0]?.conversation.conversationId);

  // A second click is told it is answered; nothing more runs.
  const again = await s.post(clickEvent({ space: DM, spaceType: "DIRECT_MESSAGE", message: card, parameters: { ...parameters, value: "false" } }));
  expect(JSON.stringify(again.body)).toContain("already answered");
  await Bun.sleep(300);
  expect(s.server.started).toHaveLength(2);
}, 30_000);

test("a restart in the middle of an answer's send: the next process delivers it (outbound-durable), with no new run", async () => {
  const s = await setup();
  const thread = `${THREADED}/threads/R1`;
  // The answer's edit of its placeholder reaches Google, which never answers it.
  const answerEdit = (call: FakeCall) => call.method === "PATCH" && (call.query.updateMask ?? "").includes("cardsV2");
  s.google.fail(answerEdit, "hang");
  await s.post(messageEvent({ space: THREADED, thread, text: "hold on" }));
  await s.google.waitForCall(answerEdit, { timeoutMs: 10_000 });
  // A deploy's stop, with its deadline: the send is cut, and its piece stays `sending` (the stop
  // rejects, saying its deadline passed with the send in flight).
  await s.server.stop(withAbortSignal(AbortSignal.timeout(500), BACKGROUND_CONTEXT)).catch(() => {});
  const [run] = s.server.started;
  const name = await answerMessage(s.google, THREADED, run!.conversation.conversationId, run!.requestId);
  expect(s.google.messages.get(name)?.text).toBe(THINKING);

  const next = await serve(s.dataDir, s.google, s.calls);
  await until(() => (s.google.messages.get(name)?.text === "faux: Ada Lovelace: hold on" ? true : undefined), "the answer after the restart");
  expect(inThread(s.google, thread)).toHaveLength(1);
  // The same piece sent again from the outbox, under the same message: the cut edit, then this one.
  expect(sends(s.google, name).filter(answerEdit)).toHaveLength(2);
  expect(next.started).toEqual([]);
  expect(s.calls).toHaveLength(1);
}, 30_000);

test("a token refused (another audience, another key, none) is 401, and nothing is admitted", async () => {
  const s = await setup();
  const event = messageEvent({ space: THREADED, text: "let me in" });
  expect((await s.post(event, await s.google.idTokens.bearer({ aud: "https://elsewhere.test/google-chat" }))).status).toBe(401);
  expect((await s.post(event, await s.google.idTokens.bearer({}, { foreignKey: true }))).status).toBe(401);
  expect((await s.post(event, null)).status).toBe(401);
  await Bun.sleep(300);
  expect(s.server.started).toEqual([]);
  expect(s.google.callsTo({ path: /\/messages/ })).toEqual([]);
}, 30_000);

test("with mailbox-local installed (actor.inbox, scope \"all\"), events are handled in process as with no inbox: answered, a question clicked, nothing through the mailbox", async () => {
  let mailbox: ActorMailbox | undefined;
  const reader = defineComponent({
    name: "mailbox-reader-test",
    setup(pikit) {
      const box = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = box.get()) };
    },
  });
  const s = await setup([mailboxLocal, reader]);
  expect(s.server.app.describe().capabilities["actor.inbox"]).toBeDefined();

  // A message: admitted, Thinking… edited into the answer in its thread.
  await s.post(messageEvent({ space: THREADED, thread: `${THREADED}/threads/T1`, name: `${THREADED}/messages/M1`, text: "hello" }));
  await until(() => (inThread(s.google, `${THREADED}/threads/T1`).some((message) => message.text === "faux: Ada Lovelace: hello") ? true : undefined), "the answer");
  expect(inThread(s.google, `${THREADED}/threads/T1`)).toHaveLength(1);

  // A question drawn, clicked, its answer admitted and run.
  const thread = `${DM}/threads/Q1`;
  const question = { title: "Deploy now?", fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }] };
  await s.post(messageEvent({ space: DM, spaceType: "DIRECT_MESSAGE", thread, text: `call: ${ASK_USER_TOOL} ${JSON.stringify(question)}` }));
  const card = await until(() => inThread(s.google, thread).find((message) => message.cardsV2?.some((each) => each.cardId.startsWith("question:"))), "the question's card");
  const yes = card.cardsV2?.flatMap((each) => each.card.sections?.flatMap((section) => section.widgets.flatMap((widget) => widget.buttonList?.buttons ?? [])) ?? []).find((button) => button.text === "Yes");
  const parameters = Object.fromEntries((yes?.onClick?.action?.parameters ?? []).map((each) => [each.key, each.value]));
  const clicked = await s.post(clickEvent({ space: DM, spaceType: "DIRECT_MESSAGE", message: card, parameters, invokedFunction: s.google.idTokens.audience }));
  expect(clicked.status).toBe(200);
  expect(JSON.stringify(clicked.body)).toContain("Answered by Ada Lovelace");
  await until(() => inThread(s.google, thread).find((message) => message.text?.startsWith("faux: Answer to") === true), "the new run's answer");
  expect(s.server.started.map((run) => run.conversation.key)).toEqual([`googlechat:${THREADED}:threads/T1`, `googlechat:${DM}:threads/Q1`, `googlechat:${DM}:threads/Q1`]);

  // In process: the channel registered no handler with the inbox, so nothing could have gone through the mailbox.
  const ctx = s.server.app.context();
  await expect(mailbox!.send(`googlechat:${THREADED}:threads/T1`, EVENT_TYPE, {}, ctx)).rejects.toThrow(`no actor.inbox handler for the type "${EVENT_TYPE}"`);
  await expect(mailbox!.call(`googlechat:${DM}:threads/Q1`, CLICK_TYPE, {}, ctx)).rejects.toMatchObject({ code: "no_handler" });
}, 30_000);
