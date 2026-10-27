/**
 * channel-google-chat on Cloudflare, in workerd: the Worker's half (`channel-google-chat-worker`) in the
 * Worker's App with `actors-do`'s mailbox serves the endpoint, verifies Google's ID token (WebCrypto,
 * RS256 against the JWKs) and hands each event to its conversation's object; the object is a real
 * SQLite-backed `PlatformConversation` composed as the telegram-cloudflare preset composes one, with
 * the default export instead of a Telegram channel: storage-do, storage-kv-sql, actors-do (its
 * `actor.inbox`, scope `"one"`, and `wakeups`), runtime-pi on the scripted model, conversations-kv,
 * router-basic, tool-ask-user and execution-do. The object admits, creates "Thinking…" and edits it
 * into the answer (answer delivery sending directly, its runs in the object's alarms), draws
 * `ask_user`'s question as a card, whose click the Worker asks the object to answer
 * (`actor.mailbox.call`), and writes a message's file that is not an image (a PDF) to its workspace:
 * execution-do's files, in the conversation's object's own SQLite. A command typed in the chat (`/where`,
 * an `agent.command` of the object's App) runs once in its thread's conversation, whose space
 * conversations-kv recorded in the object (the chat's key), and its note is said in the thread.
 *
 * Google is a fake behind `globalThis.fetch` (the tests and the objects share one isolate): its signing
 * keys, its token endpoint (any signed assertion gets a token), the Chat REST API's messages (a
 * `requestId` repeated returns the first message, a `messageId` that exists is refused) and its media. Events are
 * built here as Google posts them: the channel's own fake (`fake-google-chat.test-support.ts`) serves
 * over Bun, which workerd has not.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import channelGoogleChat, { NAME, worker as googleChatWorker, WORKER_NAME } from "../../../registry/components/channel-google-chat/files/src/pikit/channel-google-chat/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolAskUser, { ASK_USER_TOOL } from "../../../registry/components/tool-ask-user/files/src/pikit/tool-ask-user/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetObjects();
});

const API = "https://chat.google.test";
const ACCOUNTS = "https://accounts.google.test";
const AUDIENCE = "https://pikit.test/google-chat";
const PROJECT_NUMBER = "123456789012";
const DM = "spaces/DM1";
const THINKING = "Thinking…";
const USER = { name: "users/1001", displayName: "Ada Lovelace", type: "HUMAN" };

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const base64url = (bytes: Uint8Array): string => base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64url = (text: string): Uint8Array => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const signing = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...header })))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  return `${signing}.${base64url(new Uint8Array(await crypto.subtle.sign(RS256, key, encoder.encode(signing))))}`;
}

interface Message {
  name: string;
  text?: string;
  cardsV2?: { cardId: string; card: { sections?: { widgets: { buttonList?: { buttons: { text: string; onClick?: { action?: { function?: string; parameters?: { key: string; value: string }[] } } }[] } }[] }[] } }[];
  thread?: { name: string };
}

/** Google, behind `fetch`: the ID tokens' keys, the token endpoint, and the Chat API's messages. */
async function fakeGoogle() {
  const signing = (await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const account = (await crypto.subtle.generateKey({ ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
  const kid = "kid-1";
  const jwk = (await crypto.subtle.exportKey("jwk", signing.publicKey)) as JsonWebKey;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", account.privateKey)) as ArrayBuffer);
  const serviceAccount = JSON.stringify({
    type: "service_account",
    client_email: "chat-app@pikit-test.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${(base64(pkcs8).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`,
    token_uri: `${ACCOUNTS}/token`,
  });
  const messages = new Map<string, Message>();
  const requests = new Map<string, string>();
  /** Uploaded files, by their resource name (`attachmentDataRef.resourceName`). */
  const media = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  let made = 0;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === ACCOUNTS && url.pathname === "/certs") return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }, { headers: { "cache-control": "public, max-age=3600" } });
    if (url.origin === ACCOUNTS && url.pathname === "/token") {
      const assertion = String((await request.formData()).get("assertion") ?? "");
      const [header = "", claims = "", signature = ""] = assertion.split(".");
      const valid = await crypto.subtle.verify(RS256, account.publicKey, fromBase64url(signature), encoder.encode(`${header}.${claims}`));
      return valid ? Response.json({ access_token: "ya29.fake", expires_in: 3599, token_type: "Bearer" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.origin !== API) return realFetch(input, init);
    if (request.headers.get("authorization") !== "Bearer ya29.fake") return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    const path = decodeURIComponent(url.pathname).replace(/^\/v1\//, "");
    const body = request.method === "POST" || request.method === "PATCH" ? ((await request.json()) as Message) : undefined;
    calls.push({ method: request.method, path, body });
    const notFound = () => Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } }, { status: 404 });
    if (request.method === "POST" && path.endsWith("/messages")) {
      const space = path.slice(0, -"/messages".length);
      const requestId = url.searchParams.get("requestId");
      const known = requestId === null ? undefined : requests.get(requestId);
      if (known !== undefined && messages.has(known)) return Response.json(messages.get(known));
      const name = `${space}/messages/${url.searchParams.get("messageId") ?? `m${++made}`}`;
      if (messages.has(name)) return Response.json({ error: { code: 409, status: "ALREADY_EXISTS" } }, { status: 409 });
      const message: Message = { ...body, name, thread: body?.thread ?? { name: `${space}/threads/t${++made}` } };
      messages.set(name, message);
      if (requestId !== null) requests.set(requestId, name);
      return Response.json(message);
    }
    if (request.method === "GET" && path.startsWith("media/")) {
      const file = media.get(path.slice("media/".length));
      return file === undefined ? notFound() : new Response(file.bytes, { headers: { "content-type": file.type, "content-length": String(file.bytes.byteLength) } });
    }
    const found = messages.get(path);
    if (request.method === "PATCH") {
      if (found === undefined) return notFound();
      const changed: Message = { ...found };
      for (const field of (url.searchParams.get("updateMask") ?? "").split(",")) (changed as unknown as Record<string, unknown>)[field] = (body as unknown as Record<string, unknown>)[field];
      messages.set(path, changed);
      return Response.json(changed);
    }
    if (request.method === "GET" && /^spaces\/[^/]+$/.test(path)) return Response.json({ name: path, spaceType: "DIRECT_MESSAGE", spaceThreadingState: "THREADED_MESSAGES" });
    if (request.method === "GET") return found === undefined ? notFound() : Response.json(found);
    if (request.method === "DELETE") return messages.delete(path) ? Response.json({}) : notFound();
    return notFound();
  };

  /** An ID token for the app, as Google signs each event's (`overrides` change a claim). */
  const bearer = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const claims = { iss: "https://accounts.google.com", aud: AUDIENCE, email: `service-${PROJECT_NUMBER}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`, email_verified: true, iat: now, exp: now + 3_600, ...overrides };
    return `Bearer ${await signJwt({ kid }, claims, signing.privateKey)}`;
  };
  return { fetch: fetch as typeof globalThis.fetch, serviceAccount, messages, media, calls, bearer };
}

const secretsOf = (values: Record<string, string>) =>
  defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => values[name] }) });

/** A DM as Google has it. */
const space = { name: DM, spaceType: "DIRECT_MESSAGE", singleUserBotDm: true, spaceThreadingState: "THREADED_MESSAGES" };

/** A file uploaded with a message, as Google describes it. */
interface Attachment {
  contentName: string;
  contentType: string;
  attachmentDataRef: { resourceName: string };
  source: "UPLOADED_CONTENT";
}

/** A message to the app in the DM's thread `thread`, as Google posts it, with its `attachment`s. */
const messageEvent = (id: string, thread: string, text: string, attachment: Attachment[] = []) => ({
  commonEventObject: { hostApp: "CHAT" },
  chat: {
    user: USER,
    space,
    eventTime: new Date().toISOString(),
    messagePayload: { space, message: { name: `${DM}/messages/${id}`, sender: USER, text, argumentText: text, thread: { name: `${DM}/threads/${thread}` }, space, ...(attachment.length > 0 && { attachment }) } },
  },
});

/** A conversation's object, by its key, as actors-do reaches it. */
const objectOf = (key: string) => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));

/** A click on a card's button, with its parameters. */
const clickEvent = (message: Message, parameters: Record<string, string>) => ({
  commonEventObject: { hostApp: "CHAT", parameters },
  chat: { user: USER, space, eventTime: new Date().toISOString(), buttonClickedPayload: { space, message } },
});

/** The Worker's App: the channel's Worker half over actors-do's mailbox; its route, called as Workers call it. */
async function workerApp(secrets: Record<string, string>) {
  let route: ((request: Request) => Promise<Response>) | undefined;
  const reader = defineComponent({
    name: "routes-test",
    setup(pikit) {
      const routes = pikit.useKeyed("http.route");
      return {
        start(ctx) {
          const handler = routes.get("POST /google-chat");
          route = handler === undefined ? undefined : async (request) => await handler(request, ctx);
        },
      };
    },
  });
  const app = await defineApp({
    components: [actorsDo, secretsOf(secrets), googleChatWorker, reader],
    config: { "actors-do": { binding: PLATFORM_BINDING }, [WORKER_NAME]: { apiBase: API, jwksUrl: `${ACCOUNTS}/certs` } },
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    async post(event: unknown, authorization: string | null): Promise<{ status: number; body: unknown }> {
      if (route === undefined) throw new Error("the Worker serves no POST /google-chat");
      const response = await route(new Request(AUDIENCE, { method: "POST", headers: { "content-type": "application/json", ...(authorization !== null && { authorization }) }, body: JSON.stringify(event) }));
      const text = await response.text();
      return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
    },
    stop: () => app.stop(),
  };
}

it("the Worker verifies and hands each event to its conversation's object, which admits, writes Thinking… into the answer, draws ask_user's question, whose click it answers, and writes a message's PDF to its workspace (execution-do)", async () => {
  const google = await fakeGoogle();
  globalThis.fetch = google.fetch;
  const secrets = {
    GOOGLE_CHAT_SERVICE_ACCOUNT: google.serviceAccount,
    GOOGLE_CHAT_PROJECT_NUMBER: PROJECT_NUMBER,
    GOOGLE_CHAT_AUDIENCE: AUDIENCE,
    GOOGLE_CHAT_ALLOWED_SPACES: DM,
  };
  const provider = scriptedProvider();
  // Each run of /where: the conversation conversations-kv gave it (its space recorded with its first resolve) and who typed it.
  const where: string[] = [];
  const whereCommand = defineComponent({
    name: "commands-test",
    setup: (pikit) =>
      pikit.provideKeyed("agent.command", "where", {
        description: "Where this conversation is",
        audience: "user",
        async run(conversation, _args, _ctx, sender) {
          const said = `${conversation.key} in ${conversation.space} for ${sender?.id}`;
          where.push(said);
          return { text: said };
        },
      }),
  });
  composeObjects(
    [
      storageDo,
      storageKvSql,
      actorsDo,
      secretsOf(secrets),
      defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted", tools: [ASK_USER_TOOL] })) }),
      defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
      runtimePi,
      conversationsKv,
      routerBasic,
      toolAskUser,
      executionDo,
      whereCommand,
      channelGoogleChat,
    ],
    { "router-basic": { defaultAgent: "assistant" }, [NAME]: { apiBase: API, jwksUrl: `${ACCOUNTS}/certs` } },
  );
  const worker = await workerApp(secrets);
  const inThread = (thread: string) => [...google.messages.values()].filter((message) => message.thread?.name === `${DM}/threads/${thread}`);
  try {
    // A token for another endpoint: 401 in the Worker, and no object is asked anything.
    expect((await worker.post(messageEvent("M0", "T0", "hello"), await google.bearer({ aud: "https://elsewhere.test/google-chat" }))).status).toBe(401);
    expect(google.calls).toEqual([]);

    // A message: acknowledged once its object admitted it; Thinking… created under piece #0's ids, edited into the answer.
    expect(await worker.post(messageEvent("M1", "T1", "hello"), await google.bearer())).toEqual({ status: 200, body: {} });
    await vi.waitFor(() => expect(inThread("T1").map((message) => message.text)).toEqual(["answer: hello"]), { timeout: 15_000 });
    const [answer] = inThread("T1");
    expect(google.calls.find((call) => call.method === "POST" && (call.body as Message).text === THINKING)?.path).toBe(`${DM}/messages`);
    expect(google.calls.filter((call) => call.method === "PATCH" && call.path === answer?.name).map((call) => (call.body as Message).text)).toContain("answer: hello");

    // A command typed in the thread, delivered twice: run once in its conversation, whose space is the chat's key; its note said in the thread.
    const whereSaid = `googlechat:${DM}:threads/T1 in googlechat:${DM} for ${USER.name}`;
    for (let delivery = 0; delivery < 2; delivery++) expect(await worker.post(messageEvent("M4", "T1", "/where"), await google.bearer())).toEqual({ status: 200, body: {} });
    expect(where).toEqual([whereSaid]);
    expect(inThread("T1").map((message) => message.text)).toEqual(["answer: hello", whereSaid]);

    // ask_user: the run ends with the question, drawn as a card in its thread.
    const question = { title: "Deploy now?", fields: [{ kind: "confirm", name: "go", label: "Deploy", required: true }] };
    await worker.post(messageEvent("M2", "Q1", `call: ${ASK_USER_TOOL} ${JSON.stringify(question)}`), await google.bearer());
    const card = await vi.waitFor(
      () => {
        const found = inThread("Q1").find((message) => message.cardsV2?.some((each) => each.cardId.startsWith("question:")));
        expect(found).toBeDefined();
        return found as Message;
      },
      { timeout: 15_000 },
    );
    const yes = card.cardsV2?.flatMap((each) => each.card.sections?.flatMap((section) => section.widgets.flatMap((widget) => widget.buttonList?.buttons ?? [])) ?? []).find((button) => button.text === "Yes");
    expect(yes?.onClick?.action?.function).toBe(AUDIENCE);
    const parameters = Object.fromEntries((yes?.onClick?.action?.parameters ?? []).map((each) => [each.key, each.value]));
    expect(parameters.key).toBe(`googlechat:${DM}:threads/Q1`);

    // The click: the Worker calls the object, which admits the answer and gives the card updated.
    const clicked = await worker.post(clickEvent(card, parameters), await google.bearer());
    expect(clicked.status).toBe(200);
    expect(JSON.stringify(clicked.body)).toContain("Answered by Ada Lovelace");
    await vi.waitFor(() => expect(inThread("Q1").some((message) => message.text?.startsWith("answer: Answer to \"Deploy now?\"") === true)).toBe(true), { timeout: 15_000 });
    // Clicked again: told, nothing admitted.
    expect(JSON.stringify((await worker.post(clickEvent(card, { ...parameters, value: "false" }), await google.bearer())).body)).toContain("already answered");

    // A PDF with a message: written to the conversation's workspace (execution-do, in its object's SQLite), and named to the model.
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    google.media.set(`${DM}/attachments/report`, { bytes: pdf, type: "application/pdf" });
    const report: Attachment = { contentName: "report.pdf", contentType: "application/pdf", attachmentDataRef: { resourceName: `${DM}/attachments/report` }, source: "UPLOADED_CONTENT" };
    expect(await worker.post(messageEvent("M3", "F1", "read this", [report]), await google.bearer())).toEqual({ status: 200, body: {} });
    await vi.waitFor(() => expect(inThread("F1").map((message) => message.text)).toEqual([expect.stringContaining("report.pdf (application/pdf, 6 bytes): saved in your workspace at attachments/M3/report.pdf")]), {
      timeout: 15_000,
    });
    const saved = await runInDurableObject(objectOf(`googlechat:${DM}:threads/F1`), async (_instance, state) => ({
      node: state.storage.sql.exec("SELECT kind, size FROM execution_do_nodes WHERE path = '/work/attachments/M3/report.pdf'").toArray(),
      bytes: state.storage.sql.exec("SELECT data FROM execution_do_chunks WHERE path = '/work/attachments/M3/report.pdf' ORDER BY seq").toArray().map((row) => [...new Uint8Array(row.data as ArrayBuffer)]),
    }));
    expect(saved).toEqual({ node: [{ kind: "file", size: 6 }], bytes: [[...pdf]] });
  } finally {
    await worker.stop();
  }
});
