/**
 * Slash commands typed in a chat, on Cloudflare: a `PlatformConversation` object's App (storage-do,
 * storage-kv-sql, actors-do, runtime-pi driving its runs in wakeups on the scripted model,
 * conversations-kv, router-basic, tool-delegate) with a channel's object half that admits each message
 * through `admitInbound` with the App's user commands, as the chat channels do. Each command runs in
 * the object that holds its conversation:
 *
 * - `/tasks` lists a background task `delegate` started; `/cancel <id>` stops it, and the assistant
 *   hears it once; the same id typed in another chat (another object) is not found there.
 * - `/status` says a held run (`hold`) and `/stop` aborts it, while the alarm drives it; then both say
 *   nothing runs.
 * - A command answering a prompt (a prompt template's, as agents-folders generates them) has it
 *   dispatched as the typed message: its id the request id, so the same message again runs once.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { type ActorMailbox, admitInbound, allowedCommands, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { holdTool, scriptedProvider } from "@pikit/pi-adapter/testing/neutral";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import routerBasic from "../../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolDelegate from "../../../registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts";
import { unframed } from "../../../registry/components/tool-delegate/unframed.test-support.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

afterEach(async () => {
  await resetObjects();
});

/** What each typed message became, by its id (the objects share the tests' isolate). */
const outcomes = new Map<string, { kind: string; text?: string | undefined; message?: string | undefined }>();
/** Each run's end: its request, how it ended, its text and its tool results. */
const settled: { requestId: string; kind: string; text: string | undefined; tools: string[] }[] = [];
/** Whether a `hold` runs now. */
let holding = 0;

const toolResults = (messages: readonly unknown[]): string[] =>
  (messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

/** `hold` never returns: it fails when its run stops. */
const hold = holdTool(
  (context) =>
    new Promise<string>((_resolve, reject) => {
      holding++;
      context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true });
    }),
);

const fixture = defineComponent({
  name: "fixture-test",
  setup(pikit) {
    const provider = unframed(scriptedProvider());
    pikit.provideKeyed("model.provider", provider.id, provider);
    for (const agent of [
      defineAgent({ name: "assistant", model: "faux/scripted", tools: ["delegate", hold] }),
      defineAgent({ name: "helper", model: "faux/scripted", tools: [hold] }),
    ]) {
      pikit.provideKeyed("agent.definition", agent.name, agent);
    }
    // As agents-folders generates a prompt template's command: its expansion is the prompt.
    pikit.provideKeyed("agent.command", "review", { description: "Review a part", audience: "user", run: async (_conversation, args) => ({ prompt: `Review ${args}` }) });
    pikit.on("agent.settled", (result) => void settled.push({ requestId: result.requestId, kind: result.kind, text: result.text, tools: toolResults(result.messages) }));
  },
});

/** A chat channel's object half: each message admitted with the users' commands; what came of it recorded. */
const channelActor = defineComponent({
  name: "test-channel-actor",
  setup(pikit) {
    const inbox = pikit.use("actor.inbox");
    const runtime = pikit.use("agent.runtime");
    const conversations = pikit.use("conversations.registry");
    const commands = pikit.useKeyed("agent.command");
    return {
      start() {
        inbox.get().handle("test.message", async (key, message, ctx) => {
          const { id, text } = message as { id: string; text: string };
          const outcome = await admitInbound(
            ctx,
            { id, channel: "test", conversationId: key, actor: { id: "alice" }, text },
            { conversations: conversations.get(), runtime: runtime.get(), key, commands: allowedCommands(commands, "user") },
          );
          outcomes.set(
            id,
            outcome.kind === "command"
              ? { kind: outcome.outcome.kind, ...(outcome.outcome.kind === "ran" && { text: outcome.outcome.text }), ...(outcome.outcome.kind === "failed" && { message: outcome.outcome.message }) }
              : { kind: outcome.kind },
          );
        });
      },
    };
  },
});

async function workerApp() {
  outcomes.clear();
  settled.length = 0;
  holding = 0;
  composeObjects([storageDo, storageKvSql, actorsDo, fixture, toolDelegate, runtimePi, conversationsKv, routerBasic, channelActor], {
    "tool-delegate": { agents: [{ name: "helper", description: "Helps." }] },
    "router-basic": { defaultAgent: "assistant" },
  });
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
    /** Sends a typed message to `key`'s object; resolves once it was admitted (or its command ran). */
    send: async (key: string, id: string, text: string) => {
      await mailbox?.send(key, "test.message", { id, text }, worker.context());
      return outcomes.get(id);
    },
    stop: () => worker.stop(),
  };
}

const ended = (requestId: string) => settled.find((each) => each.requestId === requestId);
const reports = () => settled.filter((each) => each.requestId.startsWith("delegate-result:"));

it("/tasks lists a background task delegate started, /cancel stops it once; another chat does not find it", async () => {
  const worker = await workerApp();
  const chat = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(chat, "m1", 'call: delegate {"agent":"helper","task":"hold","wait":false}');
    await vi.waitFor(() => expect(ended("m1")).toBeDefined(), { timeout: 10_000 });
    const id = /^The task "(\d+)"/.exec(ended("m1")?.tools[0] ?? "")?.[1] ?? "";
    expect(id).not.toBe("");

    expect((await worker.send(chat, "m2", "/tasks"))?.text).toMatch(new RegExp(`^Background tasks:\\n- ${id}: helper, running, started \\d+ seconds? ago`));
    expect(await worker.send(`test:${crypto.randomUUID()}`, "o1", `/cancel ${id}`)).toEqual({ kind: "failed", message: `There is no task "${id}" in this conversation (/tasks lists them).` });

    expect(await worker.send(chat, "m3", `/cancel ${id}`)).toEqual({ kind: "ran", text: `The task "${id}" is stopped.` });
    await vi.waitFor(() => expect(reports()).toHaveLength(1), { timeout: 10_000 });
    expect(reports()[0]?.text).toContain('[The task you delegated to the agent "helper" was stopped before it answered.]');
    expect(await worker.send(chat, "m4", "/tasks")).toEqual({ kind: "ran", text: `Background tasks:\n- ${id}: helper, aborted` });
    expect(await worker.send(chat, "m5", `/cancel ${id}`)).toEqual({ kind: "ran", text: `The task "${id}" is stopped.` });
    expect(reports()).toHaveLength(1);
  } finally {
    await worker.stop();
  }
});

it("/status says a held run, /stop aborts it while the object's alarm drives it; then nothing runs", async () => {
  const worker = await workerApp();
  const chat = `test:${crypto.randomUUID()}`;
  try {
    await worker.send(chat, "m1", "hold");
    await vi.waitFor(() => expect(holding).toBe(1), { timeout: 10_000 });

    expect(await worker.send(chat, "m2", "/status")).toEqual({ kind: "ran", text: "assistant: running." });
    expect(await worker.send(chat, "m3", "/stop")).toEqual({ kind: "ran", text: "Stopped. Background tasks go on: /tasks lists them." });
    await vi.waitFor(() => expect(ended("m1")?.kind).toBe("aborted"), { timeout: 10_000 });
    expect(await worker.send(chat, "m4", "/status")).toEqual({ kind: "ran", text: "assistant: idle." });
    expect(await worker.send(chat, "m5", "/stop")).toEqual({ kind: "ran", text: "Nothing is running." });
  } finally {
    await worker.stop();
  }
});

it("a template's command dispatches its expansion as the typed message: answered once, the same message again a duplicate", async () => {
  const worker = await workerApp();
  const chat = `test:${crypto.randomUUID()}`;
  try {
    expect(await worker.send(chat, "m1", "/review the API")).toEqual({ kind: "admitted" });
    await vi.waitFor(() => expect(ended("m1")?.text).toBe("answer: Review the API"), { timeout: 10_000 });
    expect(await worker.send(chat, "m1", "/review the API")).toEqual({ kind: "duplicate" });
    expect(settled.filter((each) => each.requestId === "m1")).toHaveLength(1);
  } finally {
    await worker.stop();
  }
});
