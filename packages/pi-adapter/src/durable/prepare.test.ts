/**
 * Dynamic agents on pi-durable (`agent.state`, `defineAgent`'s `prepare`): `prepare(state)` decides
 * each conversation's `pi.agent` (model, instructions, tools) whenever the state changes, so a tool's
 * update applies from the run's next model request; the state is a conversation document, so it
 * survives a new worker and a new conversation (a reset) starts fresh. `agent.state`'s conformance
 * suite runs on it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, type Logger } from "@pikit/core";
import { AGENT_STATE, type AgentDefinition, defineAgent } from "@pikit/contracts";
import { createAgentStateConformance } from "@pikit/contracts/testing";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "pi-ai-v1";
import type { DurableTool } from "./agent.ts";
import { databaseFile, holdTool, type ModelRequest, openWorker, scriptedProvider, type Worker } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Moves the conversation's state to the phase it is called with, and returns the new state. */
const advance = defineTool({
  name: "advance",
  description: "Moves the release to another phase",
  parameters: Type.Object({ phase: Type.String() }),
  execute: async (args, _api, context) => {
    const state = context.value(AGENT_STATE);
    if (state === undefined) throw new Error("no agent.state in the tool's context");
    const next = await state.update({ phase: args.phase }, context);
    return { content: [{ type: "text", text: JSON.stringify(next) }] };
  },
}) as unknown as DurableTool;

/** An installed tool (`agent.tool`), only for the `deploying` phase. */
const deploy = { ...holdTool(async () => "deployed"), name: "deploy" } as DurableTool;

/** Static: `faux`, "testing prompt", `advance`. Deploying: `other`, "deploying prompt", `advance` + `deploy`. */
const release = defineAgent({
  name: "release",
  model: "faux/scripted",
  systemPrompt: "testing prompt",
  tools: [advance as never],
  state: { phase: "testing" },
  prepare: (state) =>
    state.phase === "deploying" ? { model: "other/scripted", systemPrompt: "deploying prompt", tools: [advance as never, "deploy"] } : {},
});

function records() {
  const file = databaseFile();
  cleanup.push(file.dispose);
  return {
    async worker(options: { agents?: AgentDefinition[]; logger?: Logger } = {}) {
      const requests: ModelRequest[] = [];
      const onRequest = (request: ModelRequest) => void requests.push(structuredClone(request));
      const w = await openWorker(file.path, {
        agents: options.agents ?? [release],
        tools: { deploy },
        providers: [scriptedProvider({ onRequest }), scriptedProvider({ id: "other", onRequest })],
        ...(options.logger !== undefined && { logger: options.logger }),
      });
      cleanup.push(w.close);
      /** Dispatch `prompt` and wait for its run's end. */
      const ask = async (conversation: Awaited<ReturnType<Worker["conversation"]>>, requestId: string, prompt: string) => {
        await w.dispatch(requestId, prompt, conversation);
        return w.result(requestId);
      };
      return { ...w, requests, ask };
    },
  };
}

/**
 * What a model request carried: pi-durable sends the system prompt and the tools as positional system
 * messages, each changing what the ones before it said. The conversation's `instructions` are the
 * section `instructions`.
 */
function sent(request: ModelRequest | undefined) {
  const sections: Record<string, string> = {};
  const tools: string[] = [];
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete sections[key];
      else sections[key] = value;
    }
    for (const tool of message.toolsRemoved ?? []) tools.splice(tools.indexOf(tool.name), 1);
    for (const tool of message.toolsAdded ?? []) tools.push(tool.name);
  }
  return { systemPrompt: sections.instructions, tools };
}

function providers(result: { messages: unknown[] }): string[] {
  return result.messages.flatMap((message) => ((message as { role: string }).role === "assistant" ? [(message as { provider: string }).provider] : []));
}

describe("prepare", () => {
  test("a tool updates the state, and from the next model request prepare gives model, prompt and tools", async () => {
    const w = await records().worker();
    const conversation = await w.conversation();

    const first = await w.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');

    // The request after the tool's update already has what prepare gives for the new state.
    expect(providers(first)).toEqual(["faux", "other"]);
    expect(w.requests.map(sent)).toEqual([
      { systemPrompt: expect.stringContaining("testing prompt"), tools: ["advance"] },
      { systemPrompt: expect.stringContaining("deploying prompt"), tools: ["advance", "deploy"] },
    ]);

    const second = await w.ask(conversation, "r2", "hello");
    expect(providers(second)).toEqual(["other"]);
    expect(sent(w.requests[2])).toEqual({ systemPrompt: expect.stringContaining("deploying prompt"), tools: ["advance", "deploy"] });
  });

  test("nothing carries over: when prepare returns nothing, the conversation has the static definition again", async () => {
    const w = await records().worker();
    const conversation = await w.conversation();
    await w.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
    await w.ask(conversation, "r2", 'call: advance {"phase":"testing"}');

    const third = await w.ask(conversation, "r3", "hello");

    expect(providers(third)).toEqual(["faux"]);
    expect(sent(w.requests.at(-1))).toEqual({ systemPrompt: expect.stringContaining("testing prompt"), tools: ["advance"] });
  });

  test("the state survives a new worker over the same storage, and a new conversation (a reset) starts fresh", async () => {
    const db = records();
    const before = await db.worker();
    const conversation = await before.conversation();
    await before.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
    await before.close();

    const after = await db.worker();
    expect(providers(await after.ask(conversation, "r2", "hello"))).toEqual(["other"]);
    expect(await after.runtime.state(conversation).get(BACKGROUND_CONTEXT)).toEqual({ phase: "deploying" });

    const reset = await after.conversation();
    expect(providers(await after.ask(reset, "r3", "hello"))).toEqual(["faux"]);
    expect(await after.runtime.state(reset).get(BACKGROUND_CONTEXT)).toEqual({ phase: "testing" });
  });

  test("a prepare that throws, or names a tool nobody provides, gives the static definition, logged", async () => {
    const errors: string[] = [];
    const quiet = () => {};
    const logger: Logger = { debug: quiet, info: quiet, warn: quiet, error: (message, fields) => void errors.push(`${message} ${JSON.stringify(fields)}`) };
    const broken = defineAgent({
      ...release,
      name: "broken",
      prepare: (state) => {
        if (state.phase === "deploying") throw new Error("prepare exploded");
        return state.phase === "missing" ? { tools: ["missing"] } : {};
      },
    });
    const w = await records().worker({ agents: [broken], logger });
    const conversation = await w.conversation();
    await w.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');

    const second = await w.ask(conversation, "r2", 'call: advance {"phase":"missing"}');
    const third = await w.ask(conversation, "r3", "hello");

    expect([second.kind, third.kind]).toEqual(["completed", "completed"]);
    expect(sent(w.requests.at(-1))).toEqual({ systemPrompt: expect.stringContaining("testing prompt"), tools: ["advance"] });
    expect(errors.some((error) => error.includes("prepare exploded"))).toBe(true);
    expect(errors.some((error) => error.includes('names the tool \\"missing\\"'))).toBe(true);
  });

  test("an agent whose static model is not provided cannot run: the dispatch fails", async () => {
    const w = await records().worker({ agents: [defineAgent({ name: "nowhere", model: "nobody/none" })] });
    const conversation = await w.conversation();

    await expect(w.dispatch("r1", "hello", conversation)).rejects.toThrow('model "nobody/none" is not provided');
  });
});

// `agent.state`'s conformance: one conversation per case; reopened in a new worker; reset as a new conversation.
for (const c of createAgentStateConformance(async () => {
  const db = records();
  let initial: Record<string, unknown> = {};
  const agent = () => defineAgent({ name: "stateful", model: "faux/scripted", state: initial });
  // One worker at a time over the database: one Harness per storage.
  let worker!: Awaited<ReturnType<typeof db.worker>>;
  let conversation!: Awaited<ReturnType<Worker["conversation"]>>;
  return {
    async open(state) {
      initial = state;
      worker = await db.worker({ agents: [agent()] });
      conversation = await worker.conversation();
      return worker.runtime.state(conversation);
    },
    async reopen() {
      await worker.close();
      worker = await db.worker({ agents: [agent()] });
      return worker.runtime.state(conversation);
    },
    async reset() {
      conversation = await worker.conversation();
      return worker.runtime.state(conversation);
    },
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
