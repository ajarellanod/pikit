import { expect, test } from "bun:test";
import {
  type Admission,
  type AgentDefinition,
  type AgentRuntime,
  type AgentTool,
  type AppEvents,
  defineAgent,
  defineApp,
  defineComponent,
  silentLogger,
} from "./index.ts";

test("defineAgent returns the definition unchanged", () => {
  const definition = { name: "support", model: "anthropic/claude-sonnet", systemPrompt: "Be brief." };
  expect(defineAgent(definition)).toBe(definition);
  // A model id may contain slashes of its own: only the provider is split off.
  expect(defineAgent({ name: "router-2", model: "openrouter/anthropic/claude" }).model).toBe(
    "openrouter/anthropic/claude",
  );
});

test("defineAgent rejects a name that is not kebab-case and a model without a provider", () => {
  expect(() => defineAgent({ name: "Support", model: "anthropic/claude" })).toThrow("kebab-case");
  expect(() => defineAgent({ name: "support", model: "claude" })).toThrow('"provider/modelId"');
  expect(() => defineAgent({ name: "support", model: "anthropic/" })).toThrow('"provider/modelId"');
});

test("an agent names installed tools by name, next to tools of its own", () => {
  const own = { name: "lookup" } as unknown as AgentTool;
  const coder = defineAgent({ name: "coder", model: "faux/scripted", tools: ["read", "bash", own] });

  expect(coder.tools).toEqual(["read", "bash", own]);
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: ["read", "read"] })).toThrow('tool "read" is named twice');
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: ["rm -rf"] })).toThrow("is not a tool name");
  expect(() => defineAgent({ name: "coder", model: "faux/scripted", tools: [""] })).toThrow("is not a tool name");
});

test("prepare is a plain function from state to what changes for the run", () => {
  const deploy = { name: "deploy" } as unknown as AgentTool;
  const release = defineAgent({
    name: "release",
    model: "anthropic/claude-sonnet",
    tools: ["run_tests"],
    state: { phase: "testing", testsPassed: false },
    prepare(state) {
      return {
        model: state.phase === "summarize" ? "anthropic/claude-haiku" : undefined,
        tools: state.testsPassed ? ["run_tests", deploy] : undefined,
      };
    },
  });
  const ctx = { conversation: { key: "t:http:c1", agent: "release", sessionId: "s1" } };

  expect(release.prepare?.({ phase: "testing", testsPassed: false }, ctx)).toEqual({ model: undefined, tools: undefined });
  expect(release.prepare?.({ phase: "summarize", testsPassed: true }, ctx)).toEqual({
    model: "anthropic/claude-haiku",
    tools: ["run_tests", deploy],
  });
  // A definition with a typed state is still an agent.definition.
  const provided: AgentDefinition = release;
  void provided;
});

test("defineAgent rejects a state that is not a JSON object", () => {
  expect(() => defineAgent({ name: "a", model: "x/y", state: [] })).toThrow("state must be a JSON object");
  expect(() => defineAgent({ name: "a", model: "x/y", state: { at: new Date(0) } })).toThrow("state must be a JSON object");
  expect(() => defineAgent({ name: "a", model: "x/y", state: { fn: () => 1 } })).toThrow("state must be a JSON object");
  expect(defineAgent({ name: "a", model: "x/y", state: { list: [1, "two", null, { three: true }] } }).state).toEqual({
    list: [1, "two", null, { three: true }],
  });
});

test("agent.runtime and agent.definition are typed capabilities, agent.* typed events", async () => {
  const support = defineAgent({ name: "support", model: "faux/scripted" });
  const conversation = { key: "t:http:c1", agent: "support", sessionId: "s1" };
  const seen: string[] = [];

  // A stand-in runtime: it only checks that the agent exists and reports a started run.
  const runtime = defineComponent({
    name: "runtime-fake",
    setup(pikit) {
      const agents = pikit.useKeyed("agent.definition");
      const fake: AgentRuntime = {
        async dispatch(request, ctx) {
          if (agents.get(request.conversation.agent) === undefined) throw new Error("unknown agent");
          const admission: Admission = { kind: "started", requestId: request.requestId };
          await ctx.emit("agent.dispatched", { conversation: request.conversation, admission });
          await ctx.emit("agent.settled", {
            ...admission,
            requestIds: [admission.requestId],
            conversation: request.conversation,
            kind: "completed",
            messages: [],
          });
          return admission;
        },
        async abort() {},
        async resume() {},
      };
      pikit.provide("agent.runtime", fake);
    },
  });
  const agents = defineComponent({
    name: "agents",
    setup(pikit) {
      pikit.provideKeyed("agent.definition", support.name, support);
    },
  });
  const channel = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const agentRuntime = pikit.use("agent.runtime");
      pikit.on("agent.dispatched", ({ admission }) => void seen.push(`dispatched:${admission.kind}`));
      pikit.on("agent.settled", (result: AppEvents["agent.settled"]) => void seen.push(`settled:${result.kind}`));
      return {
        async start(ctx) {
          seen.push(`admission:${(await agentRuntime.get().dispatch({ requestId: "r1", conversation, prompt: "hi" }, ctx)).kind}`);
        },
      };
    },
  });

  const app = await defineApp({ components: [channel, runtime, agents], logger: silentLogger }).create();
  await app.start();
  await app.stop();

  expect(seen).toEqual(["dispatched:started", "settled:completed", "admission:started"]);
  expect(app.describe().capabilities["agent.definition"]?.keys).toEqual({ support: "agents" });
});

test("agent.settled carries completed or aborted runs; failures are agent.failed", () => {
  const conversation = { key: "k", agent: "support", sessionId: "s" };
  const failed: AppEvents["agent.failed"] = {
    conversation,
    requestId: "r1",
    requestIds: ["r1"],
    kind: "failed",
    messages: [],
    error: { code: "provider", message: "down" },
  };
  // @ts-expect-error a failed run is not an agent.settled payload
  const settled: AppEvents["agent.settled"] = failed;
  void settled;
  expect(failed.kind).toBe("failed");
});
