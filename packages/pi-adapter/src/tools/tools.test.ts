/**
 * Pi's tools bound to an environment: they work on it whatever the harness's context says, and
 * carry the replay their component chose.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { bindTool, createBashTool, createReadTool, createWriteTool } from "./index.ts";

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
