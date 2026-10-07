/**
 * execution-do's pi-durable environment (`env.ts`) on a real SQLite-backed Durable Object:
 * pi-durable's `ExecutionEnv` contract, each case in an object of its own; then pi-durable's own
 * `read`, `write`, `edit` and `bash` tools, offered by a `Harness` whose faux model calls them, working
 * on the object's files and shell; a long output spilled into the object; and the files outliving the
 * object's instance.
 */

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import type { WorkersHost } from "@pikit/contracts/cloudflare";
import { BACKGROUND_CONTEXT, getOrThrow, harnessEnv } from "@pikit/pi-adapter/execution";
import { createDurableExecutionConformance, runToolCalls } from "@pikit/pi-adapter/execution/testing";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@pikit/pi-adapter/tools";
import { expect, it } from "vitest";
import { objectExecution } from "../../../registry/components/execution-do/files/src/pikit/execution-do/env.test-support.ts";
import type { DurableObjectFilesStorage } from "../../../registry/components/execution-do/files/src/pikit/execution-do/files.ts";
import { hostOf, inObject, objectHost } from "./host.ts";

const ctx = BACKGROUND_CONTEXT;

/** The environment over the object of `host`, its namespace the object's id. */
function inThe(host: WorkersHost) {
  const object = host.object;
  if (object === undefined) throw new Error("no object in the host");
  return objectExecution(object.storage as DurableObjectFilesStorage, { id: `execution-do:${object.id}` });
}

for (const c of createDurableExecutionConformance(() => ({ env: inThe(objectHost()).env }), { expect, watch: false })) {
  it(`execution-do on pi-durable ${c.group}: ${c.name}`, () => inObject(c));
}

it("pi-durable's own write, edit, read and bash work on the object's files, called by a Harness's model", () =>
  inObject(async (host) => {
    const { env: workspace } = inThe(host);
    const results = await runToolCalls({
      tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
      env: harnessEnv({ execution: () => workspace }),
      calls: [
        { name: "write", args: { path: "notes/plan.md", content: "# Plan\n\n- clone\n- change\n" } },
        { name: "edit", args: { path: "notes/plan.md", edits: [{ oldText: "- change", newText: "- change\n- push" }] } },
        { name: "read", args: { path: "notes/plan.md" } },
        { name: "bash", args: { command: "wc -l < notes/plan.md && grep -c '^-' notes/plan.md && pwd" } },
        { name: "bash", args: { command: "node -e 'console.log(6 * 7)'" } },
        { name: "bash", args: { command: "echo nope > notes/.git/x" } },
      ],
    });

    expect(results.map((r) => [r.name, r.isError])).toEqual([
      ["write", false],
      ["edit", false],
      ["read", false],
      ["bash", false],
      ["bash", false],
      ["bash", true],
    ]);
    expect(results[2]?.text).toBe("# Plan\n\n- clone\n- change\n- push\n");
    expect(results[3]?.text).toBe("5\n3\n/work\n");
    expect(results[4]?.text).toBe("42\n");
    // The fence: only git changes files inside a .git.
    expect(results[5]?.text).toContain("EPERM: files inside .git change only through git");
    expect(results[5]?.text).toContain("Command exited with code 1");
    expect(workspace.id).toBe(`execution-do:${host.object?.id}`);
    // The files are the object's rows.
    const storage = host.object?.storage as DurableObjectFilesStorage;
    expect(storage.sql.exec("SELECT kind FROM execution_do_nodes WHERE path = '/work/notes/plan.md'").toArray()).toEqual([{ kind: "file" }]);
  }));

it("a long output is spilled whole into the object, and bash names the file", () =>
  inObject(async (host) => {
    const { env: workspace } = inThe(host);
    const [result] = await runToolCalls({ tools: [createBashTool()], env: harnessEnv({ execution: () => workspace }), calls: [{ name: "bash", args: { command: "seq 1 3000" } }] });

    const spill = /Full output: (\/tmp\/pi-output-\S+\.log)/.exec(result?.text ?? "")?.[1];
    expect(result?.isError).toBe(false);
    expect(spill).toBeDefined();
    expect(getOrThrow(await workspace.readTextFile(spill as string, ctx)).split("\n")).toHaveLength(3001);
  }));

it("what the tools wrote outlives the object's instance", async () => {
  const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state: DurableObjectState) => {
    const { env: workspace } = inThe(hostOf(state));
    const [result] = await runToolCalls({
      tools: [createWriteTool()],
      env: harnessEnv({ execution: () => workspace }),
      calls: [{ name: "write", args: { path: "kept.txt", content: "still here\n" } }],
    });
    expect(result?.isError).toBe(false);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state: DurableObjectState) => {
    const { env: workspace } = inThe(hostOf(state));
    const [read] = await runToolCalls({ tools: [createReadTool()], env: harnessEnv({ execution: () => workspace }), calls: [{ name: "read", args: { path: "kept.txt" } }] });
    expect(read?.text).toBe("still here\n");
  });
});
