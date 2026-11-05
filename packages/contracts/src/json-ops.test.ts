import { expect, test } from "bun:test";
import { applyOps, diffOps, type JsonOp } from "./json-ops.ts";
import type { JsonValue } from "./json.ts";

test("each op changes what its path names, copying only the containers on the path", () => {
  const before: JsonValue = { a: { text: "he", n: 1 }, list: [1, 2, 3], kept: { x: 1 } };
  const after = applyOps(before, [
    ["a", ["a", "text"], "llo"],
    ["s", ["a", "n"], 2],
    ["s", ["added"], true],
    ["p", ["list"], 1, 1, [9, 8]],
    ["d", ["a", "n"]],
  ]);
  expect(after).toEqual({ a: { text: "hello" }, list: [1, 9, 8, 3], kept: { x: 1 }, added: true });
  expect((after as { kept: unknown }).kept).toBe((before as { kept: unknown }).kept);
  expect(before).toEqual({ a: { text: "he", n: 1 }, list: [1, 2, 3], kept: { x: 1 } });
});

test("a trim drops a string's start; a root splice changes a root array; r replaces everything", () => {
  expect(applyOps({ out: "abcdef" }, [["t", ["out"], 2]])).toEqual({ out: "cdef" });
  expect(applyOps([1, 2], [["p", [], 2, 0, [3]]])).toEqual([1, 2, 3]);
  expect(applyOps({ a: 1 }, [["r", [1]]])).toEqual([1]);
});

test("an op whose path does not lead where it says throws, and never writes a prototype", () => {
  expect(() => applyOps({}, [["a", ["missing"], "x"]])).toThrow();
  expect(() => applyOps({ a: 1 }, [["a", ["a"], "x"]])).toThrow();
  expect(() => applyOps([1], [["s", [5], 1]])).toThrow();
  expect(() => applyOps([1], [["d", [0]] as unknown as JsonOp])).toThrow();
  const after = applyOps({}, [["s", ["__proto__"], { polluted: true }]]) as Record<string, unknown>;
  expect(Object.getPrototypeOf(after)).toBe(Object.prototype);
  expect(Object.hasOwn(after, "__proto__")).toBe(true);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("diffOps: appends, trims and splices where the value grew or lost its start; nothing when equal", () => {
  const value = { message: { content: [{ type: "text", text: "Hel" }] }, tools: [] };
  expect(diffOps(value, value)).toEqual([]);
  expect(diffOps(value, { message: { content: [{ type: "text", text: "Hello" }] }, tools: [] })).toEqual([["a", ["message", "content", 0, "text"], "lo"]]);
  expect(diffOps({ out: "0123456789abcdefghijklmnopqrstuvwxyz0123456789" }, { out: "abcdefghijklmnopqrstuvwxyz0123456789!!" })).toEqual([
    ["t", ["out"], 10],
    ["a", ["out"], "!!"],
  ]);
  expect(diffOps({ tools: [{ id: 1 }] }, { tools: [{ id: 1 }, { id: 2 }] })).toEqual([["p", ["tools"], 1, 0, [{ id: 2 }]]]);
  expect(diffOps({ a: 1, b: 2 }, { b: 3 })).toEqual([
    ["d", ["a"]],
    ["s", ["b"], 3],
  ]);
  expect(diffOps("a", "b")).toEqual([["r", "b"]]);
  expect(diffOps({ a: "x" }, { a: 1 })).toEqual([["s", ["a"], 1]]);
});

test("diffOps then applyOps gives the later value, whatever the two values are", () => {
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const make = (depth: number): JsonValue => {
    switch (depth > 3 ? random(4) : random(7)) {
      case 0:
        return null;
      case 1:
        return random(2) === 0;
      case 2:
        return random(100);
      case 3:
        return "abcdefghij".slice(0, random(10)).repeat(1 + random(5));
      case 4:
      case 5:
        return Array.from({ length: random(4) }, () => make(depth + 1));
      default:
        return Object.fromEntries(Array.from({ length: random(4) }, () => [`k${random(5)}`, make(depth + 1)]));
    }
  };
  const mutate = (value: JsonValue, depth: number): JsonValue => {
    if (random(4) === 0) return make(depth);
    if (typeof value === "string") return random(2) === 0 ? `${value}more` : `${value.slice(random(value.length + 1))}tail`;
    if (Array.isArray(value)) return [...value.slice(0, random(value.length + 1)).map((each) => mutate(each, depth + 1)), ...(random(2) === 0 ? [make(depth + 1)] : [])];
    if (typeof value === "object" && value !== null) {
      const next: Record<string, JsonValue> = {};
      for (const [key, each] of Object.entries(value)) if (random(5) !== 0) next[key] = mutate(each, depth + 1);
      if (random(3) === 0) next[`n${random(5)}`] = make(depth + 1);
      return next;
    }
    return value;
  };
  for (let round = 0; round < 2_000; round++) {
    const before = make(0);
    const after = mutate(before, 0);
    expect(applyOps(before, diffOps(before, after))).toEqual(after);
  }
});
