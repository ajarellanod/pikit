/**
 * In the registry, beside `files/`: execution-cloudflare-sandbox speaks execution-serve's protocol from
 * a copy of the same `protocol.ts` (a component never imports another's files), and keeps a command's
 * output as execution-serve does, from a copy of its `output.ts`. The copies must stay identical, to
 * execution-remote's and execution-serve's (whose own test, `execution-remote/app.test.ts`, checks the
 * other pair): this test fails while they differ.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (component: string, file: string) => readFileSync(join(import.meta.dir, "..", component, "files/src/pikit", component, file), "utf8");

test("protocol.ts is identical to execution-remote's and execution-serve's", () => {
  const own = read("execution-cloudflare-sandbox", "protocol.ts");
  expect(own).toBe(read("execution-serve", "protocol.ts"));
  expect(own).toBe(read("execution-remote", "protocol.ts"));
});

test("output.ts is identical to execution-serve's", () => {
  expect(read("execution-cloudflare-sandbox", "output.ts")).toBe(read("execution-serve", "output.ts"));
});
