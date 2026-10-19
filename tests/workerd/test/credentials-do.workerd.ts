/**
 * credentials-do on Cloudflare, in real Durable Objects (deployment-cloudflare's `Conversation` class,
 * as `PlatformConversation`, `src/platform.ts`): the objects' App has storage-do, actors-do,
 * provider-anthropic, credentials-do, an agent on `anthropic/claude-sonnet-4-6` and runtime-pi; the
 * Worker's App serves credentials-do's Worker half through deployment-cloudflare's own server.
 *
 * An operator uploads a Claude subscription login whose access token has expired (the owner object,
 * `credentials-do`, starts with nothing stored: runtime-pi only warns). Two conversations' objects then
 * ask their model at once (`model.complete`): one refreshes the token, under the owner's lock, through
 * pi-ai's own Anthropic flow against a fake of the OAuth token endpoint; both answer with the new
 * access token; the rotated tokens are in the owner object's SQLite. Anthropic is a fake behind the
 * isolate's `fetch`, which the test and the objects share: nothing reaches the network.
 *
 * What this lane cannot show is the bundle: its module runner resolves pi-ai's variable `import()` of
 * the OAuth flow at run time, as a deployed Worker would not. `packages/pi-adapter/src/oauth-flows.test.ts`
 * bundles a Worker with wrangler and refreshes in workerd for that.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type AdminAuth, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import credentialsDo, { CREDENTIALS_KEY, worker as credentialsDoWorker } from "../../../registry/components/credentials-do/files/src/pikit/credentials-do/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import providerAnthropic from "../../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const EXPIRED_ACCESS = "sk-ant-oat01-expired-access";
const REFRESH = "sk-ant-ort01-first-refresh";
const NEW_ACCESS = "sk-ant-oat01-refreshed-access";
const NEW_REFRESH = "sk-ant-ort01-rotated-refresh";

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetObjects();
});

interface Seen {
  refreshes: Record<string, unknown>[];
  /** The credential each Messages request carried (`x-api-key`, or the bearer of an OAuth token). */
  messages: string[];
}

/** Anthropic: its OAuth token endpoint (a refresh, answered after a moment) and its Messages API (`answer: <prompt>`). */
function fakeAnthropic(seen: Seen): typeof globalThis.fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input as Request, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.origin === "https://platform.claude.com" && url.pathname === "/v1/oauth/token") {
      seen.refreshes.push((await request.json()) as Record<string, unknown>);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 28_800 });
    }
    if (request.method !== "POST" || url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
    seen.messages.push(request.headers.get("x-api-key") ?? (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    const body = (await request.json()) as { model: string; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
    const newest = body.messages.filter((message) => message.role === "user").at(-1)?.content;
    const text = `answer: ${typeof newest === "string" ? newest : (newest ?? []).map((part) => part.text ?? "").join("")}`;
    const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const stream = [
      event("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }),
      event("message_stop", {}),
    ].join("");
    return new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": "req_fake" } });
  }) as typeof globalThis.fetch;
}

const agent = defineAgent({ name: "assistant", model: "anthropic/claude-sonnet-4-6" });
const agents = defineComponent({ name: "test-agents", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });

/** A conversation's object: answers `test.complete` with its model's text (`model.complete`). */
const completer = defineComponent({
  name: "test-completer",
  setup(pikit) {
    const inbox = pikit.use("actor.inbox");
    const complete = pikit.use("model.complete");
    return {
      start() {
        inbox.get().answer("test.complete", async (_key, message, ctx) => complete.get().complete({ model: agent.model, prompt: String((message as { prompt: string }).prompt) }, ctx));
      },
    };
  },
});

const OPS = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === OPS.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

it("an uploaded subscription login whose token expired: two conversations' objects at once, one refresh in workerd, both answer with the new token", async () => {
  // The owner object starts empty.
  await runInDurableObject(env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(CREDENTIALS_KEY)), (_instance, state) => state.storage.deleteAll());
  await resetObjects();
  const seen: Seen = { refreshes: [], messages: [] };
  globalThis.fetch = fakeAnthropic(seen);
  composeObjects([storageDo, actorsDo, providerAnthropic, credentialsDo, agents, runtimePi, completer]);

  const server = createWorkerServer(silentLogger);
  let mailbox: ActorMailbox | undefined;
  const reader = defineComponent({
    name: "test-reader",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({
    components: [actorsDo, auth, credentialsDoWorker, reader, server.component],
    config: { "actors-do": { binding: PLATFORM_BINDING } },
    target: "durable",
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  const fetchWorker = (path: string, init: RequestInit = {}) => server.serve(new Request(`https://bot.ana.workers.dev${path}`, { ...init, headers: { ...OPS, ...(init.headers as Record<string, string> | undefined) } }));
  try {
    const login = { type: "oauth", access: EXPIRED_ACCESS, refresh: REFRESH, expires: Date.now() - 60_000 };
    const uploaded = await fetchWorker("/admin/api/credentials-do/anthropic", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(login) });
    expect([uploaded.status, await uploaded.json()]).toEqual([200, { providerId: "anthropic", type: "oauth" }]);
    // A non-operator is refused before the owner is asked.
    expect((await server.serve(new Request("https://bot.ana.workers.dev/admin/api/credentials-do"))).status).toBe(401);

    const ask = (key: string, prompt: string) => (mailbox as ActorMailbox).call(key, "test.complete", { prompt }, app.context());
    const answers = await Promise.all([ask(`test:${crypto.randomUUID()}`, "hello"), ask(`test:${crypto.randomUUID()}`, "hi")]);

    expect(answers).toEqual(["answer: hello", "answer: hi"]);
    expect(seen.refreshes).toEqual([expect.objectContaining({ grant_type: "refresh_token", refresh_token: REFRESH })]);
    expect(seen.messages).toEqual([NEW_ACCESS, NEW_ACCESS]);
    // The rotated tokens are the owner object's, in its own SQLite.
    const owner = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(CREDENTIALS_KEY));
    const rows = await runInDurableObject(owner, (_instance, state) => state.storage.sql.exec("SELECT provider_id, type, credential FROM credentials_do").toArray());
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.credential))).toMatchObject({ type: "oauth", access: NEW_ACCESS, refresh: NEW_REFRESH });
    // The operator's list holds no secret.
    const listed = await (await fetchWorker("/admin/api/credentials-do")).text();
    expect(JSON.parse(listed)).toEqual({ credentials: [{ providerId: "anthropic", type: "oauth" }] });
    for (const secret of [EXPIRED_ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH]) expect(listed).not.toContain(secret);
  } finally {
    await app.stop();
  }
});
