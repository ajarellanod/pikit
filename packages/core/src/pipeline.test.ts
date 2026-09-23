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

test("before/after anchor next to the target; same-anchor stages keep registration order", async () => {
  const p = registry();
  p.register("test.text", append("x"), { id: "x" });
  p.register("test.text", append("y"), { id: "y" });
  p.register("test.text", append("1"), { id: "1", after: "x" });
  p.register("test.text", append("2"), { id: "2", after: "x" });
  p.register("test.text", append("3"), { id: "3", before: "y" });
  p.register("test.text", append("4"), { id: "4", before: "1" }); // anchored to an anchored stage

  expect(p.chain("test.text").map((s) => s.id)).toEqual(["x", "4", "1", "2", "3", "y"]);
  expect(await p.run("test.text", { text: "" }, undefined)).toEqual({ text: "x4123y" });
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

test("registration and resolution errors are explicit", async () => {
  const p = registry();
  p.register("test.text", append("a"), { id: "a" });

  expect(() => p.register("test.text", append("a"), { id: "a" })).toThrow('duplicate stage id "a"');
  expect(() => p.register("test.text", append("b"), { id: "b", before: "a", after: "a" })).toThrow(
    "sets both before and after",
  );

  p.register("test.text", append("z"), { id: "z", after: "missing" });
  expect(() => p.chain("test.text")).toThrow('stage "z" is anchored to "missing"');
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
