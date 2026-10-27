/**
 * approvals-sql, extension-approvals and admin-approvals on Cloudflare: every approval in one Durable
 * Object, `approvals-sql:approvals` (deployment-cloudflare's `Conversation` class, as
 * `PlatformConversation`, `src/platform.ts`), reached through actors-do's `actor.mailbox` by RPC.
 *
 * - The `approvals` suite from an App in an object of its own (storage-do, actors-do, approvals-sql):
 *   every call crosses to the owner's object, which keeps the rows in its own SQLite and reads expiry on
 *   the case's clock (`composeObjects`' `clock`). The owner is emptied before each case.
 * - A conversation's object (runtime-pi on `faux/scripted`, extension-approvals gating a recording
 *   `bash` (execution-do installed, as runtime-pi asks of an agent naming `bash`), approvals-sql, admin-approvals' default export) asks for approval; the owner is evicted; an
 *   operator approves twice through the Worker's routes (deployment-cloudflare's server over
 *   admin-approvals' and approvals-sql's Worker halves); the conversation's object is told once, and
 *   the exact call then runs once.
 */

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, Halt, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, type AdminAuth, type AgentTool, defineAgent, type Sender } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import { recordingBash, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import adminApprovals, { worker as adminApprovalsWorker } from "../../../registry/components/admin-approvals/files/src/pikit/admin-approvals/index.ts";
import { createApprovalsConformance } from "../../../registry/components/approvals-sql/files/src/pikit/approvals-sql/conformance.ts";
import approvalsSql, { APPROVALS_KEY, worker as approvalsSqlWorker } from "../../../registry/components/approvals-sql/files/src/pikit/approvals-sql/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import { createWorkerServer } from "../../../registry/components/deployment-cloudflare/files/src/pikit/deployment-cloudflare/host.ts";
import extensionApprovals from "../../../registry/components/extension-approvals/files/src/pikit/extension-approvals/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { inObject, objectHost, resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };
const owner = () => env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.idFromName(APPROVALS_KEY));

// Every approval is in the one owner object: empty it, then reset every instance so its next App makes its table again.
beforeEach(async () => {
  await runInDurableObject(owner(), (_instance, state) => state.storage.deleteAll());
  await resetObjects();
});
afterEach(async () => {
  vi.useRealTimers();
  await resetObjects();
});

for (const c of createApprovalsConformance((clock) => {
  composeObjects([storageDo, actorsDo, approvalsSql], ACTORS, { clock });
  return { app: () => withWorkersHost(objectHost(), [storageDo, actorsDo, approvalsSql]), config: ACTORS, target: "durable" };
})) {
  it(`approvals-sql over storage-do and actors-do ${c.group}: ${c.name}`, () => inObject(c));
}

const approver: Sender = { channel: "telegram", id: "1001" };
const AUTH = { authorization: "Bearer workerd-operator" };
const auth = defineComponent({
  name: "auth-test",
  setup: (pikit) => pikit.provide("admin.auth", { verify: async (request) => (request.headers.get("authorization") === AUTH.authorization ? { id: "ops" } : undefined) } satisfies AdminAuth),
});

/** The conversation's side: the guarded agent, its model, a `bash` that records, and a channel's object half. */
function conversationApp(ran: string[], results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[]) {
  const fixtures = defineComponent({
    name: "fixtures-test",
    setup(pikit) {
      pikit.provideKeyed("agent.definition", "guarded", defineAgent({ name: "guarded", model: "faux/scripted", tools: ["bash"], extensions: ["approvals"] }));
      pikit.provideKeyed("model.provider", "faux", scriptedProvider());
      pikit.provideKeyed("agent.tool", "bash", recordingBash(ran) as AgentTool);
    },
  });
  // A channel's object half: each message through `inbound.normalize` (as admitInbound runs it), then to its key's conversation.
  const channel = defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text, sender } = message as unknown as { id: string; text: string; sender: Sender };
            const normalized = await ctx.run("inbound.normalize", { id, channel: sender.channel, conversationId: key, actor: { id: sender.id }, text });
            if (normalized instanceof Halt) throw new Error(`halted: ${normalized.reason}`);
            const conversation = await registry.get().resolve(key, "guarded", { channel: sender.channel }, ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: normalized.text, sender }, ctx);
          });
        },
      };
    },
  });
  return [storageDo, storageKvSql, actorsDo, executionDo, fixtures, runtimePi, conversationsKv, approvalsSql, extensionApprovals, adminApprovals, channel];
}

/** The Worker's App: admin-approvals' routes over approvals-sql's Worker half, served by deployment-cloudflare's server. */
async function workerApp() {
  const server = createWorkerServer(silentLogger);
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "test-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, auth, approvalsSqlWorker, adminApprovalsWorker, probe, server.component], config: ACTORS, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  return {
    app,
    send: (key: string, id: string, text: string, sender: Sender) => (mailbox as ActorMailbox).send(key, "test.message", { id, text, sender: { channel: sender.channel, id: sender.id } }, app.context()),
    fetch: async (path: string, init: RequestInit = {}) => {
      const response = await server.serve(new Request(`https://pikit.test${path}`, { ...init, headers: { ...AUTH, "content-type": "application/json" } }));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

it("asked in a conversation's object, approved twice by an operator through the Worker after the owner's eviction: told once, the exact call runs once", async () => {
  const ran: string[] = [];
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  composeObjects(conversationApp(ran, results), { ...ACTORS, "extension-approvals": { tools: ["bash"], approvers: ["telegram:1001", "dashboard:*"] } });
  const worker = await workerApp();
  const key = `telegram:${crypto.randomUUID()}`;
  const result = (id: string) => vi.waitFor(() => results.find((r) => r.requestId === id) ?? Promise.reject(new Error(`no result for ${id} yet`)), { timeout: 10_000 });
  try {
    await worker.send(key, "m1", 'call: request_approval {"tool":"bash","args":{"command":"ls"},"title":"List the files","reason":"To see them"}', approver);
    expect((await result("m1")).parts?.[0]).toMatchObject({ type: "question" });
    const listed = await worker.fetch("/admin/api/approvals?status=pending");
    const [pending] = listed.body.items as { id: string; requestedBy: { conversation: { key: string } } }[];
    expect(pending?.requestedBy.conversation.key).toBe(key);
    const id = pending?.id as string;

    // The owner's instance goes; its rows stay.
    await evictDurableObject(owner());
    const decide = () => worker.fetch(`/admin/api/approvals/${id}/decision`, { method: "POST", body: JSON.stringify({ verdict: "approve" }) });
    expect([(await decide()).status, (await decide()).status]).toEqual([200, 200]);
    const told = await result(`approval-decided:${id}`);
    expect(told.text).toContain(`[approvals] Approval ${id} ("List the files") was approved by dashboard:ops.`);

    await worker.send(key, "m2", "bash: ls", approver);
    expect((await result("m2")).text).toBe("tool said: ran");
    await worker.send(key, "m3", "bash: ls", approver);
    expect((await result("m3")).text).toContain("needs a person's approval");
    expect(ran).toEqual(["ls"]);
    expect(results.filter((r) => r.requestId === `approval-decided:${id}`)).toHaveLength(1);
    expect((await worker.fetch("/admin/api/approvals")).body.items).toMatchObject([{ id, status: "executed", decidedBy: { channel: "dashboard", id: "ops" } }]);
  } finally {
    await worker.app.stop();
  }
});
