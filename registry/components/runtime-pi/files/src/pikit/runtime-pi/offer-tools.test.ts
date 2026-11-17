/**
 * `offerTools` through runtime-pi in a real App: an extension chooses, per conversation, which of its
 * tools the model is offered (here by the conversation's space, as memory-recall and tool-space-files
 * do inside a project). The choice is asked at each admission and kept with the conversation: a tool
 * not offered is never sent to the model, a call to it by name is refused without running, each
 * conversation has its own, a restart keeps them, and a failing choice keeps the last answer or offers
 * none. They are copied with the component and keep running in your project.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentDefinition, type AgentRuntime, type AgentTool, type ConversationRef, defineAgent } from "@pikit/contracts";
import { defineExtension, defineTool, offerTools } from "@pikit/pi-adapter/extensions";
import { holdTool, type ModelRequest, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import Type from "typebox";
import runtimePi from "./index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A tool that records its runs in `ran`. */
const recording = (name: string, ran: string[]) =>
  defineTool({
    name,
    description: `Records that ${name} ran`,
    parameters: Type.Object({}) as never,
    execute: async () => {
      ran.push(name);
      return { output: [{ type: "text", text: `${name} ran` }] };
    },
  });

/**
 * `family`: `plain_note` outside a project, `project_note` in one (a space in `world.projects`), as
 * `world.mode` says: answer, throw, or answer something that is no list of names. Each question is in `asked`.
 */
function family(ran: string[]) {
  const world = { projects: new Set<string>(), mode: "answer" as "answer" | "throw" | "garbage", asked: [] as string[] };
  const extension = offerTools(defineExtension({ name: "family", tools: [recording("plain_note", ran), recording("project_note", ran)] }), async (conversation) => {
    world.asked.push(conversation.space ?? "(none)");
    if (world.mode === "throw") throw new Error("the projects store cannot be reached");
    if (world.mode === "garbage") return "project_note" as unknown as string[];
    return world.projects.has(conversation.space ?? "") ? ["project_note"] : ["plain_note"];
  });
  return { world, extension };
}

/** `other`: an extension that declares no choice. */
const other = (ran: string[]) => defineExtension({ name: "other", tools: [recording("other_tool", ran)] });

/** The tools a request offered: pi-durable sends them as positional system messages, each changing the ones before. */
function offered(request: ModelRequest | undefined): string[] {
  const tools: string[] = [];
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) tools.splice(tools.indexOf(tool.name), 1);
    for (const tool of message.toolsAdded ?? []) tools.push(tool.name);
  }
  return tools.sort();
}

function databaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-runtime-pi-offers-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "pikit.db");
}

/** An App with runtime-pi over the SQLite file at `path`: `ask` dispatches and waits for the run's result. */
async function start(path: string, options: { agents: AgentDefinition[]; extensions: ReturnType<typeof defineExtension>[] }) {
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  const requests: ModelRequest[] = [];
  const provider = scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) });
  let reached: { runtime: AgentRuntime; create: () => Promise<string> } | undefined;
  const components = defineComponent({
    name: "offers-test",
    setup(pikit) {
      pikit.provideKeyed("model.provider", "faux", provider);
      for (const agent of options.agents) pikit.provideKeyed("agent.definition", agent.name, agent);
      for (const extension of options.extensions) pikit.provideKeyed("agent.extension", extension.name, extension);
    },
  });
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return { start: (ctx) => void (reached = { runtime: runtime.get(), create: () => conversations.get().create(ctx) }) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(path), components, runtimePi, observer], logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const live = () => {
    if (reached === undefined) throw new Error("the observer has not started");
    return reached;
  };
  const result = async (requestId: string) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = results.find((r) => r.requestId === requestId);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for the result of ${requestId}`);
      await Bun.sleep(5);
    }
  };
  return {
    requests,
    result,
    stop: () => app.stop(),
    /** A conversation in `space` (channel `test`), as a channel's ref gives it. */
    conversation: async (key: string, agent: string, space: string): Promise<ConversationRef> => ({ key, agent, conversationId: await live().create(), channel: "test", space }),
    async ask(conversation: ConversationRef, requestId: string, prompt: string) {
      await live().runtime.dispatch({ requestId, conversation, prompt }, app.context());
      return result(requestId);
    },
  };
}

async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

const agent = (extensions: string[], tools: AgentDefinition["tools"] = []) => defineAgent({ name: "assistant", model: "faux/scripted", tools, extensions });

test("each conversation is offered what the extension chose for it, and the tools of others and the agent's own stay", async () => {
  const ran: string[] = [];
  const { world, extension } = family(ran);
  world.projects.add("space:p");
  const s = await start(databaseFile(), { agents: [agent(["family", "other"])], extensions: [extension, other(ran)] });

  const project = await s.conversation("test:p", "assistant", "space:p");
  await s.ask(project, "r1", "hello");
  await s.ask(await s.conversation("test:s", "assistant", "space:s"), "r2", "hello");
  // Unanswered, the project's conversation keeps its own last answer, not the other conversation's.
  world.mode = "throw";
  await s.ask(project, "r3", "hello again");

  expect(s.requests.map(offered)).toEqual([
    ["other_tool", "project_note"],
    ["other_tool", "plain_note"],
    ["other_tool", "project_note"],
  ]);
  expect(world.asked).toEqual(["space:p", "space:s", "space:p"]);
});

test("a tool not offered, called by name, is refused without running, and the run goes on; an offered one runs", async () => {
  const ran: string[] = [];
  const { world, extension } = family(ran);
  world.projects.add("space:p");
  const s = await start(databaseFile(), { agents: [agent(["family", "other"])], extensions: [extension, other(ran)] });
  const conversation = await s.conversation("test:p", "assistant", "space:p");

  const refused = await s.ask(conversation, "r1", "call: plain_note {}");
  const accepted = await s.ask(conversation, "r2", "call: project_note {}");

  expect(ran).toEqual(["project_note"]);
  expect(refused.kind).toBe("completed");
  expect(accepted.kind).toBe("completed");
  // The last request has the whole conversation: each call's result once.
  const results = (s.requests.at(-1)?.messages ?? []).filter((message) => message.role === "toolResult");
  expect(results.map((message) => [message.toolName, message.isError, message.content.map((part) => (part.type === "text" ? part.text : "")).join("")])).toEqual([
    ["plain_note", true, "<harness>\n[error] Tool plain_note is not available\n</harness>"],
    ["project_note", false, "project_note ran"],
  ]);
});

test("each admission asks again: a space that becomes a project has the project's tools from its next message", async () => {
  const ran: string[] = [];
  const { world, extension } = family(ran);
  const s = await start(databaseFile(), { agents: [agent(["family"])], extensions: [extension] });
  const conversation = await s.conversation("test:s", "assistant", "space:s");

  await s.ask(conversation, "r1", "hello");
  world.projects.add("space:s");
  await s.ask(conversation, "r2", "hello again");

  expect(s.requests.map(offered)).toEqual([["plain_note"], ["project_note"]]);
  expect(world.asked).toEqual(["space:s", "space:s"]);
});

test("a restart keeps each conversation's tools: a run resumed by the next App is offered the same, without asking", async () => {
  const path = databaseFile();
  const ran: string[] = [];
  // The first App's `hold` waits until the App stops; the next one's returns at once (replay safe: it runs again).
  let holding = false;
  const dying = holdTool((context) => {
    holding = true;
    return new Promise<string>((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true }));
  }, "safe");
  const first = family(ran);
  first.world.projects.add("space:p");
  const before = await start(path, { agents: [agent(["family"], [dying as unknown as AgentTool])], extensions: [first.extension] });
  const conversation = await before.conversation("test:p", "assistant", "space:p");
  // "hold" calls `hold`: once it runs, the App stops mid-run (its result never comes).
  void before.ask(conversation, "r-hold", "hold").catch(() => undefined);
  await until(() => holding);
  await before.stop();
  expect(before.requests.map(offered)).toEqual([["hold", "project_note"]]);

  // The next App's choice would answer otherwise (no project anywhere): it is not asked until a message comes.
  const second = family(ran);
  const after = await start(path, { agents: [agent(["family"], [holdTool(async () => "held", "safe") as unknown as AgentTool])], extensions: [second.extension] });
  const resumed = await after.result("r-hold");

  expect(resumed.kind).toBe("completed");
  expect(after.requests.map(offered)).toEqual([["hold", "project_note"]]);
  expect(second.world.asked).toEqual([]);

  // Its next admission asks, and the answer applies.
  await after.ask(conversation, "r2", "hello");
  expect(second.world.asked).toEqual(["space:p"]);
  expect(offered(after.requests.at(-1))).toEqual(["hold", "plain_note"]);
}, 30_000);

test("a failing choice offers none of the extension's tools the first time, keeps the last answer after, and never fails the admission", async () => {
  const ran: string[] = [];
  const { world, extension } = family(ran);
  world.projects.add("space:p");
  const s = await start(databaseFile(), { agents: [agent(["family", "other"])], extensions: [extension, other(ran)] });
  const fresh = await s.conversation("test:fresh", "assistant", "space:p");
  const known = await s.conversation("test:known", "assistant", "space:p");

  await s.ask(known, "r1", "hello");
  world.mode = "throw";
  const failedFresh = await s.ask(fresh, "r2", "hello");
  const failedKnown = await s.ask(known, "r3", "hello");
  world.mode = "garbage";
  const garbled = await s.ask(fresh, "r4", "call: project_note {}");

  expect([failedFresh.kind, failedKnown.kind, garbled.kind]).toEqual(["completed", "completed", "completed"]);
  expect(s.requests.map(offered)).toEqual([
    ["other_tool", "project_note"],
    // Closed: never asked successfully, so none of the family's tools.
    ["other_tool"],
    // Kept: the last answer.
    ["other_tool", "project_note"],
    // An answer that is no list of names is a failure too.
    ["other_tool"],
    ["other_tool"],
  ]);
  expect(ran).toEqual([]);
});

test("with no extension declaring a choice nothing changes: every tool is offered, and nothing is asked", async () => {
  const ran: string[] = [];
  const { world, extension } = family(ran);
  // `family` is installed, and named by no agent.
  const s = await start(databaseFile(), { agents: [agent(["other"])], extensions: [extension, other(ran)] });

  await s.ask(await s.conversation("test:a", "assistant", "space:a"), "r1", "call: other_tool {}");

  expect(offered(s.requests[0])).toEqual(["other_tool"]);
  expect(ran).toEqual(["other_tool"]);
  expect(world.asked).toEqual([]);
});
