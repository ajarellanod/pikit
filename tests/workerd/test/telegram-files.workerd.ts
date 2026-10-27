/**
 * A file sent in Telegram on Cloudflare: channel-telegram-webhook's object half, in a real
 * `PlatformConversation` object composed as the telegram-cloudflare preset composes one (storage-do,
 * storage-kv-sql, actors-do, runtime-pi on the scripted model, conversations-kv, router-basic) with
 * execution-do and tool-read. The update comes from the Worker's App through actors-do's mailbox, as
 * the Worker half sends it; the object downloads the document from Telegram (`getFile`, then the file's
 * URL on `apiBase`) and writes it to the conversation's workspace (execution-do: the object's own SQL)
 * before the message is admitted. The object is evicted before its first alarm and between two runs;
 * the next message has the agent `read` the file, which the tool finds where the text said.
 *
 * Telegram is a fake behind `globalThis.fetch` (the tests and the objects share one isolate). `Date` is
 * a day ahead, so the alarms never fire on their own and each is fired by the test, between which the
 * object is evicted (AGENTS.md, the workerd lesson).
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { type ModelRequest, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import channelTelegramWebhook, { UPDATE_TYPE } from "../../../registry/components/channel-telegram-webhook/files/src/pikit/channel-telegram-webhook/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolRead from "../../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const realFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  await resetObjects();
});

const API = "https://telegram.test";
const TOKEN = "123:test-token";
const USER = { id: 1001, is_bot: false, first_name: "Ada" };
const DAY = 24 * 60 * 60 * 1_000;
const REPORT = "%PDF-1.4 the report's text, kept in the object";

/** The Bot API at `API`: `getFile` and its file's URL serve the one document; `sendMessage` records. */
function fakeTelegram() {
  const sent: string[] = [];
  const downloads: string[] = [];
  const ok = (result: unknown) => Response.json({ ok: true, result });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${API}/file/bot${TOKEN}/documents/f1.pdf`) {
      downloads.push(url);
      return new Response(REPORT, { headers: { "content-type": "application/octet-stream" } });
    }
    if (!url.startsWith(`${API}/bot${TOKEN}/`)) return await realFetch(input, init);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; file_id?: string };
    if (method === "getFile" && body.file_id === "f1") return ok({ file_id: "f1", file_unique_id: "u1", file_size: REPORT.length, file_path: "documents/f1.pdf" });
    if (method === "sendChatAction" || method === "getMe") return ok(method === "getMe" ? { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } : true);
    if (method === "sendMessage") {
      sent.push(String(body.text));
      return ok({ message_id: sent.length });
    }
    return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent, downloads };
}

/** The Worker's App, which hands updates to the objects through `actor.mailbox`, as the channel's Worker half does. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const channel = defineComponent({
    name: "test-channel",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const worker = await defineApp({ components: [actorsDo, channel], config: { "actors-do": { binding: PLATFORM_BINDING } }, logger: silentLogger }).create();
  await worker.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    send: (key: string, messageId: number, fields: Record<string, unknown>) =>
      mailbox?.send(key, UPDATE_TYPE, { update_id: messageId, message: { message_id: messageId, from: USER, chat: { id: USER.id, type: "private" }, date: Math.floor(Date.now() / 1_000), ...fields } }, worker.context()),
    stop: () => worker.stop(),
  };
}

it("a document lands in the conversation's workspace (execution-do, the object's SQL) before admission, survives evictions, and the agent's read finds it at the path it was told", async () => {
  const telegram = fakeTelegram();
  globalThis.fetch = telegram.fetch;
  const requests: ModelRequest[] = [];
  const provider = scriptedProvider({ onRequest: (request) => void requests.push(request) });
  composeObjects(
    [
      storageDo,
      storageKvSql,
      actorsDo,
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => (name === "TELEGRAM_BOT_TOKEN" ? TOKEN : undefined) }) }),
      defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted", tools: ["read"] })) }),
      defineComponent({ name: "provider-faux", setup: (pikit) => pikit.provideKeyed("model.provider", provider.id, provider) }),
      runtimePi,
      conversationsKv,
      routerBasic,
      executionDo,
      toolRead,
      channelTelegramWebhook,
    ],
    { "router-basic": { defaultAgent: "assistant" }, "channel-telegram-webhook": { apiBase: API } },
  );
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY, shouldAdvanceTime: true });
  const worker = await workerApp();
  const key = `telegram:${USER.id}`;
  const object = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(key));
  const saved = () =>
    runInDurableObject(object(), (_instance, state) => ({
      node: state.storage.sql.exec("SELECT kind, size FROM execution_do_nodes WHERE path = '/work/attachments/1/report.pdf'").toArray(),
      text: state.storage.sql
        .exec("SELECT data FROM execution_do_chunks WHERE path = '/work/attachments/1/report.pdf' ORDER BY seq")
        .toArray()
        .map((row) => new TextDecoder().decode(new Uint8Array(row.data as ArrayBuffer)))
        .join(""),
    }));
  /** Fires the object's alarms until `done` holds. */
  const alarmsUntil = (done: () => void) =>
    vi.waitFor(
      async () => {
        await runDurableObjectAlarm(object());
        done();
      },
      { timeout: 15_000, interval: 200 },
    );
  try {
    // The update's send resolves once the object admitted it: the file is in its SQL by then, before any alarm ran.
    await worker.send(key, 1, { caption: "keep this", document: { file_id: "f1", file_name: "report.pdf", mime_type: "application/pdf", file_size: REPORT.length } });
    expect(telegram.downloads).toHaveLength(1);
    expect(await saved()).toEqual({ node: [{ kind: "file", size: REPORT.length }], text: REPORT });

    // Evicted before its run: the next instance runs it from the alarm, the file still there.
    await evictDurableObject(object());
    // The model was told the path (the scripted model answers with what it read; Telegram's format makes the list's "-" a bullet).
    await alarmsUntil(() => expect(telegram.sent).toEqual([expect.stringContaining("report.pdf (application/pdf, 46 bytes): saved in your workspace at attachments/1/report.pdf")]));

    // Between two runs: evicted again; the agent reads the file where it was told.
    await evictDurableObject(object());
    await worker.send(key, 2, { text: 'call: read {"path":"attachments/1/report.pdf"}' });
    await alarmsUntil(() => expect(telegram.sent).toHaveLength(2));
    const results = requests.flatMap((request) => request.messages).filter((message) => message.role === "toolResult" && message.toolName === "read");
    expect(results.map((message) => (message.role === "toolResult" ? message.isError : undefined))).toEqual([false]);
    expect(JSON.stringify(results[0])).toContain("the report's text, kept in the object");
    expect(telegram.downloads).toHaveLength(1);
  } finally {
    await worker.stop();
  }
});
