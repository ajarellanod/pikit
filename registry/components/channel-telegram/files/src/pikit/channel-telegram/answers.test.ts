/**
 * The answers' reader (`answers.ts`) on its own: a memory feed, cursors in memory or in a SQLite file,
 * and a `deliver` the test controls. `channel-telegram.test.ts` runs it inside the channel.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@pikit/core";
import type { RunSettlement } from "@pikit/contracts";
import { createMemoryFeed } from "@pikit/contracts/testing";
import { type Cursors, openCursors, startAnswerReader } from "./answers.ts";
import { openTestDatabase } from "./storage.test-support.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function answer(key: string, requestId: string): RunSettlement {
  return { conversation: { key, agent: "assistant", sessionId: `s-${key}` }, requestId, requestIds: [requestId], kind: "completed", text: `to ${requestId}` };
}

function memoryCursors(options: { failGets?: number } = {}): Cursors & { value: string | undefined; gets: number[] } {
  let failGets = options.failGets ?? 0;
  const cursors = {
    value: undefined as string | undefined,
    gets: [] as number[],
    async get() {
      cursors.gets.push(Date.now());
      if (failGets-- > 0) throw new Error("database is locked");
      return cursors.value;
    },
    async save(cursor: string) {
      cursors.value = cursor;
    },
  };
  return cursors;
}

function recordingLogger(): Logger & { lines: { level: string; message: string; fields: unknown }[] } {
  const lines: { level: string; message: string; fields: unknown }[] = [];
  const log = (level: string) => (message: string, fields?: unknown) => void lines.push({ level, message, fields });
  return { debug() {}, info() {}, warn: log("warn"), error: log("error"), lines };
}

async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

test("a chat whose answer cannot be delivered holds up only itself, and the cursor never passes that answer", async () => {
  const { feed, append } = createMemoryFeed<RunSettlement>();
  const cursors = memoryCursors();
  const logger = recordingLogger();
  const delivered: string[] = [];
  let chatAReachable = false;
  const a1 = append(answer("telegram:1", "a1"));
  append(answer("telegram:2", "b1"));
  append(answer("telegram:1", "a2"));
  const b2 = append(answer("telegram:2", "b2"));

  const reader = startAnswerReader({
    answers: feed,
    cursors,
    logger,
    retryMs: [10],
    async deliver(fact) {
      if (fact.conversation.key === "telegram:1" && !chatAReachable) throw new Error("Telegram is unreachable");
      delivered.push(fact.requestId);
    },
  });
  try {
    // The other chat goes on; chat 1's second answer waits behind its first.
    await until(() => delivered.length === 2, "chat 2's answers");
    await until(() => logger.lines.some((line) => line.level === "error"), "the blocked answer's error");
    expect(delivered).toEqual(["b1", "b2"]);
    expect(cursors.value).toBeUndefined();
    const blocked = logger.lines.find((line) => line.level === "error");
    expect(blocked?.fields).toMatchObject({ conversation: "telegram:1", run: "a1", failures: 3 });

    chatAReachable = true;
    await until(() => delivered.length === 4, "chat 1's answers");
    expect(delivered.slice(2)).toEqual(["a1", "a2"]);
    await until(() => cursors.value === b2, "the cursor at the end");
    expect(Number(a1)).toBeLessThan(Number(b2));
  } finally {
    await reader.halt();
  }
});

test("an answer halted before it was delivered stays after the saved cursor; one delivered is saved at halt", async () => {
  const { feed, append } = createMemoryFeed<RunSettlement>();
  const cursors = memoryCursors();
  const first = append(answer("telegram:1", "r1"));
  append(answer("telegram:2", "r2"));
  const reader = startAnswerReader({
    answers: feed,
    cursors,
    logger: recordingLogger(),
    retryMs: [10],
    async deliver(fact) {
      if (fact.requestId === "r2") throw new Error("Telegram is unreachable");
    },
  });
  await Bun.sleep(50);
  await reader.halt();
  expect(cursors.value).toBe(first);
});

test("each gap is reported, with the cursor it was read after", async () => {
  const memory = createMemoryFeed<RunSettlement>();
  const cursors = memoryCursors();
  const logger = recordingLogger();
  const delivered: string[] = [];
  const reader = startAnswerReader({ answers: memory.feed, cursors, logger, deliver: async (fact) => void delivered.push(fact.requestId) });
  const gaps = () => logger.lines.filter((line) => line.message.includes("pruned")).map((line) => line.fields);
  try {
    const one = memory.append(answer("telegram:1", "r1"));
    reader.wake();
    await until(() => cursors.value === one, "r1 delivered and saved");

    memory.append(answer("telegram:1", "r2"));
    memory.prune();
    reader.wake();
    await until(() => gaps().length === 1, "the first gap");
    const three = memory.append(answer("telegram:1", "r3"));
    reader.wake();
    await until(() => cursors.value === three, "r3 delivered and saved");

    memory.append(answer("telegram:1", "r4"));
    memory.prune();
    reader.wake();
    await until(() => gaps().length === 2, "the second gap");
    await Bun.sleep(20);
    expect(gaps()).toEqual([{ after: one }, { after: three }]);
    expect(delivered).toEqual(["r1", "r3"]);
  } finally {
    await reader.halt();
  }
});

test("when storage fails, the reader backs off and tries again", async () => {
  const { feed, append } = createMemoryFeed<RunSettlement>();
  append(answer("telegram:1", "r1"));
  const cursors = memoryCursors({ failGets: 1 });
  const logger = recordingLogger();
  const delivered: string[] = [];
  const reader = startAnswerReader({ answers: feed, cursors, logger, retryMs: [200], deliver: async (fact) => void delivered.push(fact.requestId) });
  try {
    await until(() => delivered.length === 1, "the answer after the retry");
    expect(cursors.gets).toHaveLength(2);
    expect((cursors.gets[1] as number) - (cursors.gets[0] as number)).toBeGreaterThanOrEqual(150);
    expect(logger.lines.map((line) => line.message)).toEqual(["channel-telegram: reading answers or saving the cursor failed; trying again"]);
  } finally {
    await reader.halt();
  }
});

test("a cursor opened for the first time starts at the feed's end; one opened on an empty feed starts at its first answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-telegram-cursors-"));
  directories.push(dir);
  const upgraded = openTestDatabase(join(dir, "upgraded.db"));
  const fresh = openTestDatabase(join(dir, "fresh.db"));
  try {
    // A project that already had submissions-sql: its answers were delivered by events.
    const old = createMemoryFeed<RunSettlement>();
    for (let i = 0; i < 520; i++) old.append(answer("telegram:1", `old-${i}`));
    const cursors = await openCursors(upgraded.database, old.feed);
    expect(await cursors.get()).toBe("520");
    await cursors.save("600");
    expect(await (await openCursors(upgraded.database, old.feed)).get()).toBe("600");

    // A new project: nothing yet, so everything that comes is delivered.
    const empty = createMemoryFeed<RunSettlement>();
    const first = await openCursors(fresh.database, empty.feed);
    expect(await first.get()).toBeUndefined();
    empty.append(answer("telegram:1", "new"));
    expect(await (await openCursors(fresh.database, empty.feed)).get()).toBeUndefined();
  } finally {
    await upgraded.close();
    await fresh.close();
  }
});
