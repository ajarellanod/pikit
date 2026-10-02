/**
 * tool-edit's tests. They are copied with the component and keep running in your project. The tool
 * is called on a test environment over a temporary directory (`createLocalExecution`, the one behind
 * `execution-local`), as the runtime gives it one per call.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { callTool } from "@pikit/pi-adapter/execution/testing";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import toolUnderTest from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** `execution` and `execution.shell` over `env`, as execution-local provides them. */
function executionOf(env: ExecutionEnv) {
  return defineComponent({
    name: "execution-test",
    setup(pikit) {
      pikit.provide("execution", env);
      pikit.provide("execution.shell", env);
    },
  });
}

/** The tool as installed in a started app, and an environment over a temporary directory. */
async function installed(): Promise<{ tool: AgentTool; dir: string; env: ExecutionEnv; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pikit-tool-edit-"));
  directories.push(dir);
  const env = createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } });
  let tool: AgentTool | undefined;
  const reader = defineComponent({
    name: "tool-reader",
    setup(pikit) {
      const tools = pikit.useKeyed("agent.tool");
      return { start: () => void (tool = tools.get("edit")) };
    },
  });
  const app = await defineApp({ components: [executionOf(env), toolUnderTest, reader], logger: silentLogger }).create();
  await app.start();
  if (tool === undefined) throw new Error("agent.tool edit was not provided");
  return { tool, dir, env, stop: () => app.stop() };
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [executionOf(createLocalExecution({ cwd: tmpdir(), env: {} })), toolUnderTest], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "tool-edit")).toMatchObject({
    provides: ["agent.tool"],
    requires: ["execution"],
    optional: ["workspace"],
  });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ edit: "tool-edit" });
});

test("it provides pi-durable's edit tool under its own name, with replay unsafe", async () => {
  const s = await installed();

  expect([s.tool.name, s.tool.replay]).toEqual(["edit", "unsafe"]);
  await s.stop();
});

test("the agent replaces exact text in a file", async () => {
  const s = await installed();
  writeFileSync(join(s.dir, "c.txt"), "one two three\n");

  const result = await callTool(s.tool, { path: "c.txt", edits: [{ oldText: "two", newText: "2" }] }, { env: s.env });

  expect(result.isError).toBe(false);
  expect(readFileSync(join(s.dir, "c.txt"), "utf8")).toBe("one 2 three\n");
  await s.stop();
});
