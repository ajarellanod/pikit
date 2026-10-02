/**
 * pi-durable's coding tools as pikit provides them (`codingTool`): their names and replays, called
 * directly on a local environment, and in a real Harness turn whose environment comes from
 * `harnessEnv` (arguments validated, each call a durable task, results in the transcript).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessEnv } from "../execution.ts";
import { callTool, runToolCalls } from "../testing/execution.ts";
import { createLocalExecution } from "../node.ts";
import { CODING_TOOL_REPLAY, type CodingToolName, CodingTools, codingTool, createReadTool } from "./index.ts";

function temporary() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-durable-tools-")));
  return { dir, env: createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } }), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("codingTool: pi-durable's own tool under its name, with pikit's replay", () => {
  const names: CodingToolName[] = ["read", "write", "edit", "bash"];
  const tools = names.map(codingTool);

  expect(tools.map((tool) => [tool.name, tool.replay])).toEqual([
    ["read", "safe"],
    ["write", "unsafe"],
    ["edit", "unsafe"],
    ["bash", "unsafe"],
  ]);
  expect(CODING_TOOL_REPLAY).toEqual({ read: "safe", write: "unsafe", edit: "unsafe", bash: "unsafe" });
  // The same tool as pi-durable's, but for replay (which pi-durable's own leave unset).
  expect(createReadTool().replay).toBeUndefined();
  expect(codingTool("read").description).toBe(createReadTool().description);
  expect(CodingTools.tools?.map((tool) => tool.name).sort()).toEqual([...names].sort());
  expect(() => codingTool("ls" as CodingToolName)).toThrow("no coding tool");
});

test("called directly, they work on the call's environment", async () => {
  const { dir, env, dispose } = temporary();
  writeFileSync(join(dir, "notes.md"), "hello from the workspace\n");

  expect((await callTool(codingTool("read"), { path: "notes.md" }, { env })).text).toBe("hello from the workspace\n");
  expect((await callTool(codingTool("write"), { path: "out/new.txt", content: "written\n" }, { env })).text).toContain("Successfully wrote");
  expect((await callTool(codingTool("edit"), { path: "out/new.txt", edits: [{ oldText: "written", newText: "edited" }] }, { env })).text).toContain("Successfully replaced");
  expect(readFileSync(join(dir, "out/new.txt"), "utf8")).toBe("edited\n");
  const ran = await callTool(codingTool("bash"), { command: "cat out/new.txt; exit 2" }, { env });
  expect([ran.text, ran.isError, ran.diagnostics.map((d) => d.message)]).toEqual(["edited\n", true, ["Command exited with code 2"]]);
  // Without an environment (none built for the call) they fail with an error result, not a crash.
  const without = await callTool(codingTool("read"), { path: "notes.md" });
  expect(without.isError).toBe(true);
  dispose();
});

test("in a Harness turn: write, edit, read and bash on the environment harnessEnv builds", async () => {
  const { dir, env, dispose } = temporary();
  const results = await runToolCalls({
    tools: (["read", "write", "edit", "bash"] as const).map(codingTool),
    env: harnessEnv({ execution: () => env }),
    calls: [
      { name: "write", args: { path: "plan.md", content: "# Plan\n\n- clone\n- change\n" } },
      { name: "edit", args: { path: "plan.md", edits: [{ oldText: "- change", newText: "- change\n- push" }] } },
      { name: "read", args: { path: "plan.md" } },
      { name: "bash", args: { command: "grep -c '^-' plan.md" } },
      // Arguments the schema refuses never reach the tool.
      { name: "read", args: { file: "plan.md" } },
    ],
  });

  expect(results.map((r) => [r.name, r.isError])).toEqual([
    ["write", false],
    ["edit", false],
    ["read", false],
    ["bash", false],
    ["read", true],
  ]);
  expect(results[2]?.text).toBe("# Plan\n\n- clone\n- change\n- push\n");
  expect(results[3]?.text).toBe("3\n");
  expect(readFileSync(join(dir, "plan.md"), "utf8")).toContain("- push");
  dispose();
});

test("without an environment, the Harness gives the coding tools an error result", async () => {
  const results = await runToolCalls({ tools: [codingTool("read")], calls: [{ name: "read", args: { path: "anything" } }] });
  expect(results.map((r) => [r.name, r.isError])).toEqual([["read", true]]);
});
