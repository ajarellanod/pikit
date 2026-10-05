/**
 * `startAnswerDelivery`'s direct path (no `outbound.queue`) killed after each of its commits in turn
 * (`createConvergenceConformance`), its cursor and marks in the real `storage.kv`: storage-kv-sql on
 * storage-sqlite's `storage.sql`. Whatever the point, the next process delivers every piece, in order
 * per conversation, every piece sent more than once is marked a possible duplicate, and the cursor
 * ends past the last answer. Once driven by a timer in the process (a server), once by `wakeups` (a
 * Durable Object).
 *
 * Every case passes, the storage failures included: outbound-durable's known failure there (its send
 * and its write of the delivery share one `catch`, so a failed write is taken for a failed send and the
 * piece goes again unmarked) is not shared. Here the `sent` mark is written after the send's `try`: a
 * failed write fails the pass, the piece stays `sending`, and goes again marked.
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. The answers are a memory feed filled
 * before the first process: the runtime's log, committed before the channel reads it.
 */

import { afterAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppContext, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AnswerDelivery, type DeliveryPolicy, type RunSettlement, type SqlDatabase, startAnswerDelivery } from "@pikit/contracts";
import { type ConvergenceFixture, createConvergenceConformance, createMemoryFeed, createMemoryWakeups } from "@pikit/contracts/testing";
import storageSqlite from "../storage-sqlite/files/src/pikit/storage-sqlite/index.ts";
import storageKvSql, { TABLE } from "./files/src/pikit/storage-kv-sql/index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** Two pieces per run at most, so runs are cut and the next one picks up. */
const POLICY: DeliveryPolicy = { retryMs: [20, 40], blockedAfter: 3, window: 50, piecesPerRun: 2, sendTimeoutMs: 1_000 };
const CHANNEL = "channel-test";

const answer = (chat: string, requestId: string, text: string | undefined, kind: RunSettlement["kind"] = "completed"): RunSettlement => ({
  conversation: { key: chat, agent: "assistant", conversationId: `s-${chat}` },
  requestId,
  requestIds: [requestId],
  kind,
  ...(text !== undefined && { text }),
});

/** The feed, in order: an aborted run tells nothing, and is passed over. */
const ANSWERS = [answer("chat:1", "m1", "one|two"), answer("chat:2", "m2", "three"), answer("chat:2", "m3", undefined, "aborted"), answer("chat:1", "m4", "four")];
const PIECES = ["s-chat:1:m1#0", "s-chat:1:m1#1", "s-chat:1:m4#0", "s-chat:2:m2#0"];
/** chat:1's pieces, in the order they must first reach it. */
const CHAT_1 = ["s-chat:1:m1#0", "s-chat:1:m1#1", "s-chat:1:m4#0"];

/** storage-sqlite's `storage.sql` over a fresh file, in an app of its own: the records every process shares. */
async function sqliteRecords(): Promise<{ database: SqlDatabase; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pikit-answer-delivery-"));
  directories.push(dir);
  let database: SqlDatabase | undefined;
  const reader = defineComponent({
    name: "records",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (database = handle.get()) };
    },
  });
  const app = await defineApp({ components: [storageSqlite, reader], config: { "storage-sqlite": { path: join(dir, "pikit.db") } }, logger: silentLogger }).create();
  await app.start();
  if (database === undefined) throw new Error("storage.sql was not resolved");
  return { database, stop: () => app.stop() };
}

function fixture(driven: "timer" | "wakeups"): () => Promise<ConvergenceFixture> {
  return async () => {
    const records = await sqliteRecords();
    const feed = createMemoryFeed<RunSettlement>();
    let last = "";
    for (const fact of ANSWERS) last = feed.append(fact);
    /** What the platform received, across every process. */
    const sends: { key: string; possibleDuplicate: boolean }[] = [];
    let delivery: AnswerDelivery | undefined;
    let context: AppContext | undefined;

    /** The channel's saved cursor, read from the records directly (no commit of any process). */
    const cursor = async (): Promise<string | undefined> => {
      const [row] = await records.database.query<{ json: string }>(`SELECT json FROM ${TABLE} WHERE namespace = ? AND entry_key = 'answers-cursor'`, [CHANNEL]);
      return row === undefined ? undefined : (JSON.parse(row.json) as string);
    };

    return {
      database: records.database,
      // After a storage failure the world waits out the longest retry before it looks again.
      retryAfterMs: Math.max(...POLICY.retryMs),
      components: (life) => [
        storageKvSql,
        ...(driven === "wakeups" ? [createMemoryWakeups()] : []),
        defineComponent({
          name: CHANNEL,
          setup(pikit) {
            const kv = pikit.use("storage.kv");
            const wakeups = driven === "wakeups" ? pikit.use("wakeups") : undefined;
            let mine: AnswerDelivery | undefined;
            return {
              async start(ctx) {
                context = ctx;
                mine = await startAnswerDelivery(ctx, {
                  name: CHANNEL,
                  answers: feed.feed,
                  store: kv.get().namespace(CHANNEL),
                  transports: new Map([
                    [
                      "chat",
                      {
                        idempotent: false,
                        split: (text: string) => text.split("|"),
                        async send(piece) {
                          // A dead process reaches no platform.
                          if (life.dead) throw new Error("the process is dead");
                          sends.push({ key: piece.key, possibleDuplicate: piece.possibleDuplicate });
                          return { platformMessageId: `p${sends.length}` };
                        },
                      },
                    ],
                  ]),
                  route: (key) => (key.startsWith("chat:") ? "chat" : undefined),
                  text: (fact) => (fact.kind === "completed" ? fact.text : undefined),
                  wakeups: wakeups?.get(),
                  policy: POLICY,
                });
                delivery = mine;
              },
              async stop(ctx) {
                await mine?.stop(ctx.abortSignal);
              },
            };
          },
        }),
      ],
      async scenario({ signal }) {
        // A run of the channel ended: it reads again.
        await delivery?.wake(context as AppContext);
        const deadline = Date.now() + 1_000;
        while ((await cursor()) !== last) {
          if (signal.aborted) throw signal.reason;
          if (Date.now() > deadline) throw new Error(`the cursor is at ${await cursor()}, not past the last answer (${last})`);
          await Bun.sleep(2);
        }
      },
      async invariant() {
        if ((await cursor()) !== last) throw new Error(`the cursor is at ${await cursor()}, not past the last answer (${last})`);
        for (const key of PIECES) {
          const mine = sends.filter((s) => s.key === key);
          if (mine.length === 0) throw new Error(`${key} never reached the platform: ${JSON.stringify(sends)}`);
          if (mine.slice(1).some((s) => !s.possibleDuplicate)) throw new Error(`${key} was sent again without the possible-duplicate mark: ${JSON.stringify(mine)}`);
        }
        const strays = sends.filter((s) => !PIECES.includes(s.key));
        if (strays.length > 0) throw new Error(`pieces of no answer were sent: ${JSON.stringify(strays)}`);
        const firsts = CHAT_1.map((key) => sends.findIndex((s) => s.key === key));
        if (firsts.some((at, i) => i > 0 && at < (firsts[i - 1] as number))) throw new Error(`chat:1's pieces went out of order: ${JSON.stringify(sends.map((s) => s.key))}`);
      },
      dispose: () => records.stop(),
    };
  };
}

for (const driven of ["timer", "wakeups"] as const) {
  for (const c of createConvergenceConformance(fixture(driven))) {
    test(`direct answer delivery (${driven}) over storage-kv-sql ${c.group}: ${c.name}`, () => c.run(), 60_000);
  }
}
