/**
 * runtime-pi's tests. They are copied with the component and keep running in your project.
 * They use `@pikit/pi-adapter/testing` for a scripted model, so they need no API key and never
 * import Pi.
 */

import { expect, test } from "bun:test";
import { type AgentRuntime, defineAgent, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createAgentRuntimeConformance, createLifecycleConformance } from "@pikit/core/testing";
import type { SessionStore } from "@pikit/pi-adapter";
import { createPiRuntimeFixture, testComponents } from "@pikit/pi-adapter/testing";
import runtimePi, { createRuntimePi } from "./index.ts";

// The agent.runtime contract, including a worker killed mid-run (SPEC §14).
for (const c of createAgentRuntimeConformance(() => createPiRuntimeFixture(({ onHarness }) => [createRuntimePi({ onHarness })]))) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run(), 30_000);
}

// Start and stop honour their deadline and leave nothing open.
for (const c of createLifecycleConformance(() => {
  const { sessions, agents, provider } = testComponents();
  return { component: runtimePi, providers: [sessions, agents, provider] };
})) {
  test(`runtime-pi ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const { sessions, agents, provider } = testComponents();
  const app = await defineApp({ components: [sessions, agents, provider, runtimePi], logger: silentLogger }).create();

  const described = app.describe().components.find((component) => component.name === "runtime-pi");

  expect(described).toMatchObject({
    provides: ["agent.runtime"],
    requires: ["sessions.store"],
    optional: ["agent.definition", "model.provider"],
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
