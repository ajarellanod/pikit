import { expect, test } from "bun:test";
import { createPipelineRegistry, Halt, halt, type HaltedInfo } from "./pipeline.ts";

interface Pipelines {
  "test.text": { text: string };
}

function registry(halts: HaltedInfo[] = []) {
  return createPipelineRegistry<Pipelines, undefined>((info) => {
    halts.push(info);
  });
}

const append = (tag: string) => (v: { text: string }) => ({ text: v.text + tag });

test("stages run by priority desc, then registration order, threading the value", async () => {
  const p = registry();
  p.register("test.text", append("a"), { id: "a" }); // priority 0, first
  p.register("test.text", append("b"), { id: "b", priority: 10 });
  p.register("test.text", append("c"), { id: "c" }); // priority 0, after a
  p.register("test.text", append("d"), { id: "d", priority: 10 }); // after b

  expect(p.chain("test.text").map((s) => s.id)).toEqual(["b", "d", "a", "c"]);
  expect(await p.run("test.text", { text: "" }, undefined)).toEqual({ text: "bdac" });
});

test("a stage registered after a run is placed in the next run (the cached chain is invalidated)", async () => {
  const p = registry();
  p.register("test.text", append("a"), { id: "a" });
  expect(await p.run("test.text", { text: "" }, undefined)).toEqual({ text: "a" });
  p.register("test.text", append("b"), { id: "b", priority: 10 });
  expect(await p.run("test.text", { text: "" }, undefined)).toEqual({ text: "ba" });
});

test("halt stops the chain, reports the stage, and is returned to the caller", async () => {
  const halts: HaltedInfo[] = [];
  const p = registry(halts);
  p.register("test.text", append("a"), { id: "a" });
  p.register("test.text", () => halt("blocked"), { id: "gate" });
  p.register("test.text", append("never"), { id: "never" });

  const result = await p.run("test.text", { text: "" }, undefined);

  expect(result).toBeInstanceOf(Halt);
  expect((result as Halt).reason).toBe("blocked");
  expect((result as Halt).stage).toBe("gate");
  expect(halts).toEqual([{ pipeline: "test.text", stage: "gate", reason: "blocked" }]);
});

test("a duplicate stage id is an error", async () => {
  const p = registry();
  p.register("test.text", append("a"), { id: "a" });

  expect(() => p.register("test.text", append("a"), { id: "a" })).toThrow('duplicate stage id "a"');
});

test("a stage that throws aborts the run; a stage returning undefined is an error", async () => {
  const p = registry();
  p.register("test.text", () => {
    throw new Error("bad input");
  });
  await expect(p.run("test.text", { text: "" }, undefined)).rejects.toThrow("bad input");

  const q = registry();
  // biome-ignore lint/suspicious/noConfusingVoidType: simulating a forgotten return
  q.register("test.text", (() => {}) as never, { id: "forgetful" });
  await expect(q.run("test.text", { text: "" }, undefined)).rejects.toThrow(
    'stage "forgetful" returned undefined',
  );
});

test("a pipeline with no stages returns the input unchanged", async () => {
  const p = registry();
  const input = { text: "same" };
  expect(await p.run("test.text", input, undefined)).toBe(input);
  expect(p.names()).toEqual([]);
});
