/**
 * Dynamic agents on Pi (SPEC §6.2a): `prepare(state)` runs in Pi's `before_run` and changes the
 * run's model, system prompt and tools; tools update the state through `AGENT_STATE`; the state
 * lives in the Pi session, so it survives a new worker and starts fresh on a new session.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AgentHarness, type AgentHarnessTool, JsonlSessionRepo, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type Message, Type } from "@earendil-works/pi-ai";
import {
  AGENT_STATE,
  type AgentDefinition,
  type AppEvents,
  BACKGROUND_CONTEXT,
  type ConversationRef,
  defineAgent,
  defineApp,
  defineComponent,
  type Logger,
} from "@pikit/core";
import { LANE } from "./inbound.ts";
import { createPiRuntime, modelsFrom, type PiExtension, type SessionStore } from "./index.ts";
import { holdTool, type ModelRequest, scriptedProvider } from "./testing/index.ts";
import { preparedAgent } from "./testing/script.ts";
import { TURN } from "./turns.ts";

const ctx = BACKGROUND_CONTEXT;
type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

const PHASE = Type.Object({ phase: Type.String() });

/** Moves the conversation's state to the phase it is called with, and returns the new state. */
const advance: AgentHarnessTool<undefined, typeof PHASE> = {
  name: "advance",
  label: "advance",
  description: "Moves the release to another phase",
  parameters: PHASE,
  async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
    const state = context.value(AGENT_STATE);
    if (state === undefined) throw new Error("no agent.state in the tool's context");
    const next = await state.update({ phase: params.phase }, context);
    return { content: [{ type: "text", text: JSON.stringify(next) }], details: undefined };
  },
};

/** An installed tool (`agent.tool`), only for the `deploying` phase. */
const deploy = holdTool(async () => "deployed");
const installed = { ...deploy, name: "deploy" } as AgentHarnessTool<undefined>;

/** Static: `faux`, "testing prompt", `advance`. Deploying: `other`, "deploying prompt", `advance` + `deploy`. */
const release = defineAgent({
  name: "release",
  model: "faux/scripted",
  systemPrompt: "testing prompt",
  tools: [advance as AgentHarnessTool<undefined>],
  state: { phase: "testing" },
  prepare: (state) =>
    state.phase === "deploying"
      ? { model: "other/scripted", systemPrompt: "deploying prompt", tools: [advance as AgentHarnessTool<undefined>, "deploy"] }
      : {},
});

/** A runtime over `sessions` with the `faux` and `other` providers, recording model requests. */
async function setup(options: { sessions?: SessionStore; agents?: AgentDefinition[]; extensions?: PiExtension[] } = {}) {
  const sessions = options.sessions ?? new MemorySessionRepo();
  const requests: ModelRequest[] = [];
  const errors: string[] = [];
  const results: Result[] = [];
  const waiters: (() => void)[] = [];
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = (result: Result) => {
        results.push(result);
        for (const wake of waiters.splice(0)) wake();
      };
      pikit.on("agent.settled", record);
      pikit.on("agent.failed", record);
    },
  });
  const quiet = () => {};
  const logger: Logger = { debug: quiet, info: quiet, warn: quiet, error: (message, fields) => void errors.push(`${message} ${JSON.stringify(fields)}`) };
  const app = await defineApp({ components: [observer], logger }).create();
  const onRequest = (request: ModelRequest) => void requests.push(structuredClone(request));
  const agents = options.agents ?? [release];
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => (name === "deploy" ? installed : undefined),
    models: modelsFrom([scriptedProvider({ onRequest }), scriptedProvider({ id: "other", onRequest })]),
    events: app.context(),
    ...(options.extensions !== undefined && { extensions: options.extensions }),
  });
  const conversation = async (agent = agents[0]?.name ?? "release"): Promise<ConversationRef> => {
    const session = await sessions.create({ cwd: "/" }, ctx);
    await session.close(ctx);
    return { key: `test:${session.metadata.id}`, agent, sessionId: session.metadata.id };
  };
  const result = async (requestId: string): Promise<Result> => {
    for (;;) {
      const found = results.find((r) => r.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  /** Dispatch `prompt` and wait for its run's end. */
  const ask = async (conversation: ConversationRef, requestId: string, prompt: string) => {
    await runtime.dispatch({ requestId, conversation, prompt }, app.context());
    return result(requestId);
  };
  return { app, runtime, sessions, requests, errors, conversation, result, ask };
}

/** The system prompt and tools a model request carried: its leading system message. */
function sent(request: ModelRequest | undefined) {
  const system = request?.messages.find((message): message is Extract<Message, { role: "system" }> => message.role === "system");
  return { systemPrompt: system?.content, tools: (system?.toolsAdded ?? []).map((tool) => tool.name) };
}

function providers(result: Result): string[] {
  return result.messages.flatMap((message) => (message.role === "assistant" ? [message.provider] : []));
}

describe("prepare (SPEC §6.2a)", () => {
  test("a tool updates the state, and the next run's prepare changes model, prompt and tools", async () => {
    const s = await setup();
    const conversation = await s.conversation();

    const first = await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
    // The whole run keeps what it started with: prepare runs once per run.
    expect(providers(first)).toEqual(["faux", "faux"]);
    expect(s.requests.map(sent)).toEqual([
      { systemPrompt: "testing prompt", tools: ["advance"] },
      { systemPrompt: "testing prompt", tools: ["advance"] },
    ]);

    const second = await s.ask(conversation, "r2", "hello");

    expect(providers(second)).toEqual(["other"]);
    expect(sent(s.requests[2])).toEqual({ systemPrompt: "deploying prompt", tools: ["advance", "deploy"] });
    await s.runtime.close(s.app.context());
  });

  test("nothing carries over: when prepare returns nothing, the run has the static definition again", async () => {
    const s = await setup();
    const conversation = await s.conversation();
    await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
    await s.ask(conversation, "r2", 'call: advance {"phase":"testing"}');

    const third = await s.ask(conversation, "r3", "hello");

    expect(providers(third)).toEqual(["faux"]);
    expect(sent(s.requests.at(-1))).toEqual({ systemPrompt: "testing prompt", tools: ["advance"] });
    await s.runtime.close(s.app.context());
  });

  test("each run's configuration is a pikit.turn entry in the session, never a message", async () => {
    const s = await setup();
    const conversation = await s.conversation();
    await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
    const second = await s.ask(conversation, "r2", "hello");
    await s.runtime.close(s.app.context());

    const metadata = (await s.sessions.list(undefined, ctx)).find((m: { id: string }) => m.id === conversation.sessionId);
    const session = await s.sessions.open(metadata, ctx);
    const models = modelsFrom([scriptedProvider()]);
    const model = models.getModel("faux", "scripted");
    if (model === undefined) throw new Error("faux/scripted missing");
    const { harness } = await AgentHarness.create({ session, models, model }, ctx);
    const turns = await (await harness.lane(LANE, ctx)).findEntries({ type: "custom", customType: TURN, order: "newestFirst" }, ctx);
    await harness.close(ctx);

    expect(turns.reverse().map((entry) => (entry.type === "custom" ? entry.data : undefined))).toEqual([
      { model: "faux/scripted", systemPrompt: "testing prompt", tools: ["advance"] },
      { model: "other/scripted", systemPrompt: "deploying prompt", tools: ["advance", "deploy"] },
    ]);
    expect(second.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
  });

  test("the state survives a new worker over JSONL sessions, and a new session starts fresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "pikit-prepare-"));
    const jsonl = () => new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
    try {
      const before = await setup({ sessions: jsonl() });
      const conversation = await before.conversation();
      await before.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
      await before.runtime.close(before.app.context());

      const after = await setup({ sessions: jsonl() });
      expect(providers(await after.ask(conversation, "r2", "hello"))).toEqual(["other"]);

      // A reset points the conversation to a new session (SPEC §7.6): the state is the initial one.
      const reset = await after.conversation();
      expect(providers(await after.ask(reset, "r3", "hello"))).toEqual(["faux"]);
      expect(sent(after.requests.at(-1))).toEqual({ systemPrompt: "testing prompt", tools: ["advance"] });
      await after.runtime.close(after.app.context());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a prepare that throws, or names a tool nobody provides, gives the run the static definition, logged", async () => {
    const broken = defineAgent({
      ...release,
      name: "broken",
      prepare: (state) => {
        if (state.phase === "deploying") throw new Error("prepare exploded");
        return state.phase === "missing" ? { tools: ["missing"] } : {};
      },
    });
    const s = await setup({ agents: [broken] });
    const conversation = await s.conversation();
    await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');

    const second = await s.ask(conversation, "r2", 'call: advance {"phase":"missing"}');
    const third = await s.ask(conversation, "r3", "hello");

    expect([second.kind, third.kind]).toEqual(["completed", "completed"]);
    expect(sent(s.requests.at(-1))).toEqual({ systemPrompt: "testing prompt", tools: ["advance"] });
    expect(s.errors).toHaveLength(2);
    expect(s.errors[0]).toContain("prepare exploded");
    expect(s.errors[1]).toContain('names the tool \\"missing\\"');
    await s.runtime.close(s.app.context());
  });
});

test("a Pi extension's before_agent_start sees the system prompt prepare chose", async () => {
  const seen: string[] = [];
  const s = await setup({ extensions: [(pi) => void pi.on("before_agent_start", (event) => void seen.push(event.systemPrompt))] });
  const conversation = await s.conversation();
  await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
  await s.ask(conversation, "r2", "hello");

  expect(seen).toEqual(["testing prompt", "deploying prompt"]);
  await s.runtime.close(s.app.context());
});

test("a Pi extension's getActiveTools() sees the tools prepare chose", async () => {
  const seen: string[][] = [];
  const s = await setup({ extensions: [(pi) => void pi.on("before_agent_start", () => void seen.push(pi.getActiveTools()))] });
  const conversation = await s.conversation();
  await s.ask(conversation, "r1", 'call: advance {"phase":"deploying"}');
  await s.ask(conversation, "r2", 'call: advance {"phase":"testing"}');
  await s.ask(conversation, "r3", "hello");

  expect(seen).toEqual([["advance"], ["advance", "deploy"], ["advance"]]);
  await s.runtime.close(s.app.context());
});

describe("a resumed run is prepared again (SPEC §6.2a)", () => {
  const WORKER = fileURLToPath(new URL("./testing/prepared-worker.ts", import.meta.url));

  /** Run `preparedAgent` in another process until its `hold` tool runs, then SIGKILL it. */
  async function killPrepared(root: string, sessionId: string, mode: "keep" | "advance"): Promise<void> {
    const worker = spawn(process.execPath, [WORKER, root, sessionId, "r-killed", mode], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    let held = false;
    for await (const line of createInterface({ input: worker.stdout })) {
      if (line === "held") {
        held = true;
        break;
      }
    }
    worker.kill("SIGKILL");
    await exited;
    if (!held) throw new Error("the prepared worker died before its run reached the tool");
  }

  async function resumeAfter(mode: "keep" | "advance", extensions?: PiExtension[]) {
    const root = mkdtempSync(join(tmpdir(), "pikit-prepared-"));
    try {
      let runs = 0;
      const agent = preparedAgent(holdTool(async () => `run ${++runs}`, "safe"));
      const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
      const s = await setup({ sessions, agents: [agent], ...(extensions !== undefined && { extensions }) });
      const conversation = await s.conversation("prepared");
      await killPrepared(root, conversation.sessionId, mode);

      await s.runtime.resume(conversation, s.app.context());
      const result = await s.result("r-killed");
      await s.runtime.close(s.app.context());
      return { runs, result, requests: s.requests };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("same state: the run keeps its prepared prompt and tool, and the safe tool runs again", async () => {
    const { runs, result, requests } = await resumeAfter("keep");

    expect(result.kind).toBe("completed");
    expect(runs).toBe(1);
    // The model call after the replayed tool: the prompt and tool prepare gave, not the static ones.
    expect(sent(requests[0])).toEqual({ systemPrompt: "holding prompt", tools: ["hold"] });
  }, 20_000);

  test("the state moved before the crash: the run goes on with what prepare gives now", async () => {
    const { runs, result, requests } = await resumeAfter("advance");

    expect(result.kind).toBe("completed");
    // `hold` is no longer the agent's: Pi records the interrupted call instead of running it again.
    expect(runs).toBe(0);
    expect(sent(requests[0])).toEqual({ systemPrompt: "done prompt", tools: [] });
  }, 20_000);

  test("a Pi extension sees the tools the resumed run was prepared with", async () => {
    const seen: string[][] = [];
    await resumeAfter("advance", [(pi) => void pi.on("turn_start", () => void seen.push(pi.getActiveTools()))]);

    // `hold` was active when the worker died; prepare gives the resumed run no tools.
    expect(seen[0]).toEqual([]);
  }, 20_000);
});
