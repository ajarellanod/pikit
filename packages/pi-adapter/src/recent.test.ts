/**
 * `RecentMap`, the runtime's bounded cache of `ConversationRef`s: it never holds more than its limit,
 * and drops the least recently used entry (read or written) first.
 */

import { expect, test } from "bun:test";
import { RecentMap } from "./recent.ts";

test("it never holds more than its limit, however many keys are written", () => {
  const map = new RecentMap<number, string>(3);

  for (let key = 0; key < 10_000; key++) map.set(key, `ref ${key}`);

  expect(map.size).toBe(3);
  expect([map.get(9_997), map.get(9_998), map.get(9_999)]).toEqual(["ref 9997", "ref 9998", "ref 9999"]);
  expect(map.get(0)).toBeUndefined();
});

test("the least recently used goes first: a read or a write makes an entry the most recent", () => {
  const map = new RecentMap<string, number>(2);
  map.set("a", 1);
  map.set("b", 2);

  expect(map.get("a")).toBe(1);
  map.set("c", 3);
  expect([map.get("a"), map.get("b"), map.get("c")]).toEqual([1, undefined, 3]);

  map.set("a", 10);
  map.set("d", 4);
  expect([map.get("a"), map.get("c"), map.get("d")]).toEqual([10, undefined, 4]);
  expect(map.size).toBe(2);
});

test("an undefined lookup changes nothing, and a limit that is not a positive integer is refused", () => {
  const map = new RecentMap<string, number>(1);
  map.set("a", 1);

  expect(map.get("b")).toBeUndefined();
  expect(map.get("a")).toBe(1);
  for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => new RecentMap(limit)).toThrow(RangeError);
});
