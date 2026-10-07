/**
 * extension-house-rules in a real App: runtime-pi runs the agents on a SQLite file, the model is the
 * scripted faux provider (`faux/scripted`, from `@pikit/pi-adapter/testing`), and an agent that names
 * `house-rules` gets its section in every model request and its denied tools refused, while an agent
 * that does not name it gets neither.
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. In a project, the same test is the
 * project's own (it imports `src/pikit/runtime-pi/index.ts`), shaped like runtime-pi's
 * `extensions.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentDefinition, type AgentRuntime, type AgentTool, type ConversationRef, defineAgent } from "@pikit/contracts";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { type ModelRequest, recordingBash, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import houseRules from "./files/src/pikit/extension-house-rules/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const config = { "extension-house-rules": { rules: ["Answer in English."], deniedTools: ["bash"] } };

/** The project's agents, as `src/extensions/agents.ts` provides them. */
const agentsComponent = (agents: AgentDefinition[]) =>
  defineComponent({ name: "agents-test", setup: (pikit) => agents.forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) });

/** A `bash` stand-in that records commands, and an `execution` (never touched): the runtime refuses `bash` without one. */
const bash = (ran: string[]) =>
  defineComponent({
    name: "tool-test",
    setup(pikit) {
      pikit.provideKeyed("agent.tool", "bash", recordingBash(ran) as AgentTool);
      pikit.provide("execution", createLocalExecution({ cwd: tmpdir(), env: {} }));
    },
  });

/** The system prompt sections a request carried: pi-durable sends each change as a positional system message. */
function sections(request: ModelRequest | undefined): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) delete shown[key];
      else shown[key] = value;
    }
  }
  return shown;
}

/** An App with runtime-pi, the agents and house rules; `ask` dispatches a message and waits for the run's end. */
async function start(agents: AgentDefinition[], ran: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pikit-house-rules-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const requests: ModelRequest[] = [];
  const provider = defineComponent({
    name: "provider-test",
    setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })),
  });
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  let reached: { runtime: AgentRuntime; create: () => Promise<string> } | undefined;
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
  const components = [sqliteStorage(join(dir, "pikit.db")), agentsComponent(agents), provider, bash(ran), houseRules, runtimePi, observer];
  const app = await defineApp({ components, config, logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();

  return {
    requests,
    async ask(key: string, agent: string, prompt: string) {
      const conversation: ConversationRef = { key, agent, conversationId: await live().create() };
      const requestId = `${key}:1`;
      const before = requests.length;
      await live().runtime.dispatch({ requestId, conversation, prompt }, app.context());
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = results.find((r) => r.requestId === requestId);
        if (result !== undefined) return { result, requests: requests.slice(before) };
        if (Date.now() > deadline) throw new Error(`timed out waiting for the result of ${requestId}`);
        await Bun.sleep(5);
      }
    },
  };
}

const agents = [
  defineAgent({ name: "ruled", model: "faux/scripted", tools: ["bash"], extensions: ["house-rules"] }),
  defineAgent({ name: "plain", model: "faux/scripted", tools: ["bash"] }),
];

test("an agent that names house-rules gets the rules as a section in every request, unchanged", async () => {
  const s = await start(agents, []);

  const { requests } = await s.ask("test:ruled", "ruled", "bash: ls");

  // Two requests (the tool call, then the answer): the same section in both, sent once.
  expect(requests).toHaveLength(2);
  const text = "<house-rules>\n- Answer in English.\n- Do not call these tools, they are refused here: bash.\n</house-rules>";
  expect(requests.map((request) => sections(request)["house-rules"])).toEqual([text, text]);
  const sent = requests.at(-1)?.messages.filter((message) => message.role === "system" && message.sections?.["house-rules"] !== undefined) ?? [];
  expect(sent).toHaveLength(1);
});

test("its beforeTool hook refuses a denied tool: nothing runs, and the model reads why", async () => {
  const ran: string[] = [];
  const s = await start(agents, ran);

  const { result } = await s.ask("test:ruled", "ruled", "bash: rm -rf /");

  expect(ran).toEqual([]);
  expect(result.text).toContain('The tool "bash" is not allowed here (house rules).');
});

test("an agent that does not name it has no section and runs the tool", async () => {
  const ran: string[] = [];
  const s = await start(agents, ran);

  const { result, requests } = await s.ask("test:plain", "plain", "bash: ls");

  expect(result.text).toBe("tool said: ran");
  expect(ran).toEqual(["ls"]);
  expect(requests.map((request) => sections(request)["house-rules"])).toEqual([undefined, undefined]);
});
