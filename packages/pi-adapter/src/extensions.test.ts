/**
 * Agent extensions in the durable runtime (`agent.ts`): an agent's named extensions resolve through
 * `extension(name)` each time the agent is applied, are selected after its tool extension, and a name
 * nothing provides fails the agent. runtime-pi's own tests (`extensions.test.ts`) take them through a
 * real App.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_STATE, defineAgent } from "@pikit/contracts";
import { Type } from "@earendil-works/pi-ai";
import { type DurableExtension, type DurableTool, RESERVED_EXTENSION_PREFIX } from "./agent.ts";
import { defineExtension, defineTool, section } from "./extensions.ts";
import { databaseFile, type ModelRequest, openWorker, scriptedProvider } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const mode = (name: string, text: string) => defineExtension({ name, sections: [section("mode", () => text)] });

/** Moves the conversation's state to `mode`. */
const switchMode = defineTool({
  name: "switch",
  description: "Switches mode",
  parameters: Type.Object({ mode: Type.String() }),
  execute: async (args, _api, context) => {
    await context.value(AGENT_STATE)?.update({ mode: args.mode }, context);
    return { content: [{ type: "text", text: "switched" }] };
  },
}) as unknown as DurableTool;

function shownMode(request: ModelRequest | undefined): string | undefined {
  let shown: string | undefined;
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    const value = message.sections?.mode;
    if (value !== undefined) shown = value ?? undefined;
  }
  return shown;
}

async function worker(extensions: Record<string, DurableExtension>, agents = [defineAgent({ name: "scripted", model: "faux/scripted", extensions: ["plan"] })]) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const requests: ModelRequest[] = [];
  const w = await openWorker(file.path, {
    agents,
    providers: [scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })],
    runtime: { extension: (name) => extensions[name] },
  });
  cleanup.push(w.close);
  return { ...w, requests };
}

describe("agent extensions", () => {
  test("a name nothing provides fails the agent: the dispatch is refused with the name", async () => {
    const w = await worker({});
    const conversation = await w.conversation();

    await expect(w.dispatch("r1", "hello", conversation)).rejects.toThrow('agent "scripted" names the extension "plan", which no agent.extension provides');
  });

  test("the extension is resolved each time the agent is applied: a provider's new object replaces the installed one", async () => {
    const provided: Record<string, DurableExtension> = { plan: mode("plan", "first") };
    const w = await worker(provided);
    const conversation = await w.conversation();
    await w.dispatch("r1", "hello", conversation);
    await w.result("r1");

    provided.plan = mode("plan", "second");
    await w.dispatch("r2", "hello", conversation);
    await w.result("r2");

    expect(w.requests.map(shownMode)).toEqual(["<mode>\nfirst\n</mode>", "<mode>\nsecond\n</mode>"]);
  });

  test("prepare changes the extensions with the state, from the next model request", async () => {
    const agent = defineAgent({
      name: "scripted",
      model: "faux/scripted",
      tools: [switchMode as never],
      extensions: ["plan"],
      state: { mode: "plan" },
      prepare: (state) => (state.mode === "build" ? { extensions: ["build"] } : {}),
    });
    const w = await worker({ plan: mode("plan", "planning"), build: mode("build", "building") }, [agent]);
    const conversation = await w.conversation();

    await w.dispatch("r1", 'call: switch {"mode":"build"}', conversation);
    await w.result("r1");

    expect(w.requests.map(shownMode)).toEqual(["<mode>\nplanning\n</mode>", "<mode>\nbuilding\n</mode>"]);
  });

  test("an extension under a reserved name, or provided under another name, fails the agent", async () => {
    const reserved = `${RESERVED_EXTENSION_PREFIX}mine`;
    const agents = [defineAgent({ name: "scripted", model: "faux/scripted", extensions: [reserved] })];
    const w = await worker({ [reserved]: mode(reserved, "x") }, agents);
    await expect(w.dispatch("r1", "hello", await w.conversation())).rejects.toThrow("is reserved");

    const misnamed = await worker({ plan: mode("other", "x") });
    await expect(misnamed.dispatch("r1", "hello", await misnamed.conversation())).rejects.toThrow('is an extension named "other"');
  });
});
