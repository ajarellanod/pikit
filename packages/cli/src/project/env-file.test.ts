/** `.env` keeps its other lines and mode 0600; `.env.example` blocks come and go without a trace. */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendExampleBlock, exampleBlock, parseEnv, readEnv, removeExampleBlock, writeEnv } from "./env-file.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-env-"));
  dirs.push(dir);
  return dir;
};

const TOKEN = { name: "PIKIT_HTTP_TOKEN", secret: true, required: true, description: "Bearer token." };
const KEY = { name: "ANTHROPIC_API_KEY", secret: true, required: false };

test(".env: values set, other lines kept, readable by its owner only", () => {
  const dir = temp();
  writeFileSync(join(dir, ".env"), "# mine\nOTHER=1\nPIKIT_HTTP_TOKEN=old\n", { mode: 0o644 });
  writeEnv(dir, new Map([["PIKIT_HTTP_TOKEN", "dummy-token-0123456789"], ["WITH_SPACES", "a b"]]));

  expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# mine\nOTHER=1\nPIKIT_HTTP_TOKEN=dummy-token-0123456789\nWITH_SPACES='a b'\n");
  expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  expect(readEnv(dir).get("WITH_SPACES")).toBe("a b");
  expect(() => writeEnv(dir, new Map([["BAD", "two\nlines"]]))).toThrow(/line break/);
});

test(".env parsing: comments, export, quotes", () => {
  const env = parseEnv("# c\nexport A=1\nB='x y'\nC=\"z\"\n\nnot a line\n");
  expect([...env]).toEqual([["A", "1"], ["B", "x y"], ["C", "z"]]);
});

test(".env.example: appending then removing blocks restores the text exactly", () => {
  const blockA = exampleBlock("provider-anthropic", [KEY]);
  const blockB = exampleBlock("channel-http", [TOKEN]);
  expect(blockB).toBe("# channel-http\n# Bearer token. (required, secret)\nPIKIT_HTTP_TOKEN=\n");
  expect(exampleBlock("log-events", [])).toBe("");

  const one = appendExampleBlock("", blockA);
  const two = appendExampleBlock(one, blockB);
  expect(two).toBe(`${blockA}\n${blockB}`);
  expect(removeExampleBlock(two, "channel-http")).toBe(one);
  expect(removeExampleBlock(two, "provider-anthropic")).toBe(blockB);
  expect(removeExampleBlock(one, "provider-anthropic")).toBe("");
  expect(removeExampleBlock(two, "nothing")).toBe(two);
});
