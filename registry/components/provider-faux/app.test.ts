/**
 * provider-faux in a real App: runtime-pi runs agents on `faux/scripted`, which calls a tool of the
 * project when told `call: <tool> <json>`, answers with its result, and shows what an agent extension
 * put in the prompt (`echo-system`) and which tools it was offered (`echo-tools`).
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. In a project, the same test is the
 * project's own (it imports `src/pikit/runtime-pi/index.ts` and `src/pikit/provider-faux/index.ts`).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentRuntime, type AgentTool, defineAgent } from "@pikit/contracts";
import { defineExtension, defineTool, section } from "@pikit/pi-adapter/extensions";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import Type from "typebox";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import providerFaux from "./files/src/pikit/provider-faux/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A tool and an extension of the project's own, and two agents on `faux/scripted`. */
const project = (kept: string[]) =>
  defineComponent({
    name: "project-test",
    setup(pikit) {
      const keep = defineTool({
        name: "keep",
        description: "Keeps a fact",
        parameters: Type.Object({ fact: Type.String() }),
        execute: async (args) => {
          if (args.fact.includes("password")) throw new Error("secrets are never kept");
          kept.push(args.fact);
          return { content: [{ type: "text", text: `kept ${args.fact}` }] };
        },
      });
      pikit.provideKeyed("agent.tool", "keep", keep as unknown as AgentTool);
      pikit.provideKeyed("agent.extension", "notes", defineExtension({ name: "notes", sections: [section("notes", () => `${kept.length} fact(s) kept`)] }));
      pikit.provideKeyed("agent.definition", "noted", defineAgent({ name: "noted", model: "faux/scripted", tools: ["keep"], extensions: ["notes"] }));
      pikit.provideKeyed("agent.definition", "plain", defineAgent({ name: "plain", model: "faux/scripted" }));
    },
  });

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-provider-faux-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const kept: string[] = [];
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
  const app = await defineApp({ components: [sqliteStorage(join(dir, "pikit.db")), project(kept), providerFaux, runtimePi, observer], logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  let asked = 0;
  return {
    kept,
    /** The run's answer to `prompt`, in a new conversation of `agent`. */
    async ask(agent: string, prompt: string): Promise<string | undefined> {
      if (reached === undefined) throw new Error("the observer has not started");
      const requestId = `r${++asked}`;
      const conversation = { key: `test:${requestId}`, agent, conversationId: await reached.create() };
      await reached.runtime.dispatch({ requestId, conversation, prompt }, app.context());
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = results.find((r) => r.requestId === requestId);
        if (result !== undefined) return result.text;
        if (Date.now() > deadline) throw new Error(`timed out waiting for the result of ${requestId}`);
        await Bun.sleep(5);
      }
    },
  };
}

test("call: runs the project's tool with the arguments, and the answer is its result or its error", async () => {
  const s = await start();

  expect(await s.ask("noted", 'call: keep {"fact":"Ana prefers tea"}')).toBe("keep: kept Ana prefers tea");
  expect(s.kept).toEqual(["Ana prefers tea"]);
  expect(await s.ask("noted", 'call: keep {"fact":"my password is hunter2"}')).toStartWith("keep failed: ");
  expect(await s.ask("noted", 'call: keep {"fact":"my password"}')).toContain("secrets are never kept");
  expect(s.kept).toEqual(["Ana prefers tea"]);
});

test("echo-system shows what the extension put in the prompt, echo-tools what the agent was offered; an agent that names neither gets neither", async () => {
  const s = await start();
  await s.ask("noted", 'call: keep {"fact":"Ana prefers tea"}');

  expect(await s.ask("noted", "echo-system notes")).toBe("<notes>\n1 fact(s) kept\n</notes>");
  expect(await s.ask("noted", "echo-tools")).toBe("keep");
  expect(await s.ask("plain", "echo-system notes")).toBe("(no section notes)");
  expect(await s.ask("plain", "echo-tools")).toBe("(no tools)");
  expect(await s.ask("plain", "hello")).toBe("faux: hello");
});
