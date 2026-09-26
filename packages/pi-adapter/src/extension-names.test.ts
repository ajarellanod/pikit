/**
 * An agent names the Pi extensions it uses (`agent.extension`, SPEC §6.2b), as it names its tools;
 * the runtime loads them, after its own, when a conversation of that agent opens.
 */

import { expect, test } from "bun:test";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type AgentDefinition, type AppEvents, defineAgent, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { PiExtension } from "./extensions/api.ts";
import { modelsFrom } from "./models.ts";
import { createPiRuntime } from "./runtime.ts";
import { recordingBash, scriptedProvider } from "./testing/index.ts";

interface Setup {
  agents: AgentDefinition[];
  /** What `agent.extension` provides, by name. */
  installed?: Record<string, PiExtension>;
  /** The runtime's own extensions, for every agent. */
  extensions?: PiExtension[];
  ran?: string[];
}

/** One runtime with `agents`; `say` opens a conversation of an agent and answers one message. */
async function runtimeWith(setup: Setup) {
  const settled = new Map<string, (result: AppEvents["agent.settled"]) => void>();
  const observer = defineComponent({ name: "observer", setup: (pikit) => pikit.on("agent.settled", (payload) => settled.get(payload.requestId)?.(payload)) });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const sessions = new MemorySessionRepo();
  const bash = recordingBash(setup.ran ?? []);
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => setup.agents.find((agent) => agent.name === name),
    tool: (name) => (name === "bash" ? bash : undefined),
    extension: (name) => setup.installed?.[name],
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
    ...(setup.extensions !== undefined && { extensions: setup.extensions }),
  });
  const say = async (agent: string, prompt: string) => {
    const session = await sessions.create({}, app.context());
    await session.close(app.context());
    const requestId = `r-${agent}`;
    const result = new Promise<AppEvents["agent.settled"]>((resolve) => settled.set(requestId, resolve));
    await runtime.dispatch({ requestId, conversation: { key: `test:${agent}`, agent, sessionId: session.metadata.id }, prompt }, app.context());
    return (await result).text;
  };
  return { say, close: () => runtime.close(app.context()) };
}

/** An extension that records each load under `label`. */
function loading(loads: string[], label: string): PiExtension {
  return () => void loads.push(label);
}

/** An extension that blocks every call to `bash`. */
function gate(loads: string[]): PiExtension {
  return (pi) => {
    loads.push("gate");
    pi.on("tool_call", (event) => (event.toolName === "bash" ? { block: true, reason: "gated" } : undefined));
  };
}

test("only the conversations of the agent that names an extension load it; the runtime's load for all", async () => {
  const loads: string[] = [];
  const ran: string[] = [];
  const { say, close } = await runtimeWith({
    agents: [
      defineAgent({ name: "gated", model: "faux/scripted", tools: ["bash"], extensions: ["gate"] }),
      defineAgent({ name: "open", model: "faux/scripted", tools: ["bash"] }),
    ],
    installed: { gate: gate(loads) },
    extensions: [loading(loads, "runtime")],
    ran,
  });
  try {
    await say("gated", "bash: rm -rf /");
    expect(loads).toEqual(["runtime", "gate"]);
    expect(ran).toEqual([]);

    expect(await say("open", "bash: ls")).toBe("tool said: ran");
    expect(loads).toEqual(["runtime", "gate", "runtime"]);
    expect(ran).toEqual(["ls"]);
  } finally {
    await close();
  }
});

test("a name no agent.extension provides fails the conversation's open, before anything runs", async () => {
  const { say, close } = await runtimeWith({ agents: [defineAgent({ name: "coder", model: "faux/scripted", extensions: ["gate"] })] });
  try {
    await expect(say("coder", "hello")).rejects.toThrow('agent "coder" names the extension "gate", which no agent.extension provides');
  } finally {
    await close();
  }
});

test("the runtime's extensions load first, then the agent's in the order it names them, each factory once", async () => {
  const loads: string[] = [];
  const shared = loading(loads, "shared");
  const { say, close } = await runtimeWith({
    agents: [defineAgent({ name: "coder", model: "faux/scripted", extensions: ["b", "shared", "a"] })],
    installed: { a: loading(loads, "a"), b: loading(loads, "b"), shared },
    extensions: [shared, loading(loads, "runtime")],
  });
  try {
    expect(await say("coder", "hello")).toBe("answer: hello");
    expect(loads).toEqual(["shared", "runtime", "b", "a"]);
  } finally {
    await close();
  }
});
