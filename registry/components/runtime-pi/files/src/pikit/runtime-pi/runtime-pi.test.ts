/**
 * runtime-pi's tests. They are copied with the component and keep running in your project.
 * They use `@pikit/pi-adapter/testing` for a scripted model, so they need no API key and never
 * import Pi.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { AGENT_STATE, type AgentRuntime, type AgentSubmissions, type AgentTool, defineAgent } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createAgentRuntimeConformance, createMemorySubmissions } from "@pikit/contracts/testing";
import type { Credential, CredentialStore, SessionStore } from "@pikit/pi-adapter";
import { createJsonlSessionStore } from "@pikit/pi-adapter/node";
import { createPiRuntimeFixture, killMidRun, recordingBash, scriptedProvider, testComponents } from "@pikit/pi-adapter/testing";
import Type from "typebox";
import runtimePi, { createRuntimePi } from "./index.ts";

// The agent.runtime contract, including a worker killed mid-run (SPEC §14).
for (const c of createAgentRuntimeConformance(() => createPiRuntimeFixture(({ onHarness }) => [createRuntimePi({ onHarness })]))) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

/** `agent.submissions` in memory, outliving the apps of a test as a database would. */
function memorySubmissions(submissions: AgentSubmissions = createMemorySubmissions().submissions) {
  return defineComponent({ name: "submissions-test", setup: (pikit) => pikit.provide("agent.submissions", submissions) });
}

// The same contract with agent.submissions installed: recording changes nothing a channel sees.
for (const c of createAgentRuntimeConformance(() =>
  createPiRuntimeFixture(({ onHarness }) => [memorySubmissions(), createRuntimePi({ onHarness })]),
)) {
  test(`runtime-pi with agent.submissions ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

// Start and stop honour their deadline and leave nothing open, with and without agent.submissions.
for (const c of createLifecycleConformance(() => {
  const { sessions, agents, provider } = testComponents();
  return { component: runtimePi, providers: [sessions, agents, provider] };
})) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run());
}
for (const c of createLifecycleConformance(() => {
  const { sessions, agents, provider } = testComponents();
  return { component: runtimePi, providers: [sessions, agents, provider, memorySubmissions()] };
})) {
  test(`runtime-pi with agent.submissions ${c.group}: ${c.name}`, () => c.run());
}

test("at start, a conversation agent.submissions holds pending is resumed, with no new message", async () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-runtime-pi-resume-"));
  try {
    const store = createJsonlSessionStore({ root, cwd: root });
    const { submissions } = createMemorySubmissions();
    const ctx = (await defineApp({ components: [], logger: silentLogger }).create()).context();
    const session = await store.create({ cwd: root }, ctx);
    await session.close(ctx);
    const conversation = { key: "test:resume", agent: "scripted", sessionId: session.metadata.id };
    // A process admitted the message, told its platform, and was killed mid-run.
    await killMidRun(root, conversation.sessionId, "r-killed", "never");
    await submissions.admitted(conversation, "r-killed", ctx);

    const { agents, provider, sessions } = testComponents({ sessions: store });
    const settled: AppEvents["agent.settled"][] = [];
    const observer = defineComponent({ name: "observer", setup: (pikit) => pikit.on("agent.settled", (result) => void settled.push(result)) });
    const app = await defineApp({ components: [sessions, agents, provider, memorySubmissions(submissions), runtimePi, observer], logger: silentLogger }).create();
    await app.start();
    try {
      const deadline = Date.now() + 10_000;
      while (settled.length === 0) {
        if (Date.now() > deadline) throw new Error("the interrupted run was never resumed");
        await Bun.sleep(10);
      }
      expect(settled.map((r) => [r.requestId, r.kind])).toEqual([["r-killed", "completed"]]);
      expect((await submissions.get(conversation, "r-killed", app.context()))?.kind).toBe("settled");
      expect(await submissions.pending(app.context())).toEqual([]);
    } finally {
      await app.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("stop, with no deadline, does not wait for an agent.submissions whose pending() never answers", async () => {
  const { submissions } = createMemorySubmissions();
  const hung: AgentSubmissions = { ...submissions, pending: () => new Promise(() => {}) };
  const { sessions, agents, provider } = testComponents();
  const app = await defineApp({ components: [sessions, agents, provider, memorySubmissions(hung), runtimePi], logger: silentLogger }).create();
  await app.start();

  const stopped = app.stop().then(() => "stopped");

  expect(await Promise.race([stopped, Bun.sleep(2_000).then(() => "still waiting")])).toBe("stopped");
});

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const { sessions, agents, provider } = testComponents();
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  const described = app.describe().components.find((component) => component.name === "runtime-pi");

  expect(described).toMatchObject({
    provides: ["agent.runtime"],
    requires: ["sessions.store"],
    optional: ["agent.definition", "model.provider", "model.credentials", "agent.tool", "agent.extension", "agent.submissions"],
  });
});

/** Why `start()` failed: the app reports the component, the cause says why. */
async function startFailure(app: { start(): Promise<void> }): Promise<string> {
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("expected start() to fail");
  return String(error.cause instanceof Error ? error.cause.message : error.cause);
}

test("Pi extensions given to createRuntimePi see the conversation's tool calls", async () => {
  const calls: string[] = [];
  const runtime = createRuntimePi({
    extensions: [(pi) => void pi.on("tool_call", (event) => void calls.push(event.toolName))],
  });
  const { sessions, agents, provider } = testComponents();
  let answered!: (text: string | undefined) => void;
  const answer = new Promise<string | undefined>((resolve) => (answered = resolve));
  // Stands for a channel: it reaches the runtime and the sessions through their capabilities.
  let channel!: { runtime: AgentRuntime; sessions: SessionStore };
  const observer = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const runtimeHandle = pikit.use("agent.runtime");
      const sessionsHandle = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => answered(result.text));
      return { start: () => void (channel = { runtime: runtimeHandle.get(), sessions: sessionsHandle.get() }) };
    },
  });
  const app = await defineApp({ components: [sessions, agents, provider, runtime, observer], logger: silentLogger }).create();
  await app.start();

  const ctx = app.context();
  const session = await channel.sessions.create({}, ctx);
  await session.close(ctx);
  const conversation = { key: "test:ext", agent: "scripted", sessionId: session.metadata.id };
  await channel.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, ctx);

  expect(await answer).toBe("answer: hold");
  expect(calls).toEqual(["hold"]);
  await app.stop();
});

test("a Pi extension provided as agent.extension reaches only the agent that names it", async () => {
  const calls: string[] = [];
  // Stands for a project component installing an extension under its name.
  const gate = defineComponent({
    name: "extension-test",
    setup: (pikit) =>
      pikit.provideKeyed("agent.extension", "record-calls", (pi) => void pi.on("tool_call", (event) => void calls.push(event.toolName))),
  });
  const { sessions, agents, provider } = testComponents({
    agents: [
      defineAgent({ name: "named", model: "faux/scripted", tools: ["bash"], extensions: ["record-calls"] }),
      defineAgent({ name: "plain", model: "faux/scripted", tools: ["bash"] }),
    ],
  });
  const answers = new Map<string, (text: string | undefined) => void>();
  let channel!: { runtime: AgentRuntime; sessions: SessionStore };
  const observer = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const runtimeHandle = pikit.use("agent.runtime");
      const sessionsHandle = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => answers.get(result.requestId)?.(result.text));
      return { start: () => void (channel = { runtime: runtimeHandle.get(), sessions: sessionsHandle.get() }) };
    },
  });
  const app = await defineApp({
    components: [sessions, agents, provider, bashComponent([]), gate, runtimePi, observer],
    logger: silentLogger,
  }).create();
  await app.start();
  const ctx = app.context();
  const ask = async (agent: string, prompt: string) => {
    const session = await channel.sessions.create({}, ctx);
    await session.close(ctx);
    const answer = new Promise<string | undefined>((resolve) => answers.set(agent, resolve));
    await channel.runtime.dispatch({ requestId: agent, conversation: { key: `test:${agent}`, agent, sessionId: session.metadata.id }, prompt }, ctx);
    return answer;
  };

  await ask("plain", "bash: ls");
  await ask("named", "bash: pwd");

  expect(calls).toEqual(["bash"]);
  await app.stop();
});

test("it refuses to start when an agent names an extension no agent.extension provides", async () => {
  const { sessions, agents, provider } = testComponents({
    agents: [defineAgent({ name: "scripted", model: "faux/scripted", extensions: ["permission-gate"] })],
  });
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('agent "scripted" names the extension "permission-gate", which no agent.extension provides');
});

test("it refuses to start without an agent", async () => {
  const { sessions, provider } = testComponents();
  const app = await defineApp({ components: [sessions, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain("no agent.definition");
});

test("it refuses to start when an agent names a model no provider has", async () => {
  const { sessions, agents, provider } = testComponents({
    agents: [defineAgent({ name: "support", model: "anthropic/claude-sonnet" })],
  });
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('"anthropic/claude-sonnet"');
});

/** A provider that is configured only by an API key stored in `model.credentials`. */
const keyedProvider = defineComponent({
  name: "provider-keyed",
  setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider({ apiKey: "made-up-key" })),
});

/** A `model.credentials` holding `stored`, kept in memory for the test. */
function credentialsHolding(stored: Record<string, Credential>) {
  const store: CredentialStore = {
    read: async (id) => stored[id],
    list: async () => Object.entries(stored).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: async (id, fn) => {
      const next = await fn(stored[id]);
      if (next !== undefined) stored[id] = next;
      return next ?? stored[id];
    },
    delete: async (id) => void delete stored[id],
  };
  return defineComponent({ name: "credentials-test", setup: (pikit) => pikit.provide("model.credentials", store) });
}

test("it refuses to start when an agent's provider has no credentials", async () => {
  const { sessions, agents } = testComponents();
  const app = await defineApp({ components: [sessions, agents, keyedProvider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('provider "faux", which has no credentials');
});

test("it builds the models with model.credentials: a stored key lets the agent answer", async () => {
  const { sessions, agents } = testComponents();
  let answered!: (text: string | undefined) => void;
  const answer = new Promise<string | undefined>((resolve) => (answered = resolve));
  let channel!: { runtime: AgentRuntime; sessions: SessionStore };
  const observer = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const runtimeHandle = pikit.use("agent.runtime");
      const sessionsHandle = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => answered(result.text));
      return { start: () => void (channel = { runtime: runtimeHandle.get(), sessions: sessionsHandle.get() }) };
    },
  });
  const credentials = credentialsHolding({ faux: { type: "api_key", key: "made-up-key" } });
  const app = await defineApp({
    components: [sessions, agents, keyedProvider, credentials, runtimePi, observer],
    logger: silentLogger,
  }).create();
  await app.start();

  const ctx = app.context();
  const session = await channel.sessions.create({}, ctx);
  await session.close(ctx);
  await channel.runtime.dispatch({ requestId: "r1", conversation: { key: "test:keyed", agent: "scripted", sessionId: session.metadata.id }, prompt: "hello" }, ctx);

  expect(await answer).toBe("answer: hello");
  await app.stop();
});

/** Provides `bash` as a `tool-bash` component would, recording what it is asked to run. */
function bashComponent(ran: string[], key = "bash") {
  return defineComponent({ name: "tool-test", setup: (pikit) => pikit.provideKeyed("agent.tool", key, recordingBash(ran)) });
}

test("an agent's named tools are the installed agent.tool ones", async () => {
  const ran: string[] = [];
  const { sessions, agents, provider } = testComponents({ agents: [defineAgent({ name: "scripted", model: "faux/scripted", tools: ["bash"] })] });
  let answered!: (text: string | undefined) => void;
  const answer = new Promise<string | undefined>((resolve) => (answered = resolve));
  let channel!: { runtime: AgentRuntime; sessions: SessionStore };
  const observer = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const runtimeHandle = pikit.use("agent.runtime");
      const sessionsHandle = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => answered(result.text));
      return { start: () => void (channel = { runtime: runtimeHandle.get(), sessions: sessionsHandle.get() }) };
    },
  });
  const app = await defineApp({ components: [sessions, agents, provider, bashComponent(ran), runtimePi, observer], logger: silentLogger }).create();
  await app.start();

  const ctx = app.context();
  const session = await channel.sessions.create({}, ctx);
  await session.close(ctx);
  await channel.runtime.dispatch({ requestId: "r1", conversation: { key: "test:tools", agent: "scripted", sessionId: session.metadata.id }, prompt: "bash: ls" }, ctx);

  expect(await answer).toBe("tool said: ran");
  expect(ran).toEqual(["ls"]);
  await app.stop();
});

test("it refuses to start when an agent names a tool no agent.tool provides", async () => {
  const { sessions, agents, provider } = testComponents({ agents: [defineAgent({ name: "scripted", model: "faux/scripted", tools: ["bash"] })] });
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('agent "scripted" names the tool "bash", which no agent.tool provides');
});

test("it refuses to start when a tool is provided under another name", async () => {
  const { sessions, agents, provider } = testComponents();
  const app = await defineApp({ components: [sessions, agents, provider, bashComponent([], "shell"), runtimePi], logger: silentLogger }).create();

  expect(await startFailure(app)).toContain('the agent.tool "shell" is a tool named "bash"');
});

/** Moves the conversation's state to the phase it is called with (SPEC §6.2a). */
const advance: AgentTool = {
  name: "advance",
  label: "advance",
  description: "Moves the release to another phase",
  parameters: Type.Object({ phase: Type.String() }),
  async execute(_toolCallId, params, _onUpdate, _toolContext, _invocation, context) {
    await context.value(AGENT_STATE)?.update({ phase: (params as { phase: string }).phase }, context);
    return { content: [{ type: "text", text: "advanced" }], details: undefined };
  },
};

test("an agent's prepare gives it bash once a tool has moved its state on", async () => {
  const ran: string[] = [];
  const release = defineAgent({
    name: "scripted",
    model: "faux/scripted",
    tools: [advance],
    state: { phase: "testing" },
    prepare: (state) => (state.phase === "deploying" ? { tools: [advance, "bash"] } : {}),
  });
  const { sessions, agents, provider } = testComponents({ agents: [release] });
  const answers = new Map<string, (text: string | undefined) => void>();
  let channel!: { runtime: AgentRuntime; sessions: SessionStore };
  const observer = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const runtimeHandle = pikit.use("agent.runtime");
      const sessionsHandle = pikit.use("sessions.store");
      pikit.on("agent.settled", (result) => answers.get(result.requestId)?.(result.text));
      return { start: () => void (channel = { runtime: runtimeHandle.get(), sessions: sessionsHandle.get() }) };
    },
  });
  const app = await defineApp({ components: [sessions, agents, provider, bashComponent(ran), runtimePi, observer], logger: silentLogger }).create();
  await app.start();
  const ctx = app.context();
  const session = await channel.sessions.create({}, ctx);
  await session.close(ctx);
  const conversation = { key: "test:prepare", agent: "scripted", sessionId: session.metadata.id };
  const ask = (requestId: string, prompt: string) => {
    const answer = new Promise<string | undefined>((resolve) => answers.set(requestId, resolve));
    return channel.runtime.dispatch({ requestId, conversation, prompt }, ctx).then(() => answer);
  };

  await ask("r1", "bash: ls");
  await ask("r2", 'call: advance {"phase":"deploying"}');
  const deployed = await ask("r3", "bash: ls");

  // The first `bash` call reached no tool: the agent did not have it yet.
  expect(ran).toEqual(["ls"]);
  expect(deployed).toBe("tool said: ran");
  await app.stop();
});
