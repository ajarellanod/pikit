import { describe, expect, test } from "bun:test";
import { median, parseStarts } from "./scenarios.ts";

describe("parseStarts", () => {
  test("reads today's line: the object only, printed over several lines", () => {
    const output = "[wrangler:info] Ready\npikit: object started {\n  object: '00f4ab'\n}\n[wrangler:info] POST /bench/call 200 OK (42ms)\npikit: object started {\n  object: '7215cd'\n}\n";
    expect(parseStarts(output)).toEqual([
      { object: "00f4ab", fields: {} },
      { object: "7215cd", fields: {} },
    ]);
  });

  test("reads the fields object composition adds, a null kind as none", () => {
    const output =
      "pikit: object started {\n  object: 'aa',\n  kind: 'memory:',\n  components: 3,\n  composeMs: 0,\n  startMs: 12.5,\n  isolate: 'warm'\n}\npikit: object started { object: 'bb', kind: null, components: 32, composeMs: 1, startMs: 40, isolate: 'new' }";
    expect(parseStarts(output)).toEqual([
      { object: "aa", fields: { kind: "memory:", components: 3, composeMs: 0, startMs: 12.5, isolate: "warm" } },
      { object: "bb", fields: { kind: "none", components: 32, composeMs: 1, startMs: 40, isolate: "new" } },
    ]);
  });

  test("ignores every other line", () => {
    expect(parseStarts("pikit: Worker started { routes: [ 'GET /bench/ping' ] }\npikit: the object's App failed to start { object: 'cc' }")).toEqual([]);
  });
});

test("median", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(Number.isNaN(median([]))).toBe(true);
});
