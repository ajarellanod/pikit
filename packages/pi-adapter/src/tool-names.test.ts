/**
 * An agent names installed tools (`agent.tool`) next to tool objects of its own (SPEC §6.3); the
 * runtime resolves the names when a conversation opens.
 */

import { expect, test } from "bun:test";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type AgentDefinition, type AppEvents, defineAgent, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { modelsFrom } from "./models.ts";
import { createPiRuntime } from "./runtime.ts";
import { recordingBash, scriptedProvider } from "./testing/index.ts";

async function say(agent: AgentDefinition, tools: Record<string, ReturnType<typeof recordingBash>>, prompt: string) {
  let settled!: (result: AppEvents["agent.settled"]) => void;
  const result = new Promise<AppEvents["agent.settled"]>((resolve) => (settled = resolve));
  const observer = defineComponent({ name: "observer", setup: (pikit) => pikit.on("agent.settled", (payload) => settled(payload)) });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const sessions = new MemorySessionRepo();
  const runtime = createPiRuntime({
    sessions,
    agent: () => agent,
    tool: (name) => tools[name],
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
  });
  const session = await sessions.create({}, app.context());
  await session.close(app.context());
  const conversation = { key: "test", agent: agent.name, sessionId: session.metadata.id };
  try {
    await runtime.dispatch({ requestId: "r1", conversation, prompt }, app.context());
    return (await result).text;
  } finally {
    await runtime.close(app.context());
  }
}

test("a tool named by the agent is the installed tool of that name", async () => {
  const ran: string[] = [];

  const text = await say(defineAgent({ name: "coder", model: "faux/scripted", tools: ["bash"] }), { bash: recordingBash(ran) }, "bash: ls");

  expect(text).toBe("tool said: ran");
  expect(ran).toEqual(["ls"]);
});

test("a name no agent.tool provides fails the conversation's open, before anything runs", async () => {
  const agent = defineAgent({ name: "coder", model: "faux/scripted", tools: ["bash"] });

  await expect(say(agent, {}, "bash: ls")).rejects.toThrow('agent "coder" names the tool "bash", which no agent.tool provides');
});
