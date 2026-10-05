/**
 * The conversation index (a server's own table; on Cloudflare the object `admin-api:index`'s) on a
 * real SQLite `storage.sql`: an upsert a late or repeated `seen` does not move back, newest activity
 * first, pages that follow each other.
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

const row = (key: string, at: number, conversationId = "1", agent = "assistant") => ({ key, conversationId, agent, at });

test("seen is an upsert: a repeated or late one leaves the newest time and its agent", async () => {
  const { index: conversations, sql } = await index();

  await conversations.seen([row("telegram:1", 100)]);
  await conversations.seen([row("telegram:1", 100)]);
  await conversations.seen([row("telegram:1", 300), row("telegram:1", 200, "1", "older")]);

  expect(await conversations.list({ limit: 10 })).toEqual({ items: [row("telegram:1", 300)] });
  // Its own table, prefixed with the component's name.
  expect(await sql.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_api_%'")).toEqual([{ name: "admin_api_conversations" }]);
});

test("one row per conversation: a key's conversations (a reset's) are listed each by its own activity", async () => {
  const { index: conversations } = await index();

  await conversations.seen([row("telegram:1", 100, "1"), row("http:a", 200, "c7"), row("telegram:1", 300, "2")]);

  expect((await conversations.list({ limit: 10 })).items).toEqual([row("telegram:1", 300, "2"), row("http:a", 200, "c7"), row("telegram:1", 100, "1")]);
});

test("list: the most recently active first (ties by key, then id), a page at a time with the next one's cursor", async () => {
  const { index: conversations } = await index();
  await conversations.seen((
    [["a", 1], ["b", 5], ["c", 3], ["d", 5], ["e", 2]] as const
  ).map(([key, at]) => row(key, at)));
  await conversations.seen([row("d", 5, "0")]);

  const first = await conversations.list({ limit: 2 });
  expect(first.items.map((each) => `${each.key}~${each.conversationId}`)).toEqual(["b~1", "d~0"]);
  const second = await conversations.list({ limit: 2, cursor: first.next as string });
  expect(second.items.map((each) => each.key)).toEqual(["d", "c"]);
  const third = await conversations.list({ limit: 2, cursor: second.next as string });
  expect(third.items.map((each) => each.key)).toEqual(["e", "a"]);
  expect(third.next).toBeUndefined();

  // A conversation active again moves to the front; the pages after the cursor do not repeat it.
  await conversations.seen([row("e", 9)]);
  expect((await conversations.list({ limit: 1 })).items[0]?.key).toBe("e");
  expect((await conversations.list({ limit: 10, cursor: second.next as string })).items.map((each) => each.key)).toEqual(["a"]);
});

test("keys and ids with ':', '~', '/', '.' and '@' page like any others; a cursor it did not give is invalid_cursor", async () => {
  const { index: conversations } = await index();
  await conversations.seen([row("telegram:ops:1~x", 7), row("email:ana@empresa.com", 7, "a/b.c"), row("http:2", 7)]);

  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await conversations.list({ limit: 1, ...(cursor !== undefined && { cursor }) });
    seen.push(...page.items.map((each) => `${each.key} ${each.conversationId}`));
    cursor = page.next;
  } while (cursor !== undefined);
  expect(seen).toEqual(["email:ana@empresa.com a/b.c", "http:2 1", "telegram:ops:1~x 1"]);

  for (const bad of ["", "forged", "x:telegram:1", "1:a", "1:%E0:1"]) {
    const refused = await conversations.list({ limit: 1, cursor: bad }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid_cursor");
  }
});
