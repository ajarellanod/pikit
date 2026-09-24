/**
 * tool-write's tests. They are copied with the component and keep running in your project. The tool
 * works on a test environment over a temporary directory (`createLocalExecution`, the one behind
 * `execution-local`).
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import toolUnderTest from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** What Pi passes to a tool call; a direct call has no run to identify. */
const invocation = {
  invocationId: "invocation-1",
  operationId: "operation-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("");
}

/** The tool as installed in a started app, over a temporary working directory. */
async function installed(): Promise<{ tool: AgentTool; dir: string; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pikit-tool-write-"));
  directories.push(dir);
  const env = createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  const execution = defineComponent({
    name: "execution-test",
    setup(pikit) {
      pikit.provide("execution", env);
      pikit.provide("execution.shell", env);
    },
  });
  let tool: AgentTool | undefined;
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const tools = pikit.useKeyed("agent.tool");
      return { start: () => void (tool = tools.get("write")) };
    },
  });
  const app = await defineApp({ components: [execution, toolUnderTest, reader], logger: silentLogger }).create();
  await app.start();
  if (tool === undefined) throw new Error("agent.tool write was not provided");
  return { tool, dir, stop: () => app.stop() };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const env = createLocalExecution({ cwd: tmpdir(), env: {} });
  const execution = defineComponent({
    name: "execution-test",
    setup(pikit) {
      pikit.provide("execution", env);
      pikit.provide("execution.shell", env);
    },
  });
  const app = await defineApp({ components: [execution, toolUnderTest], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "tool-write")).toMatchObject({
    provides: ["agent.tool"],
    requires: ["execution"],
    optional: [],
  });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ write: "tool-write" });
});

test("it provides Pi's write tool under its own name, with replay never", async () => {
  const s = await installed();

  expect([s.tool.name, s.tool.replay]).toEqual(["write", "never"]);
  await s.stop();
});

test("the agent writes a file, creating its directories", async () => {
  const s = await installed();

  await s.tool.execute("call-1", { path: "docs/new.md", content: "# New\n" }, () => {}, undefined, invocation, BACKGROUND_CONTEXT);

  expect(readFileSync(join(s.dir, "docs/new.md"), "utf8")).toBe("# New\n");
  await s.stop();
});
