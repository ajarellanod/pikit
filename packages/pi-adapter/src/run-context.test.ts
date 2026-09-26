/**
 * Every run's context names its conversation (`CONVERSATION`, SPEC §6.3), and Pi hands that context
 * to each tool call: a bound tool can then work in its agent's own environment (SPEC §8.2).
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentHarnessTool, type ExecutionEnv, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentDefinition,
  type AgentTool,
  type AppEvents,
  CONVERSATION,
  type ConversationRef,
  defineAgent,
  defineApp,
  defineComponent,
  silentLogger,
} from "@pikit/core";
import { modelsFrom } from "./models.ts";
import { createPiRuntime } from "./runtime.ts";
import { scriptedProvider } from "./testing/index.ts";
import { bindTool, createWriteTool } from "./tools/index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** A runtime with `agents` and the installed `tools`; `ask` dispatches one message and waits for its run's end. */
async function runtimeWith(agents: AgentDefinition[], tools: Record<string, AgentTool>) {
  const settled: AppEvents["agent.settled"][] = [];
  const waiters: (() => void)[] = [];
  const observer = defineComponent({
    name: "observer",
    setup: (pikit) =>
      pikit.on("agent.settled", (payload) => {
        settled.push(payload);
        for (const wake of waiters.splice(0)) wake();
      }),
  });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const sessions = new MemorySessionRepo();
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => tools[name],
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
  });
  const conversation = async (agent: string): Promise<ConversationRef> => {
    const session = await sessions.create({}, app.context());
    await session.close(app.context());
    return { key: `test:${agent}:${session.metadata.id}`, agent, sessionId: session.metadata.id };
  };
  const ask = async (conversation: ConversationRef, requestId: string, prompt: string) => {
    await runtime.dispatch({ requestId, conversation, prompt }, app.context());
    while (!settled.some((result) => result.requestId === requestId)) await new Promise<void>((wake) => waiters.push(wake));
  };
  return { conversation, ask, close: () => runtime.close(app.context()) };
}

test("every run's context names the run's conversation, and each tool call gets it", async () => {
  const seen: (ConversationRef | undefined)[] = [];
  const whoami: AgentHarnessTool<undefined> = {
    name: "whoami",
    label: "whoami",
    description: "Records the conversation it runs in",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _onUpdate, _toolContext, _invocation, context) {
      seen.push(context.value(CONVERSATION));
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
  const s = await runtimeWith([defineAgent({ name: "support", model: "faux/scripted", tools: [whoami] })], {});
  const conversation = await s.conversation("support");

  await s.ask(conversation, "r1", "call: whoami {}");

  expect(seen).toEqual([conversation]);
  await s.close();
});

test("a bound tool resolves its environment per run: each agent writes in its own directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-run-context-"));
  directories.push(root);
  // What a `workspace` provider does, reduced to its core: one environment per agent, from the run.
  const envs = new Map<string, ExecutionEnv>();
  const write = bindTool(createWriteTool(), {
    env(context) {
      const agent = context.value(CONVERSATION)?.agent;
      if (agent === undefined) throw new Error("a call outside a run");
      let env = envs.get(agent);
      if (env === undefined) envs.set(agent, (env = new NodeExecutionEnv({ cwd: join(root, agent) })));
      return env;
    },
    replay: "never",
  });
  const agents = ["alpha", "beta"].map((name) => defineAgent({ name, model: "faux/scripted", tools: ["write"] }));
  const s = await runtimeWith(agents, { write });

  await s.ask(await s.conversation("alpha"), "r-alpha", 'call: write {"path":"note.md","content":"from alpha"}');
  await s.ask(await s.conversation("beta"), "r-beta", 'call: write {"path":"note.md","content":"from beta"}');

  expect(readFileSync(join(root, "alpha", "note.md"), "utf8")).toBe("from alpha");
  expect(readFileSync(join(root, "beta", "note.md"), "utf8")).toBe("from beta");
  expect(existsSync(join(root, "note.md"))).toBe(false);
  await s.close();
});
