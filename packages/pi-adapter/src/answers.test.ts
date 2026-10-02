/**
 * The answers log (`answers.ts`) on a SQLite file held to a Durable Object's SQL limits: the feed suite
 * (SPEC K3) with pruning and restarts, and what the runtime relies on (an append is idempotent by run
 * key; `find` reads a request's run). The workerd lane runs the feed suite on storage-do.
 */

import { afterEach, expect, test } from "bun:test";
import type { RunSettlement } from "@pikit/contracts";
import { createFeedConformance } from "@pikit/contracts/testing";
import { type AnswerLog, createAnswerLog } from "./answers.ts";
import { databaseFile } from "./test-support.ts";
import { openSqliteDatabase } from "./testing/sqlite.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const conversation = { key: "test:c1", agent: "support", conversationId: "1" };
const run = (requestIds: string[], text = `answer to ${requestIds.join(", ")}`): RunSettlement => ({
  conversation,
  requestId: requestIds[0] ?? "",
  requestIds,
  kind: "completed",
  text,
});

/** A log over a fresh file; `reopen` is a new process over the same file. */
async function opened(): Promise<{ log(): AnswerLog; reopen(): Promise<void>; dispose(): Promise<void> }> {
  const file = databaseFile();
  let sqlite = openSqliteDatabase(file.path, { durableObjectLimits: true });
  let log = createAnswerLog(sqlite.database);
  await log.ensure();
  return {
    log: () => log,
    async reopen() {
      await sqlite.close();
      sqlite = openSqliteDatabase(file.path, { durableObjectLimits: true });
      log = createAnswerLog(sqlite.database);
      await log.ensure();
    },
    async dispose() {
      await sqlite.close();
      file.dispose();
    },
  };
}

for (const c of createFeedConformance<RunSettlement>(
  async () => {
    const records = await opened();
    let n = 0;
    return {
      feed: () => ({ read: (after, limit) => records.log().read(after, limit) }),
      async commit() {
        const id = `run-${++n}`;
        await records.log().append([{ key: `1:s${n}`, run: run([id]) }], Date.now());
        return id;
      },
      identify: (fact) => fact.requestId,
      prune: () => records.log().prune(Date.now() + 1),
      restart: () => records.reopen(),
      dispose: () => records.dispose(),
    };
  },
  { prunes: true, restarts: true },
)) {
  test(`answers log ${c.group}: ${c.name}`, () => c.run());
}

test("an append is idempotent by run key; runs appended together keep their order", async () => {
  const records = await opened();
  cleanup.push(records.dispose);
  const log = records.log();

  await log.append([{ key: "1:a7", run: run(["m1", "m2"]) }, { key: "1:s9", run: run(["m3"]) }], 1);
  await log.append([{ key: "1:a7", run: run(["m2"], "a second reading of the same run") }], 2);

  expect((await log.read(undefined, 10)).items.map((item) => item.fact.requestIds)).toEqual([["m1", "m2"], ["m3"]]);
});

test("find: the first run that took the request, matched exactly, in its conversation", async () => {
  const records = await opened();
  cleanup.push(records.dispose);
  const log = records.log();
  await log.append([{ key: "1:a1", run: run(['m"1', "m2"]) }, { key: "1:a2", run: run(["m2-later", "m2"]) }], 1);
  await log.append([{ key: "2:a3", run: { ...run(["m9"]), conversation: { ...conversation, conversationId: "2" } } }], 1);

  expect((await log.find("1", "m2"))?.requestIds).toEqual(['m"1', "m2"]);
  expect((await log.find("1", 'm"1'))?.requestId).toBe('m"1');
  expect(await log.find("1", "m")).toBeUndefined();
  expect(await log.find("1", "m9")).toBeUndefined();
  expect((await log.find("2", "m9"))?.requestId).toBe("m9");
});
