/**
 * A request's sender in the durable runtime (`runtime.ts`): placed with its input as an entry of kind
 * `pikit.input` (pi-durable's `InputEntry`), read by the run's tools, sections and hooks through
 * `RUN_REQUESTS`, kept across a worker that died, and in the transcript for good. The `agent.runtime` suite checks the tools' view on every
 * provider; this checks what is Pi's: durability, and the extensions' scope.
 */

import { afterEach, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CONVERSATION, defineAgent, RUN_REQUESTS, type RunRequest, type Sender } from "@pikit/contracts";
import type { DurableExtension, DurableTool } from "./agent.ts";
import { INPUT_KIND } from "./submissions.ts";
import { toChord } from "./context.ts";
import { databaseFile, holdTool, type ModelRequest, openWorker, releasableHold, scriptedAgent, scriptedProvider, type WorkerOptions } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const alice: Sender = { channel: "telegram", id: "1001" };

function records() {
  const file = databaseFile();
  cleanup.push(file.dispose);
  return {
    async worker(options: WorkerOptions = {}) {
      const w = await openWorker(file.path, options);
      cleanup.push(w.close);
      return w;
    },
  };
}

test("a sender outlives the worker that admitted it: the run resumed elsewhere reads it", async () => {
  const db = records();
  const hold = releasableHold("safe");
  const first = await db.worker({ agents: [scriptedAgent([hold.tool as never])] });
  const conversation = await first.conversation();
  await first.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold", sender: alice }, first.ctx);
  await hold.started;
  await first.close();

  let read: readonly RunRequest[] | undefined;
  const again = holdTool(async (context) => {
    read = await context.value(RUN_REQUESTS)?.list(context);
    return "released";
  }, "safe");
  const next = await db.worker({ agents: [scriptedAgent([again as never])] });
  await next.runtime.resume(conversation, next.ctx);

  expect((await next.result("r1")).kind).toBe("completed");
  expect(read).toEqual([{ requestId: "r1", sender: alice }]);
});

test("a sender is in the transcript: its input is an entry of kind pikit.input carrying it; one without a sender is pi.user", async () => {
  const db = records();
  const w = await db.worker();
  const conversation = await w.conversation();

  await w.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello", sender: alice }, w.ctx);
  await w.result("r1");
  await w.runtime.dispatch({ requestId: "r2", conversation, prompt: "hello again" }, w.ctx);
  const second = await w.result("r2");

  const { harness } = await w.runtime.opened(w.ctx);
  const handle = await harness.conversation(Number(conversation.conversationId) as ConversationId, toChord(w.ctx));
  const entries = (await handle?.entries({}, 100, undefined, toChord(w.ctx)))?.items ?? [];
  // Newest first: read oldest first.
  const inputs = entries.filter((entry) => entry.model?.some((message) => message.role === "user")).reverse();
  expect(inputs.map((entry) => [entry.kind, entry.data] as unknown)).toEqual([
    [INPUT_KIND, { sender: alice }],
    ["pi.user", undefined],
  ]);
  // The model reads it as any message, and the run's result is as without a sender.
  expect(second.text).toBe("answer: hello again");
  expect((await w.result("r1")).text).toBe("answer: hello");
});

test("a sender that is not a channel and an id is refused, and nothing is admitted", async () => {
  const db = records();
  const w = await db.worker();
  const conversation = await w.conversation();

  await expect(w.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello", sender: { channel: "telegram", id: "" } }, w.ctx)).rejects.toThrow("a sender has a channel and an id");
  await expect(w.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello", sender: { id: "1" } as never }, w.ctx)).rejects.toThrow("a sender has a channel and an id");
  expect(await w.runtime.submissions.get(conversation, "r1", w.ctx)).toBeUndefined();
});

test("an extension's sections and tool hooks run in the conversation's scope: its run's requests and its conversation", async () => {
  const db = records();
  const seen: { hook?: readonly RunRequest[] | undefined; conversation?: string | undefined } = {};
  const who = defineExtension({
    name: "who",
    sections: [
      section("who", async (_input, context) => {
        const requests = (await context.value(RUN_REQUESTS)?.list(context)) ?? [];
        return requests.map((request) => `${request.requestId} from ${request.sender === undefined ? "nobody" : `${request.sender.channel}:${request.sender.id}`}`).join("; ");
      }),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, _api, context) => {
          seen.hook = await context.value(RUN_REQUESTS)?.list(context);
          seen.conversation = context.value(CONVERSATION)?.key;
          return undefined;
        },
      }),
    ],
  }) as DurableExtension;
  const noop = defineTool({
    name: "noop",
    description: "Does nothing",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "done" }] }),
  }) as unknown as DurableTool;
  const requests: ModelRequest[] = [];
  const w = await db.worker({
    agents: [defineAgent({ name: "scripted", model: "faux/scripted", tools: [noop as never], extensions: ["who"] })],
    providers: [scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })],
    runtime: { extension: (name) => (name === "who" ? who : undefined) },
  });
  const conversation = await w.conversation();

  await w.runtime.dispatch({ requestId: "r1", conversation, prompt: "call: noop {}", sender: alice }, w.ctx);
  expect((await w.result("r1")).kind).toBe("completed");

  const shown = requests[0]?.messages.flatMap((message) => (message.role === "system" && message.sections?.who !== undefined ? [message.sections.who] : []));
  expect(shown).toEqual(["<who>\nr1 from telegram:1001\n</who>"]);
  expect(seen).toEqual({ hook: [{ requestId: "r1", sender: alice }], conversation: conversation.key });
});
