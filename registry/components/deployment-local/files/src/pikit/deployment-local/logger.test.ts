/**
 * The JSON-lines logger: the shape of a line, where it goes, redaction by name, and that no field,
 * however odd, makes a log call throw.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonLogger, createRotatingFile, isSecretName, type LogLevel } from "./logger.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-local-logger-"));
  dirs.push(dir);
  return dir;
}

const NOW = new Date("2026-01-02T03:04:05.678Z");

function capture(level?: LogLevel) {
  const written: { line: string; level: LogLevel }[] = [];
  const logger = createJsonLogger({ now: () => NOW, write: (line, lvl) => void written.push({ line, level: lvl }), ...(level ? { level } : {}) });
  return {
    logger,
    written,
    /** Every line parsed; each must be exactly one line of JSON. */
    records(): Record<string, unknown>[] {
      return written.map(({ line }) => {
        expect(line).not.toContain("\n");
        return JSON.parse(line) as Record<string, unknown>;
      });
    },
  };
}

test("a line is one JSON object: time, level, msg, then the fields", () => {
  const { logger, records } = capture();

  logger.info("pikit: started", { components: 15, route: "POST /v1/messages" });

  expect(records()).toEqual([{ time: "2026-01-02T03:04:05.678Z", level: "info", msg: "pikit: started", components: 15, route: "POST /v1/messages" }]);
});

test("a field named like time, level or msg does not overwrite them", () => {
  const { logger, records } = capture();

  logger.warn("real", { msg: "fake", level: "debug", time: 0 });

  expect(records()).toEqual([{ time: NOW.toISOString(), level: "warn", msg: "real", "field.msg": "fake", "field.level": "debug", "field.time": 0 }]);
});

test("debug is dropped at the default level; warn and error are marked for stderr", () => {
  const { logger, written } = capture();

  logger.debug("hidden");
  logger.info("i");
  logger.warn("w");
  logger.error("e");

  expect(written.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  const verbose = capture("debug");
  verbose.logger.debug("shown");
  expect(verbose.written).toHaveLength(1);
});

test("the default writer puts debug and info on stdout, warn and error on stderr", () => {
  const out: unknown[] = [];
  const err: unknown[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => void out.push(line);
  console.error = (line: unknown) => void err.push(line);
  try {
    const logger = createJsonLogger();
    logger.info("to stdout");
    logger.error("to stderr");
  } finally {
    console.log = log;
    console.error = error;
  }

  expect(out).toHaveLength(1);
  expect(err).toHaveLength(1);
  expect(JSON.parse(String(err[0])).msg).toBe("to stderr");
});

test("an Error keeps its name, message, stack, cause, code and the errors of an AggregateError", () => {
  const { logger, records } = capture();
  const cause = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
  const failure = new Error("server-bun failed", { cause });

  logger.error("pikit: the app did not stop cleanly", { error: new AggregateError([failure, new TypeError("bad")], "1 stop failed") });

  const [record] = records();
  const error = record?.error as Record<string, unknown>;
  expect(error.name).toBe("AggregateError");
  expect(error.message).toBe("1 stop failed");
  expect(typeof error.stack).toBe("string");
  const [first, second] = error.errors as Record<string, unknown>[];
  expect(first?.message).toBe("server-bun failed");
  expect(first?.cause).toMatchObject({ name: "Error", message: "address in use", code: "EADDRINUSE" });
  expect(second).toMatchObject({ name: "TypeError", message: "bad" });
});

test("fields named like secrets are redacted, at any depth", () => {
  const { logger, written, records } = capture();

  logger.info("request", {
    token: "t0p-secret-1",
    PIKIT_HTTP_TOKEN: "t0p-secret-2",
    apiKey: "t0p-secret-3",
    headers: { authorization: "Bearer t0p-secret-4", "x-api-key": "t0p-secret-5", accept: "json" },
    items: [{ password: "t0p-secret-6" }],
    credentials: new Map([["anthropic", "t0p-secret-7"]]),
    cookieJar: "t0p-secret-8",
  });

  expect(written[0]?.line).not.toContain("t0p-secret");
  expect(records()[0]).toMatchObject({
    token: "[redacted]",
    PIKIT_HTTP_TOKEN: "[redacted]",
    apiKey: "[redacted]",
    headers: { authorization: "[redacted]", "x-api-key": "[redacted]", accept: "json" },
    items: [{ password: "[redacted]" }],
    credentials: "[redacted]",
    cookieJar: "[redacted]",
  });
});

test("names are compared word by word: token counts stay readable, tokens do not", () => {
  const secrets = ["token", "accessToken", "refresh_token", "bearerToken", "PIKIT_HTTP_TOKEN", "apiKey", "api_key", "x-api-key", "privateKey", "clientSecret", "authorization", "cookieJar", "credentials", "Password"];
  const counts = ["inputTokens", "outputTokens", "cacheReadTokens", "totalTokens", "tokens", "tokenCount", "maxTokens", "key", "conversation", "requestId", "session"];

  expect(secrets.filter((name) => !isSecretName(name))).toEqual([]);
  expect(counts.filter((name) => isSecretName(name))).toEqual([]);
});

test("a run's token usage, as log-events writes it, is logged as numbers", () => {
  const { logger, records } = capture();

  logger.info("agent.settled", { requestId: "m1", inputTokens: 12, outputTokens: 3, totalTokens: 15, cost: 0.001 });

  expect(records()[0]).toMatchObject({ inputTokens: 12, outputTokens: 3, totalTokens: 15, cost: 0.001 });
});

test("odd fields never make it throw: cycles, bigints, getters that throw, proxies, symbols, buffers", () => {
  const { logger, records } = capture();
  const cycle: Record<string, unknown> = { name: "a" };
  cycle.self = cycle;
  const shared = { x: 1 };
  const getter = Object.defineProperty({}, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("no keys for you");
      },
    },
  );
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 50; i++) deep = (deep.next = {}) as Record<string, unknown>;

  const odd = {
    cycle,
    pair: [shared, shared],
    big: 10n ** 30n,
    getter,
    hostile,
    symbol: Symbol("s"),
    fn: function handler() {},
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    missing: undefined,
    date: new Date(Number.NaN),
    url: new URL("https://example.com/x"),
    bytes: new Uint8Array(1_000_000),
    set: new Set([1, 2]),
    root,
  };
  expect(() => logger.info("odd", odd)).not.toThrow();
  expect(() => logger.info("null fields", null as unknown as Record<string, unknown>)).not.toThrow();
  expect(() => logger.info("a proxy as fields", hostile)).not.toThrow();

  const [first, second, third] = records();
  expect(first).toMatchObject({
    msg: "odd",
    cycle: { name: "a", self: "[circular]" },
    pair: [{ x: 1 }, { x: 1 }],
    big: "1000000000000000000000000000000",
    getter: { boom: "[unreadable: getter exploded]" },
    symbol: "Symbol(s)",
    fn: "[function handler]",
    nan: "NaN",
    inf: "Infinity",
    date: "Invalid Date",
    url: "https://example.com/x",
    bytes: "[1000000 bytes]",
    set: [1, 2],
  });
  expect(first?.hostile).toBeString();
  expect(JSON.stringify(first?.root)).toContain("[too deep]");
  expect(first).not.toHaveProperty("missing");
  expect(second).toMatchObject({ level: "info", msg: "null fields" });
  // The fields could not even be listed; the message still gets out.
  expect(third).toMatchObject({ level: "info", msg: "a proxy as fields" });
});

test("a writer that throws (a closed stdout) does not reach the caller", () => {
  const logger = createJsonLogger({
    write() {
      throw new Error("EPIPE");
    },
  });

  expect(() => logger.error("lost")).not.toThrow();
});

test("the file sink makes its directory, writes whole lines, and keeps them private", () => {
  const path = join(tempDir(), "logs", "app.log");
  const logger = createJsonLogger({ write: createRotatingFile(path) });
  logger.info("one");
  logger.error("two");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { msg: string });
  expect(lines.map((line) => line.msg)).toEqual(["one", "two"]);
  expect(statSync(path).mode & 0o077).toBe(0);
});

test("a pre-existing log file is made private too", () => {
  const path = join(tempDir(), "app.log");
  writeFileSync(path, "previous\n", { mode: 0o644 });
  chmodSync(path, 0o644);
  createRotatingFile(path)("new");
  expect(statSync(path).mode & 0o077).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("previous\nnew\n");
});

test("the file sink rotates by size and keeps `files` files, the oldest dropped", () => {
  const dir = tempDir();
  const path = join(dir, "app.log");
  const write = createRotatingFile(path, { maxBytes: 100, files: 3 });
  // 40 bytes a line with its newline: two lines a file.
  for (let n = 0; n < 10; n++) write(`line ${String(n).padStart(2, "0")} ${"x".repeat(30)}`);
  expect(readdirSync(dir).sort()).toEqual(["app.log", "app.log.1", "app.log.2"]);
  const read = (file: string) => readFileSync(join(dir, file), "utf8").trim().split("\n").map((line) => line.slice(0, 7));
  expect(read("app.log.2")).toEqual(["line 04", "line 05"]);
  expect(read("app.log.1")).toEqual(["line 06", "line 07"]);
  expect(read("app.log")).toEqual(["line 08", "line 09"]);
  for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(100);
});

test("the file sink continues a file it did not write, counting its size", () => {
  const dir = tempDir();
  const path = join(dir, "app.log");
  createRotatingFile(path, { maxBytes: 100 })("a".repeat(80));
  // A new process (a restart) appends to the same file, and rotates once it would pass the size.
  createRotatingFile(path, { maxBytes: 100 })("b".repeat(30));
  expect(existsSync(`${path}.1`)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(`${"b".repeat(30)}\n`);
});

test("a line the file sink cannot write is lost, and the caller never sees an error", () => {
  const dir = tempDir();
  // A directory where the file should be: every write fails.
  const logger = createJsonLogger({ write: createRotatingFile(dir) });
  expect(() => logger.error("lost")).not.toThrow();
});
