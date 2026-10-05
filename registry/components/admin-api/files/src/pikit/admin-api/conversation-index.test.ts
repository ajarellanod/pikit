/**
 * The conversation index (Cloudflare's list of keys, kept by the object `admin-api:index`) on a real
 * SQLite `storage.sql`: an upsert a late or repeated `seen` does not move back, newest activity first,
 * pages that follow each other.
 */

import { afterEach, expect, test } from "bun:test";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type SqlDatabase } from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { type ConversationIndex, createConversationIndex } from "./conversation-index.ts";

const running: App[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.stop();
});

async function index(): Promise<{ index: ConversationIndex; sql: SqlDatabase }> {
  let sql: SqlDatabase | undefined;
  const reader = defineComponent({
    name: "sql-reader",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (sql = handle.get()) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), reader], logger: silentLogger }).create();
  await app.start();
  running.push(app);
  return { index: createConversationIndex(() => sql as SqlDatabase), sql: sql as SqlDatabase };
}

test("seen is an upsert: a repeated or late one leaves the newest time and its agent", async () => {
  const { index: keys, sql } = await index();

  await keys.seen({ key: "telegram:1", agent: "assistant", at: 100 });
  await keys.seen({ key: "telegram:1", agent: "assistant", at: 100 });
  await keys.seen({ key: "telegram:1", agent: "assistant", at: 300 });
  await keys.seen({ key: "telegram:1", agent: "older", at: 200 });

  expect(await keys.list({ limit: 10 })).toEqual({ items: [{ key: "telegram:1", agent: "assistant", at: 300 }] });
  // Its own table, prefixed with the component's name.
  expect(await sql.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_api_%'")).toEqual([{ name: "admin_api_index" }]);
});

test("list: the most recently active first (ties by key), a page at a time with the next one's cursor", async () => {
  const { index: keys } = await index();
  for (const [key, at] of [["a", 1], ["b", 5], ["c", 3], ["d", 5], ["e", 2]] as const) await keys.seen({ key, agent: "assistant", at });

  const first = await keys.list({ limit: 2 });
  expect(first.items.map((each) => each.key)).toEqual(["b", "d"]);
  const second = await keys.list({ limit: 2, cursor: first.next as string });
  expect(second.items.map((each) => each.key)).toEqual(["c", "e"]);
  const last = await keys.list({ limit: 2, cursor: second.next as string });
  expect(last).toEqual({ items: [{ key: "a", agent: "assistant", at: 1 }] });

  // A key active again moves to the front; the pages after the cursor do not repeat it.
  await keys.seen({ key: "e", agent: "assistant", at: 9 });
  expect((await keys.list({ limit: 1 })).items[0]?.key).toBe("e");
  expect((await keys.list({ limit: 10, cursor: first.next as string })).items.map((each) => each.key)).toEqual(["c", "a"]);
});

test("a key with ':' and '~' in it pages like any other; a cursor it did not give is invalid_cursor", async () => {
  const { index: keys } = await index();
  await keys.seen({ key: "telegram:ops:1~x", agent: "assistant", at: 7 });
  await keys.seen({ key: "http:2", agent: "assistant", at: 7 });

  const first = await keys.list({ limit: 1 });
  expect(first.items[0]?.key).toBe("http:2");
  expect((await keys.list({ limit: 1, cursor: first.next as string })).items[0]?.key).toBe("telegram:ops:1~x");

  for (const cursor of ["", "forged", "x:telegram:1"]) {
    const refused = await keys.list({ limit: 1, cursor }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid_cursor");
  }
});
