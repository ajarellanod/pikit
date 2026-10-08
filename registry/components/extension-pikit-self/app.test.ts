/**
 * extension-pikit-self in a real App: runtime-pi runs the agents on a SQLite file, the model is the
 * scripted faux provider (`faux/scripted`, from `@pikit/pi-adapter/testing`), and an agent that names
 * `pikit-self` gets the section (the guide, then what runs now) in every model request, sent once,
 * while an agent that does not name it gets none.
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
import { type AgentDefinition, type AgentRuntime, type ConversationRef, defineAgent } from "@pikit/contracts";
import { type ModelRequest, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import pikitSelf from "./files/src/pikit/extension-pikit-self/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The project's agents, as `src/extensions/agents.ts` provides them. */
const agentsComponent = (agents: AgentDefinition[]) =>
  defineComponent({ name: "agents", setup: (pikit) => agents.forEach((agent) => pikit.provideKeyed("agent.definition", agent.name, agent)) });

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

/** An App with runtime-pi, the agents and pikit-self; `ask` dispatches a message and waits for the run's end. */
async function start(agents: AgentDefinition[]) {
  const dir = mkdtempSync(join(tmpdir(), "pikit-self-"));
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
  const components = [sqliteStorage(join(dir, "pikit.db")), agentsComponent(agents), provider, pikitSelf, runtimePi, observer];
  const app = await defineApp({ components, logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();

  return {
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
  defineAgent({ name: "steward", model: "faux/scripted", steward: true, extensions: ["pikit-self"] }),
  defineAgent({ name: "plain", model: "faux/scripted" }),
];

test("an agent that names pikit-self gets the guide and what runs now in every request, sent once", async () => {
  const s = await start(agents);

  const { requests } = await s.ask("test:steward", "steward", "what are you made of?");

  expect(requests.length).toBeGreaterThan(0);
  const text = sections(requests[0])["pikit-self"] ?? "";
  expect(text).toStartWith("<pikit-self>\nYou are an agent of a pikit project");
  expect(text).toContain("https://github.com/ajarellanod/pikit/tree/main/docs/concepts.md");
  expect(text).toContain("- runtime-pi: ");
  expect(text).toContain("- extension-pikit-self: agent.extension (pikit-self)");
  expect(text).toContain("Agents:\n- plain: model faux/scripted; tools none\n- steward (the steward): model faux/scripted; tools none; extensions pikit-self");
  for (const request of requests) expect(sections(request)["pikit-self"]).toBe(text);
  const sent = requests.at(-1)?.messages.filter((message) => message.role === "system" && message.sections?.["pikit-self"] !== undefined) ?? [];
  expect(sent).toHaveLength(1);
});

test("an agent that does not name it has no section", async () => {
  const s = await start(agents);

  const { requests } = await s.ask("test:plain", "plain", "hello");

  expect(requests.map((request) => sections(request)["pikit-self"])).toEqual(requests.map(() => undefined));
});
