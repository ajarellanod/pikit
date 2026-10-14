// Owner: transport. The access token, the REST client, both ids, markdown as Chat draws it, the transport and the placeholder, against the fake Google.
/**
 * - auth.ts: a signed assertion exchanged once, kept until a minute before it expires, one exchange
 *   for concurrent callers; a wrong key refused, `permanent`, never quoted.
 * - api.ts: each call as Google takes it; failures as `ChatApiError`, classified by `deliveryErrorOf`.
 * - ids.ts, format.ts: the ids; text, cards, images; pieces cut on paragraphs, never inside code or a
 *   table, and to fit Google's 32,000 bytes.
 * - transport.ts and placeholder.ts: piece `#0` edits "Thinking…" (created when missing), the others
 *   are created in the thread, a late repeat is read back, drawn questions are cards, each failure
 *   classified; previews throttled and never after the answer; what a run with nothing to say leaves
 *   is deleted, at its end or by the sweep.
 */

import { afterEach, expect, test } from "bun:test";
import { type AppContext, defineApp, silentLogger } from "@pikit/core";
import { createManualClock, type ManualClock } from "@pikit/core/testing";
import { answerKey, type ConversationRef, DeliveryError, messagePieces, type OutboundPiece, questionPart, type RunSettlement } from "@pikit/contracts";
import { createMemoryKeyValueStorage, createMemorySubmissions } from "@pikit/contracts/testing";
import { CALL_TIMEOUT_MS, createChatApi, deliveryErrorOf } from "./api.ts";
import { CHAT_SCOPE, createAccessTokens } from "./auth.ts";
import { type FakeGoogleChat, googleError, startFakeGoogleChat, verifyJwt, createTestServiceAccount } from "./fake-google-chat.test-support.ts";
import { chatMessageOf, chatTextOf, MESSAGE_BYTES, PIECE_CHARS, splitAnswer } from "./format.ts";
import { messageNameOf, pieceIds } from "./ids.ts";
import { instancesOf, parseConversationKey, readCredentials } from "./instance.ts";
import { createPlaceholderMarks, createPlaceholders } from "./placeholder.ts";
import { createTransport, DRAWS } from "./transport.ts";
import { type AnswerTargets, ChatApiError, type QuestionRecord, type QuestionRecords } from "./types.ts";

const fakes: FakeGoogleChat[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

const [INSTANCE, OPS] = instancesOf(["ops"]) as [ReturnType<typeof instancesOf>[number], ReturnType<typeof instancesOf>[number]];
const THREAD = "spaces/AAA/threads/T1";
const conversation: ConversationRef = { key: `googlechat:${"spaces/AAA"}:threads/T1`, agent: "assistant", conversationId: "conv-1" };

/** Where answers go, read from the key (a whole chat's thread is admission's, not tested here). */
const targets: AnswerTargets = {
  remember: async () => {},
  of: async (key) => {
    const parts = parseConversationKey(key);
    return parts === undefined ? undefined : { space: parts.space, ...(parts.thread !== undefined && { thread: parts.thread }) };
  },
};

async function contextOf(): Promise<AppContext> {
  return (await defineApp({ components: [], logger: silentLogger }).create()).context();
}

async function setup(options: { previewEveryMs?: number } = {}) {
  const clock: ManualClock = createManualClock(Date.now());
  const google = await startFakeGoogleChat({ now: () => clock.now() });
  fakes.push(google);
  const credentials = await readCredentials(INSTANCE, async (name) => google.secrets(["spaces/AAA"])[name]);
  const tokens = createAccessTokens(credentials.serviceAccount, { clock, fetch: google.fetch });
  const api = createChatApi({ apiBase: google.apiBase, tokens, fetch: google.fetch });
  const store = createMemoryKeyValueStorage().namespace("channel-google-chat");
  const marks = createPlaceholderMarks(store);
  const memory = createMemorySubmissions();
  const recorded: Omit<QuestionRecord, "answered">[] = [];
  const questions: QuestionRecords = { sent: async (record) => void recorded.push(record), get: async () => undefined, answer: async () => false };
  const placeholders = createPlaceholders({ instance: INSTANCE, api, targets, marks, submissions: memory.submissions, thinkingText: "Thinking…", previewEveryMs: options.previewEveryMs ?? 3_000, clock });
  const transport = createTransport({
    instance: INSTANCE,
    credentials,
    api,
    targets,
    marks,
    questions,
    drawQuestion: (question, endpoint, conversationKey) => ({ cardId: `question-${question.id}`, card: { header: { title: question.title, subtitle: endpoint }, sections: [{ widgets: [{ textParagraph: { text: conversationKey } }] }] } }),
  });
  const ctx = await contextOf();
  const send = (index: number, text: string, extra: Partial<OutboundPiece> = {}, signal = new AbortController().signal) =>
    transport.send({ key: `${answerKey(conversation, "r1")}#${index}`, conversationKey: conversation.key, text, possibleDuplicate: false, ...extra }, signal);
  return { clock, google, credentials, tokens, api, store, marks, memory, recorded, placeholders, transport, ctx, send };
}

/** Why `promise` rejected. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("it resolved");
}

const messageCalls = (google: FakeGoogleChat, method: string) => google.callsTo({ method, path: /^\/v1\/spaces\/AAA\/messages/ });

// ---------------------------------------------------------------------------------------------------
// ids.ts

test("ids: a UUID requestId and a client- messageId of 56 hex characters, both from the piece key's SHA-256", async () => {
  const ids = await pieceIds("conv-1:r1#0");
  expect(ids.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ids.messageId).toMatch(/^client-[0-9a-f]{56}$/);
  expect(ids.messageId).toHaveLength(63);
  expect(await pieceIds("conv-1:r1#0")).toEqual(ids);
  const other = await pieceIds("conv-1:r1#1");
  expect(other.requestId).not.toBe(ids.requestId);
  expect(other.messageId).not.toBe(ids.messageId);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("conv-1:r1#0")));
  expect(ids.messageId.slice(7)).toBe(Buffer.from(hash).toString("hex").slice(0, 56));
});

// ---------------------------------------------------------------------------------------------------
// auth.ts

test("auth: an RS256 assertion for chat.bot, exchanged once, kept until a minute before it expires, shared by concurrent callers", async () => {
  const { google, tokens, clock } = await setup();
  const [first, second, third] = await Promise.all([tokens.token(), tokens.token(), tokens.token()]);
  expect(google.tokensIssued).toBe(1);
  expect(new Set([first, second, third]).size).toBe(1);
  const exchange = google.callsTo({ path: "/token" })[0];
  const assertion = new URLSearchParams(String(exchange?.body)).get("assertion") ?? "";
  const verified = await verifyJwt(assertion, google.serviceAccount.publicKey);
  expect(verified?.header).toMatchObject({ alg: "RS256", kid: google.serviceAccount.keyId });
  expect(verified?.claims).toMatchObject({ iss: google.serviceAccount.clientEmail, scope: CHAT_SCOPE, aud: google.tokenUri, iat: Math.floor(clock.now() / 1000) });

  await clock.advance(3_599_000 - 61_000);
  expect(await tokens.token()).toBe(first);
  await clock.advance(2_000);
  expect(await tokens.token()).not.toBe(first);
  expect(google.tokensIssued).toBe(2);
});

test("auth: a key Google does not know is refused, permanent, and its error quotes neither the key nor the assertion", async () => {
  const { google, clock } = await setup();
  const stranger = await createTestServiceAccount(google.tokenUri);
  const [main] = instancesOf([]);
  const credentials = await readCredentials(main!, async (name) => ({ ...google.secrets(), GOOGLE_CHAT_SERVICE_ACCOUNT: stranger.json })[name]);
  const tokens = createAccessTokens(credentials.serviceAccount, { clock, fetch: google.fetch });
  const error = await failureOf(tokens.token());
  expect(error).toBeInstanceOf(ChatApiError);
  expect(error).toMatchObject({ status: 400, code: "invalid_grant" });
  expect((error as Error).message).not.toContain("PRIVATE KEY");
  expect((error as Error).message).not.toContain(new URLSearchParams(String(google.callsTo({ path: "/token" })[0]?.body)).get("assertion"));
  expect(deliveryErrorOf(error).kind).toBe("permanent");

  const broken = createAccessTokens({ ...credentials.serviceAccount, private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, { clock, fetch: google.fetch });
  expect(await failureOf(broken.token())).toMatchObject({ status: 400 });
  google.fail({ path: "/token" }, "network");
  const unreachable = createAccessTokens(credentials.serviceAccount, { clock, fetch: google.fetch });
  expect(await failureOf(unreachable.token())).toMatchObject({ status: 0 });
});

// ---------------------------------------------------------------------------------------------------
// api.ts

test("api: messages created in a thread with both ids, patched by mask, read, deleted; a space read", async () => {
  const { google, api } = await setup();
  const created = await api.createMessage("spaces/AAA", { text: "hi" }, { thread: THREAD, requestId: "0b5e9d1c-1f5a-4c39-8a39-3d4f5e6a7b8c", messageId: "client-abc" });
  expect(created).toMatchObject({ name: "spaces/AAA/messages/client-abc", thread: { name: THREAD }, text: "hi" });
  const post = messageCalls(google, "POST")[0];
  expect(post?.query).toEqual({ requestId: "0b5e9d1c-1f5a-4c39-8a39-3d4f5e6a7b8c", messageId: "client-abc", messageReplyOption: "REPLY_MESSAGE_OR_FAIL" });
  expect(post?.body).toEqual({ text: "hi", thread: { name: THREAD } });
  expect(post?.authorization).toMatch(/^Bearer ya29\./);

  await api.createMessage("spaces/AAA", { text: "top" }, {});
  expect(messageCalls(google, "POST")[1]?.query).toEqual({});

  const patched = await api.updateMessage(created.name!, { text: "edited" }, ["text", "cardsV2"]);
  expect(patched).toMatchObject({ text: "edited", cardsV2: [] });
  expect(messageCalls(google, "PATCH")[0]).toMatchObject({ query: { updateMask: "text,cardsV2" }, body: { text: "edited", cardsV2: [] } });
  expect(await api.getMessage(created.name!)).toMatchObject({ text: "edited" });
  await api.deleteMessage(created.name!);
  expect(await failureOf(api.getMessage(created.name!))).toMatchObject({ status: 404, code: "NOT_FOUND" });
  expect(await api.getSpace("spaces/AAA")).toMatchObject({ name: "spaces/AAA", spaceThreadingState: "THREADED_MESSAGES" });
});

test("api: media downloaded with alt=media, refused (413, not sent) past maxBytes", async () => {
  const { google, api } = await setup();
  google.addMedia("spaces/AAA/attachments/a+b=", "x".repeat(1000), "text/plain");
  const media = await api.downloadMedia("spaces/AAA/attachments/a+b=", 1000);
  expect([media.bytes.byteLength, media.contentType]).toEqual([1000, "text/plain"]);
  expect(google.callsTo({ path: "/v1/media/spaces/AAA/attachments/a+b=" })[0]?.query).toEqual({ alt: "media" });
  expect(await failureOf(api.downloadMedia("spaces/AAA/attachments/a+b=", 999))).toMatchObject({ status: 413, maybeSent: false });
  expect(await failureOf(api.downloadMedia("spaces/AAA/attachments/none", 999))).toMatchObject({ status: 404 });
});

test("api: failures as ChatApiError: Google's status and words, a 429's Retry-After, a network error, a cut call that may have arrived", async () => {
  const { google, api } = await setup();
  google.fail({ method: "GET" }, { ...googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"), headers: { "retry-after": "7" } });
  expect(await failureOf(api.getSpace("spaces/AAA"))).toMatchObject({ status: 429, code: "RESOURCE_EXHAUSTED", retryAfterMs: 7_000 });
  google.fail({ method: "GET" }, "network");
  expect(await failureOf(api.getSpace("spaces/AAA"))).toMatchObject({ status: 0, maybeSent: false });
  google.fail({ method: "GET" }, "hang");
  const cut = new AbortController();
  const hanging = api.getSpace("spaces/AAA", cut.signal);
  await google.waitForCall({ method: "GET", path: "/v1/spaces/AAA" }, { after: google.calls.length });
  cut.abort();
  expect(await failureOf(hanging)).toMatchObject({ status: 0, maybeSent: true });
  expect(CALL_TIMEOUT_MS).toBeLessThan(30_000);
});

test("deliveryErrorOf: 429 rate_limited, network and 5xx transient (maybeSent kept), 400/401/403/404 permanent, anything else transient", () => {
  const of = (status: number, options: ConstructorParameters<typeof ChatApiError>[2] = {}) => deliveryErrorOf(new ChatApiError(status, `HTTP ${status}`, options));
  expect(of(429, { retryAfterMs: 2_000 })).toMatchObject({ kind: "rate_limited", retryAfterMs: 2_000 });
  expect(of(0, { maybeSent: true })).toMatchObject({ kind: "transient", maybeSent: true });
  expect(of(0)).toMatchObject({ kind: "transient", maybeSent: false });
  for (const status of [500, 502, 503]) expect(of(status).kind).toBe("transient");
  for (const status of [400, 401, 403, 404]) expect(of(status).kind).toBe("permanent");
  expect(of(409).kind).toBe("transient");
  expect(deliveryErrorOf(new Error("boom")).kind).toBe("transient");
  const given = new DeliveryError("permanent", "said");
  expect(deliveryErrorOf(given)).toBe(given);
});

// ---------------------------------------------------------------------------------------------------
// format.ts

test("format: markdown as Google Chat text: bold, italic, strike, code, links, lists, headings; URLs and identifiers untouched", () => {
  const md = [
    "# Title",
    "**bold**, __bold__, *it*, _it_, ~~gone~~, `a_b*c`, [docs](https://example.com/a_b?x=1) and https://example.com/snake_case_x.",
    "snake_case_name stays, 2 * 3 = 6, \\*literal\\*",
    "- one",
    "* **two**",
    "  + nested",
    "1. first",
    "2) second",
    "> quoted",
    "",
    "Setext",
    "------",
  ].join("\n");
  expect(chatMessageOf(md)).toEqual({
    text: [
      "*Title*",
      "*bold*, *bold*, _it_, _it_, ~gone~, `a_b*c`, <https://example.com/a_b?x=1|docs> and https://example.com/snake_case_x.",
      "snake_case_name stays, 2 * 3 = 6, *literal*",
      "• one",
      "• *two*",
      "  • nested",
      "1. first",
      "2. second",
      "> quoted",
      "",
      "*Setext*",
    ].join("\n"),
    cardsV2: [],
  });
});

test("format: tables and code blocks as monospace cards in order, the text after a card in it, public images as image cards", () => {
  const md = [
    "Here:",
    "",
    "| name | n |",
    "|:-----|--:|",
    "| **a** | 1 |",
    "| [bb](https://example.com) | 22 |",
    "",
    "```ts",
    "if (a < b && c) {}",
    "```",
    "After the code, **bold** <tag>.",
    "",
    "![a cat](https://img.example.com/cat.png) ![local](./x.png) ![plain](http://example.com/p.png)",
  ].join("\n");
  const { text, cardsV2 } = chatMessageOf(md);
  expect(text).toBe("Here:");
  expect(cardsV2).toEqual([
    { cardId: "block-1", card: { sections: [{ widgets: [{ textParagraph: { text: "<pre>name | n\n-----+---\na    | 1\nbb   | 22</pre>" } }] }] } },
    {
      cardId: "block-2",
      card: {
        sections: [
          {
            header: "ts",
            widgets: [
              { textParagraph: { text: "<pre>if (a &lt; b &amp;&amp; c) {}</pre>" } },
              { textParagraph: { text: "After the code, <b>bold</b> &lt;tag&gt;." } },
              { textParagraph: { text: 'local <a href="http://example.com/p.png">plain</a>' } },
            ],
          },
        ],
      },
    },
    { cardId: "block-3", card: { sections: [{ widgets: [{ image: { imageUrl: "https://img.example.com/cat.png", altText: "a cat" } }] }] } },
  ]);
  // Without a card before it, an image is a card after the text.
  expect(chatMessageOf("Look ![x](https://img.example.com/x.png)")).toEqual({
    text: "Look",
    cardsV2: [{ cardId: "block-1", card: { sections: [{ widgets: [{ image: { imageUrl: "https://img.example.com/x.png", altText: "x" } }] }] } }],
  });
  // A preview: code and tables as Chat's monospace blocks, images as links.
  expect(chatTextOf(md)).toBe(
    ["Here:", "```\nname | n\n-----+---\na    | 1\nbb   | 22\n```", "```\nif (a < b && c) {}\n```", "After the code, *bold* <tag>.", "<https://img.example.com/cat.png|a cat> local <http://example.com/p.png|plain>"].join("\n\n"),
  );
  // An unclosed fence (an answer being written) runs to the end.
  expect(chatTextOf("so:\n```\nconst a = 1;")).toBe("so:\n\n```\nconst a = 1;\n```");
});

test("split: 4096 characters at most, on a paragraph, else a line, else a space; never inside a code block or a table", () => {
  expect(splitAnswer("short")).toEqual(["short"]);
  expect(splitAnswer("")).toEqual([]);
  expect(splitAnswer("one\n\ntwo\n\nthree", 10)).toEqual(["one\n\ntwo", "three"]);
  expect(splitAnswer("aaaa bbbb\ncccc dddd", 12)).toEqual(["aaaa bbbb", "cccc dddd"]);
  expect(splitAnswer("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb", "cccc"]);
  const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
  const pieces = splitAnswer(words);
  expect(pieces.every((piece) => piece.length <= PIECE_CHARS)).toBe(true);
  expect(pieces.join(" ")).toBe(words);

  const code = `\`\`\`\n${"x = 1\n".repeat(200)}\`\`\``;
  const table = `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(100)}`.trimEnd();
  const md = `intro\n\n${code}\n\n${table}\n\nend`;
  const cut = splitAnswer(md, 1_000);
  expect(cut).toEqual(["intro", code, table, "end"]);
});

test("split: a piece whose message would pass 32,000 bytes is cut further: a code block's lines fenced again, a table's rows under their header", () => {
  const code = `\`\`\`js\n${"<<<<<<<<<<\n".repeat(2_000)}\`\`\``;
  const pieces = splitAnswer(code);
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces) {
    expect(piece).toMatch(/^```js\n[\s\S]*\n```$/);
    expect(new TextEncoder().encode(JSON.stringify(chatMessageOf(piece))).byteLength).toBeLessThanOrEqual(MESSAGE_BYTES);
  }
  expect(pieces.map((piece) => piece.slice(6, -4)).join("\n")).toBe("<<<<<<<<<<\n".repeat(2_000).slice(0, -1));

  const wide = `| a | b |\n|---|---|\n${`| ${"&".repeat(300)} | ${"é".repeat(300)} |\n`.repeat(40)}`.trimEnd();
  const rows = splitAnswer(wide, 100_000);
  expect(rows.length).toBeGreaterThan(1);
  for (const piece of rows) {
    expect(piece.startsWith("| a | b |\n|---|---|\n")).toBe(true);
    expect(() => chatMessageOf(piece)).not.toThrow();
  }
  expect(() => chatMessageOf(code)).toThrow(/more than Google takes/);
});

// ---------------------------------------------------------------------------------------------------
// transport.ts and placeholder.ts

test("transport: idempotent, draws questions, splits as format.ts does", async () => {
  const { transport } = await setup();
  expect(transport.idempotent).toBe(true);
  expect(transport.draws).toEqual(DRAWS);
  expect(DRAWS).toEqual(["question"]);
  expect(transport.split("a\n\nb")).toEqual(["a\n\nb"]);
});

test("the placeholder: Thinking… in the thread under piece #0's messageId, marked; a resumed run makes no second one; piece #0 edits it into the answer", async () => {
  const { google, placeholders, ctx, send, marks } = await setup();
  await placeholders.started({ conversation, requestId: "r1", resumed: false }, ctx);
  const ids = await pieceIds(`${answerKey(conversation, "r1")}#0`);
  const name = messageNameOf("spaces/AAA", ids.messageId);
  expect(google.messages.get(name)).toMatchObject({ text: "Thinking…", thread: { name: THREAD } });
  expect(messageCalls(google, "POST")[0]?.query).toMatchObject({ requestId: ids.requestId, messageId: ids.messageId, messageReplyOption: "REPLY_MESSAGE_OR_FAIL" });
  expect(await marks.list()).toEqual([expect.objectContaining({ answerKey: answerKey(conversation, "r1"), conversationKey: conversation.key, requestId: "r1", message: name })]);

  google.forgetRequests();
  await placeholders.started({ conversation, requestId: "r1", resumed: true }, ctx);
  expect([...google.messages.keys()]).toEqual([name]);

  expect(await send(0, "The **answer**.")).toEqual({ platformMessageId: name });
  expect(google.messages.get(name)).toMatchObject({ text: "The *answer*.", cardsV2: [] });
  expect(messageCalls(google, "PATCH")[0]?.query).toEqual({ updateMask: "text,cardsV2" });
  expect(await marks.list()).toEqual([]);
  // Sent again (a retry): the same message, edited again.
  expect(await send(0, "The **answer**.", { possibleDuplicate: true })).toEqual({ platformMessageId: name });
  expect(google.messages.size).toBe(1);
});

test("transport: piece #0 creates its message when there is no placeholder; the others are created in the thread; a late repeat is read back, delivered", async () => {
  const { google, send } = await setup();
  const first = await send(0, "one");
  const second = await send(1, "two");
  const ids = await pieceIds(`${answerKey(conversation, "r1")}#1`);
  expect(second.platformMessageId).toBe(messageNameOf("spaces/AAA", ids.messageId));
  expect(google.messages.get(first.platformMessageId)).toMatchObject({ text: "one", thread: { name: THREAD } });
  expect(google.messages.get(second.platformMessageId)).toMatchObject({ text: "two", thread: { name: THREAD } });
  expect(messageCalls(google, "POST").map((call) => call.query.messageReplyOption)).toEqual(["REPLY_MESSAGE_OR_FAIL", "REPLY_MESSAGE_OR_FAIL"]);

  // A quick repeat: Google returns the first by its requestId.
  expect(await send(1, "two")).toEqual(second);
  // A late one: refused by its messageId, read back.
  google.forgetRequests();
  expect(await send(1, "two")).toEqual(second);
  expect(google.callsTo({ method: "GET", path: `/v1/${second.platformMessageId}` })).toHaveLength(1);
  expect(google.messages.size).toBe(2);
});

test("transport: when Google hands back the placeholder for piece #0's requestId, it is edited into the answer", async () => {
  const { google, placeholders, ctx, send } = await setup();
  await placeholders.started({ conversation, requestId: "r1", resumed: false }, ctx);
  google.fail({ method: "PATCH" }, googleError(404, "NOT_FOUND", "Requested entity was not found."));
  const sent = await send(0, "the answer");
  expect(google.messages.get(sent.platformMessageId)?.text).toBe("the answer");
  expect(google.messages.size).toBe(1);
});

test("transport: a piece of no text and a drawn question is the question's card, recorded under its message", async () => {
  const { google, transport, recorded } = await setup();
  const question = questionPart({ id: "conv-1:r1:t1", title: "Deploy?", fields: [{ name: "ok", label: "Deploy now?", kind: "confirm" }] });
  const pieces = messagePieces(transport, { text: "", parts: [question] });
  expect(pieces).toEqual([{ text: "", parts: [question] }]);
  const sent = await transport.send({ key: `${answerKey(conversation, "r1")}#0`, conversationKey: conversation.key, possibleDuplicate: false, ...pieces[0]! }, new AbortController().signal);
  expect(google.messages.get(sent.platformMessageId)).toMatchObject({ text: "", cardsV2: [{ cardId: "question-conv-1:r1:t1", card: { header: { title: "Deploy?", subtitle: google.idTokens.audience }, sections: [{ widgets: [{ textParagraph: { text: conversation.key } }] }] } }] });
  expect(recorded).toEqual([{ question, message: sent.platformMessageId, conversationKey: conversation.key, answerKey: answerKey(conversation, "r1") }]);
});

test("transport: failures classified: 429 rate_limited with Retry-After, 5xx and the network transient, a cut send may have arrived, 403 and a removed space permanent, a stranger key permanent", async () => {
  const { google, send } = await setup();
  const creates = { method: "POST", path: /\/messages$/ };
  google.fail(creates, { ...googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded"), headers: { "retry-after": "7" } });
  expect(await failureOf(send(1, "x"))).toMatchObject({ name: "DeliveryError", kind: "rate_limited", retryAfterMs: 7_000 });
  google.fail(creates, googleError(503, "UNAVAILABLE", "The service is unavailable."));
  expect(await failureOf(send(1, "x"))).toMatchObject({ kind: "transient", maybeSent: false });
  google.fail(creates, "network");
  expect(await failureOf(send(1, "x"))).toMatchObject({ kind: "transient", maybeSent: false });
  google.fail(creates, "hang");
  const cut = new AbortController();
  const hanging = send(1, "x", {}, cut.signal);
  await google.waitForCall(creates, { after: google.calls.length });
  cut.abort();
  expect(await failureOf(hanging)).toMatchObject({ kind: "transient", maybeSent: true });
  google.fail(creates, googleError(403, "PERMISSION_DENIED", "The caller does not have permission"));
  const denied = await failureOf(send(1, "secret words"));
  expect(denied).toMatchObject({ kind: "permanent" });
  expect((denied as Error).message).not.toContain("secret words");
  google.removeSpace("spaces/AAA");
  expect(await failureOf(send(0, "x"))).toMatchObject({ kind: "permanent" });
  const elsewhere = await failureOf(send(0, "x", { conversationKey: "telegram:1" }));
  expect(elsewhere).toBeInstanceOf(DeliveryError);
  expect(elsewhere).toMatchObject({ kind: "permanent" });
});

test("previews: the answer so far, at most every previewEveryMs, never after piece #0; 0 keeps Thinking…", async () => {
  const { google, placeholders, ctx, clock, send } = await setup({ previewEveryMs: 3_000 });
  await placeholders.started({ conversation, requestId: "r1", resumed: false }, ctx);
  const name = messageNameOf("spaces/AAA", (await pieceIds(`${answerKey(conversation, "r1")}#0`)).messageId);
  const partial = (text: string) => placeholders.partial({ conversation, requestId: "r1", text }, ctx);

  await partial("The **ans");
  expect(messageCalls(google, "PATCH")).toHaveLength(0);
  await clock.advance(3_000);
  await partial("The **answer** so");
  expect(google.messages.get(name)?.text).toBe("The *answer* so");
  expect(messageCalls(google, "PATCH")[0]?.query).toEqual({ updateMask: "text" });
  await clock.advance(1_000);
  await partial("The **answer** so far");
  expect(messageCalls(google, "PATCH")).toHaveLength(1);
  await clock.advance(2_000);
  await partial("x".repeat(5_000));
  expect(google.messages.get(name)?.text).toBe("x".repeat(PIECE_CHARS));
  // Another run's partial, whose placeholder this process did not make: nothing.
  await placeholders.partial({ conversation, requestId: "r9", text: "other" }, ctx);
  expect(messageCalls(google, "PATCH")).toHaveLength(2);

  await send(0, "final");
  await clock.advance(10_000);
  await partial("late preview");
  expect(google.messages.get(name)?.text).toBe("final");

  const quiet = await setup({ previewEveryMs: 0 });
  await quiet.placeholders.started({ conversation, requestId: "r1", resumed: false }, quiet.ctx);
  await quiet.clock.advance(10_000);
  await quiet.placeholders.partial({ conversation, requestId: "r1", text: "so far" }, quiet.ctx);
  expect(messageCalls(quiet.google, "PATCH")).toHaveLength(0);
});

const settlement = (kind: RunSettlement["kind"], text?: string, requestId = "r1", on: ConversationRef = conversation): RunSettlement => ({
  conversation: on,
  requestId,
  requestIds: [requestId],
  kind,
  ...(text !== undefined && { text }),
  ...(kind === "failed" && { error: { code: "model_error", message: "boom" } }),
});

test("settled: a run with nothing to send deletes its placeholder and its mark; an answer or a failure leaves it to delivery; no preview after", async () => {
  for (const [kind, text, deleted] of [
    ["aborted", undefined, true],
    ["completed", "  ", true],
    ["completed", "the answer", false],
    ["failed", undefined, false],
  ] as const) {
    const { google, placeholders, ctx, marks, clock } = await setup();
    await placeholders.started({ conversation, requestId: "r1", resumed: false }, ctx);
    await placeholders.settled({ ...settlement(kind, text), messages: [] }, ctx);
    expect(google.messages.size).toBe(deleted ? 0 : 1);
    expect((await marks.list()).length).toBe(deleted ? 0 : 1);
    await clock.advance(10_000);
    await placeholders.partial({ conversation, requestId: "r1", text: "late" }, ctx);
    expect(messageCalls(google, "PATCH")).toHaveLength(0);
  }
});

test("sweep: a crash's placeholders whose run settled with nothing to send are deleted; a pending run's kept; the others' marks dropped; another app's untouched", async () => {
  const { google, placeholders, ctx, marks, memory, api, clock } = await setup();
  const runs = ["aborted", "pending", "answered", "unknown"] as const;
  for (const requestId of runs) await placeholders.started({ conversation, requestId, resumed: false }, ctx);
  const ops: ConversationRef = { key: "googlechat:ops:spaces/AAA", agent: "assistant", conversationId: "conv-ops" };
  await marks.add({ answerKey: answerKey(ops, "o1"), conversationKey: ops.key, conversationId: ops.conversationId, requestId: "o1", message: "spaces/AAA/messages/client-ops", at: clock.now() });
  for (const requestId of ["aborted", "pending", "answered"]) await memory.submissions.admitted(conversation, requestId, ctx);
  await memory.submissions.settled(settlement("aborted", undefined, "aborted"), ctx);
  await memory.submissions.settled(settlement("completed", "yes", "answered"), ctx);
  const nameOf = async (requestId: string) => messageNameOf("spaces/AAA", (await pieceIds(`${answerKey(conversation, requestId)}#0`)).messageId);

  // A new process: nothing in memory, the marks in storage.
  const restarted = createPlaceholders({ instance: INSTANCE, api, targets, marks, submissions: memory.submissions, thinkingText: "Thinking…", previewEveryMs: 3_000, clock });
  await restarted.sweep(ctx);
  expect(google.messages.has(await nameOf("aborted"))).toBe(false);
  expect(google.messages.has(await nameOf("pending"))).toBe(true);
  expect(google.messages.has(await nameOf("answered"))).toBe(true);
  expect(google.messages.has(await nameOf("unknown"))).toBe(true);
  expect((await marks.list()).map((mark) => mark.requestId).sort()).toEqual(["o1", "pending"]);

  // A failure: rejects to be run again, after trying every mark.
  await memory.submissions.settled(settlement("aborted", undefined, "pending"), ctx);
  google.fail({ method: "DELETE" }, googleError(503, "UNAVAILABLE", "try later"));
  expect(await failureOf(restarted.sweep(ctx))).toBeInstanceOf(ChatApiError);
  await restarted.sweep(ctx);
  expect(google.messages.has(await nameOf("pending"))).toBe(false);
  expect((await marks.list()).map((mark) => mark.requestId)).toEqual(["o1"]);
  expect(OPS.instance).toBe("googlechat:ops");
});
