/**
 * Pi's tools bound to an environment: they work on it whatever the harness's context says, and
 * carry the replay their component chose.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type AgentHarnessTool, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import { type Context, defineApp, defineComponent, silentLogger, withCancel } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { agentTool, bindTool, createBashTool, createReadTool, createWriteTool, toolComponent } from "./index.ts";

const invocation: AgentHarnessToolInvocation = {
  invocationId: "i1",
  operationId: "o1",
  turnId: "t1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

test("a bound tool works on its own environment and carries its replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-tools-"));
  writeFileSync(join(dir, "notes.md"), "hello from the workspace\n");
  const env = new NodeExecutionEnv({ cwd: dir });
  const read = bindTool(createReadTool(), { env: () => env, replay: "safe" });
  const write = bindTool(createWriteTool(), { env: () => env, replay: "never" });
  const bash = bindTool(createBashTool(), { env: () => env, replay: "never" });

  // The harness passes no context at all: the tool uses its own environment.
  const read1 = await read.execute("c1", { path: "notes.md" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT);
  await write.execute("c2", { path: "out/new.txt", content: "written" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT);
  const ran = await bash.execute("c3", { command: "cat out/new.txt" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT);

  expect([read.name, read.replay, write.replay, bash.replay]).toEqual(["read", "safe", "never", "never"]);
  expect(textOf(read1)).toContain("hello from the workspace");
  expect(readFileSync(join(dir, "out/new.txt"), "utf8")).toBe("written");
  expect(textOf(ran)).toContain("written");
  rmSync(dir, { recursive: true, force: true });
});

/** Starts an app with `components` and returns every `agent.tool` it provides, by name. */
async function toolsOf(...components: Parameters<typeof defineApp>[0]["components"]) {
  let tools: Map<string, AgentTool> | undefined;
  const consumer = defineComponent({
    name: "tools-consumer",
    setup(pikit) {
      const handle = pikit.useKeyed("agent.tool");
      return { start: () => void (tools = new Map(handle.keys().map((key) => [key, handle.get(key) as AgentTool]))) };
    },
  });
  const app = await defineApp({ components: [...components, consumer], logger: silentLogger }).create();
  await app.start();
  return { app, tools: tools ?? new Map<string, AgentTool>() };
}

test("toolComponent: a tool in Pi's shape, provided as agent.tool under its name, with its replay", async () => {
  const calls: { toolCallId: string; params: unknown; signal: AbortSignal | undefined; context: Context }[] = [];
  const updates: unknown[] = [];
  const search = toolComponent(
    {
      name: "web_search",
      label: "Web search",
      description: "Searches the web",
      parameters: Type.Object({ query: Type.String() }),
      async execute(toolCallId, params, signal, onUpdate, context) {
        calls.push({ toolCallId, params, signal, context });
        onUpdate?.({ content: [{ type: "text", text: "searching" }], details: undefined });
        return { content: [{ type: "text", text: `results for ${params.query}` }], details: undefined };
      },
    },
    { replay: "safe" },
  );
  const { app, tools } = await toolsOf(search);

  expect(app.describe().components.find((c) => c.name === "tool-web-search")).toMatchObject({ provides: ["agent.tool"], requires: [], optional: [] });
  const tool = tools.get("web_search") as AgentHarnessTool<undefined>;
  expect([tool.name, tool.label, tool.replay]).toEqual(["web_search", "Web search", "safe"]);

  // Pi's harness calls it; the definition gets Pi's order: the call's id, its params, the run's signal, onUpdate, the run's context.
  const { context: run, cancel } = withCancel(BACKGROUND_CONTEXT);
  const result = await tool.execute("c1", { query: "pikit" }, (partial) => void updates.push(partial), undefined, invocation, run);
  expect(textOf(result)).toBe("results for pikit");
  expect(calls).toEqual([{ toolCallId: "c1", params: { query: "pikit" }, signal: run.abortSignal, context: run }]);
  expect(updates).toEqual([{ content: [{ type: "text", text: "searching" }], details: undefined }]);
  cancel();
  await app.stop();
});

test("agentTool: the same tool for a component of your own, which names itself and uses a capability", async () => {
  const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async () => "s3cret" }) });
  const search = defineComponent({
    name: "tool-web-search-brave",
    setup(pikit) {
      const store = pikit.use("secrets");
      const tool = agentTool(
        {
          name: "web_search",
          label: "Web search",
          description: "Searches the web",
          parameters: Type.Object({ query: Type.String() }),
          async execute(_toolCallId, params) {
            const key = await store.get().get("KEY");
            return { content: [{ type: "text", text: `${params.query} with a key of ${key?.length}` }], details: undefined };
          },
        },
        { replay: "never" },
      );
      pikit.provideKeyed("agent.tool", tool.name, tool);
    },
  });
  const { app, tools } = await toolsOf(secrets, search);

  expect(app.describe().components.find((c) => c.name === "tool-web-search-brave")).toMatchObject({ provides: ["agent.tool"], requires: ["secrets"] });
  const tool = tools.get("web_search") as AgentHarnessTool<undefined>;
  expect([tool.name, tool.replay]).toEqual(["web_search", "never"]);
  expect(textOf(await tool.execute("c1", { query: "pikit" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT))).toBe("pikit with a key of 6");
  await app.stop();
});

test("toolComponent takes the object of a Pi tool as it is", async () => {
  // Pi's own `hello` example, its object unchanged, written inside toolComponent instead of defineTool.
  const { app, tools } = await toolsOf(
    toolComponent(
      {
        name: "hello",
        label: "Hello",
        description: "A simple greeting tool",
        parameters: Type.Object({ name: Type.String({ description: "Name to greet" }) }),
        async execute(_toolCallId, params, _signal, _onUpdate) {
          return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: { greeted: params.name } };
        },
      },
      { replay: "never" },
    ),
  );
  const tool = tools.get("hello") as AgentHarnessTool<undefined>;

  expect(tool.replay).toBe("never");
  expect(textOf(await tool.execute("c1", { name: "Ada" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT))).toBe("Hello, Ada!");
  await app.stop();
});
