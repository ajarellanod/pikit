// The conversations.directory suite passes on the in-memory double and catches a broken one for each
// guarantee (contract rule 7); the contract's helpers hold what the contract says.

import { expect, test } from "bun:test";
import { type ComponentDefinition, defineApp, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import {
  cleanTitle,
  compareDirectoryOrder,
  DirectoryError,
  directoryCursor,
  likePattern,
  listStateOf,
  matchesSearch,
  parseDirectoryCursor,
  parseDirectoryQuery,
  parseViewer,
  permissionsOf,
  stillHidden,
  TITLE_MAX,
  titleApplies,
  viewerAuthor,
  viewerKey,
} from "../conversation-directory.ts";
import {
  type ConversationDirectorySubject,
  createConversationDirectoryConformance,
  createMemoryDirectory,
  type DirectoryPlace,
  flawedMemoryDirectory,
  type MemoryDirectory,
  type MemoryDirectoryFlaws,
  type MemoryDirectoryUpdate,
} from "./conversation-directory.ts";

/** The double in an App with the suite's components, with a registry of keys and a log of updates to replay. */
async function memoryFixture(flaws: MemoryDirectoryFlaws, options: { components: readonly ComponentDefinition[] }): Promise<ConversationDirectorySubject> {
  const clock = createManualClock();
  const app = await defineApp({ components: [...options.components], clock, logger: silentLogger }).create();
  await app.start();
  const ctx = app.context();
  const registry = new Map<string, { conversationId: string; place: DirectoryPlace }>();
  const log: MemoryDirectoryUpdate[] = [];
  let conversations = 0;
  let seq = 0;
  let double: MemoryDirectory;
  const send = (update: MemoryDirectoryUpdate) => {
    log.push(update);
    double.seen(update);
  };
  const reset = async (key: string) => {
    const record = registry.get(key);
    if (record === undefined) throw new Error(`no conversation for ${key}`);
    const previous = { key, conversationId: record.conversationId };
    const next = { key, conversationId: `c${++conversations}` };
    registry.set(key, { ...record, conversationId: next.conversationId });
    send({ kind: "reset", previous, ref: { ...next, ...record.place }, at: clock.now(), seq: ++seq });
    return next;
  };
  double = flawedMemoryDirectory({ reset: async (key) => void (await reset(key)) }, flaws);
  const refOf = (key: string) => {
    const record = registry.get(key);
    if (record === undefined) throw new Error(`no conversation for ${key}`);
    return { key, conversationId: record.conversationId, ...record.place };
  };
  return {
    directory: double.directory,
    ctx,
    advance: (ms) => clock.advance(ms),
    async message(key, message) {
      if (!registry.has(key)) registry.set(key, { conversationId: `c${++conversations}`, place: message.place });
      const ref = refOf(key);
      send({ kind: "dispatched", ref, requestId: message.requestId, ...(message.sender !== undefined && { sender: message.sender }), duplicate: message.duplicate === true, at: clock.now(), seq: ++seq });
      return { key, conversationId: ref.conversationId };
    },
    async started(ref, requestId) {
      send({ kind: "started", ref, requestId, at: clock.now(), seq: ++seq });
    },
    async settled(ref, requestIds) {
      send({ kind: "settled", ref, requestId: requestIds[0] ?? "", requestIds, at: clock.now(), seq: ++seq });
    },
    reset,
    async replay() {
      for (const update of [...log].reverse()) double.seen(update);
    },
    async restart() {
      double = double.restart();
      return double.directory;
    },
    close: () => app.stop(),
  };
}

async function failing(flaws: MemoryDirectoryFlaws): Promise<string[]> {
  const failed: string[] = [];
  for (const c of createConversationDirectoryConformance((options) => memoryFixture(flaws, options))) await c.run().catch(() => failed.push(c.name));
  return failed;
}

test("the in-memory double passes every case", async () => {
  const failed: { name: string; error: string }[] = [];
  for (const c of createConversationDirectoryConformance((options) => memoryFixture({}, options))) {
    await c.run().catch((error: unknown) => failed.push({ name: c.name, error: error instanceof Error ? error.message : String(error) }));
  }
  expect(failed).toEqual([]);
});

test("createMemoryDirectory is the double without flaws", () => {
  const double = createMemoryDirectory({ reset: async () => {} });
  expect(typeof double.directory.list).toBe("function");
  expect(typeof double.restart().seen).toBe("function");
});

test("each broken double fails the case of the guarantee it breaks", async () => {
  const expected: [MemoryDirectoryFlaws, string][] = [
    [{ ownerIgnored: true }, "another's conversation is not found by key nor by id, and a key with another's conversation id is nobody's"],
    [{ grantsIgnored: true }, "people see what they own and the spaces their grants name; operators and components see everything"],
    [{ titleReversed: true }, "one title: first < model < rename; a title before the conversation's first message applies; a text that cleans to nothing writes nothing"],
    [{ hideForEveryone: true }, "hide, a name and a read mark are each viewer's own"],
    [{ operatorShown: true }, "an operator's activity moves operators' order only, never people's"],
    [{ staleAccess: true }, "a member removed from a space is refused at once, by access and by every act"],
    [{ noReset: true }, "deleting a key's current conversation resets the key: the platform's next message starts a new conversation"],
    [{ unreadOwn: true }, "unread: activity of others after the viewer's mark, never one's own nor an operator's; capped; marks only forward"],
    [{ hideForever: true }, "hide for me ends with activity the viewer sees, never with an operator's"],
    [{ spaceOwnerDeletes: true }, "rename, archive and delete for everyone: a member none, a space's owner renames and archives, never deletes; the owner and operators all"],
    [{ seqIgnored: true }, "a late or repeated update changes nothing"],
    [{ deletedRevives: true }, "archive and delete are for everyone; an archived one comes back with activity people see, a deleted one never; people never list deleted"],
  ];
  for (const [flaws, name] of expected) expect({ flaws, failed: await failing(flaws) }).toEqual({ flaws, failed: expect.arrayContaining([name]) });
}, 60_000);

test("cleanTitle: one line with words, no label, quotes, hidden characters or end punctuation, a capital first, at most TITLE_MAX", () => {
  expect(cleanTitle("  \n hello   there \n more")).toBe("Hello there");
  expect(cleanTitle('Title: "trip to Lisbon."\nmore')).toBe("Trip to Lisbon");
  expect(cleanTitle(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(7)}c`)).toBe("A b c");
  expect([...(cleanTitle("word ".repeat(40)) ?? "")].length).toBeLessThanOrEqual(TITLE_MAX);
  expect(cleanTitle("x".repeat(100))?.length).toBe(TITLE_MAX);
  expect(cleanTitle("  ")).toBeUndefined();
  expect(cleanTitle('"" ** --')).toBeUndefined();
});

test("parseViewer: checked and copied; people never of the dashboard or delegate channel, 1 to 20 principals", () => {
  expect(parseViewer({ kind: "people", principals: [{ channel: "web", id: "u1", name: " Ana ", extra: 1 }] })).toEqual({ kind: "people", principals: [{ channel: "web", id: "u1", name: "Ana" }] });
  expect(parseViewer({ kind: "operator", id: "op", extra: true })).toEqual({ kind: "operator", id: "op" });
  for (const bad of [{ kind: "people", principals: [{ channel: "dashboard", id: "op" }] }, { kind: "people", principals: [{ channel: "delegate", id: "t" }] }, { kind: "people", principals: [] }, { kind: "component" }, "operator"]) {
    expect(() => parseViewer(bad)).toThrow(DirectoryError);
  }
  expect(viewerKey({ kind: "operator", id: "op" })).toBe("dashboard:op");
  expect(viewerKey({ kind: "people", principals: [{ channel: "web", id: "u1" }, { channel: "googlechat", id: "users/1" }] })).toBe("web:u1");
  expect(viewerKey({ kind: "component", name: "c" })).toBeUndefined();
  expect(viewerAuthor({ kind: "people", principals: [{ channel: "web", id: "u1" }] })).toEqual({ kind: "person", principal: { channel: "web", id: "u1" } });
});

test("the order and its cursor: newest first, then key and conversation id by code point; a cursor round-trips any key", () => {
  const low = String.fromCodePoint(0xffff);
  const high = String.fromCodePoint(0x10000);
  const items = [
    { lastActivity: 1, key: "a", conversationId: "1" },
    { lastActivity: 2, key: "a", conversationId: "1" },
    { lastActivity: 2, key: "b", conversationId: "1" },
    { lastActivity: 2, key: "b", conversationId: "2" },
    { lastActivity: 2, key: low, conversationId: "1" },
    { lastActivity: 2, key: high, conversationId: "1" },
  ];
  expect([...items].sort(compareDirectoryOrder).map((each) => `${each.lastActivity}:${each.key}:${each.conversationId}`)).toEqual([`2:${high}:1`, `2:${low}:1`, "2:b:2", "2:b:1", "2:a:1", "1:a:1"]);
  const odd = { lastActivity: 1_700_000_000_123, key: "web:u%1:c 2", conversationId: "x:y" };
  expect(parseDirectoryCursor(directoryCursor(odd))).toEqual(odd);
  for (const bad of ["", "1:a", "-1:a:b", "01:a:b", "1:%E0%A4%A:b", "1::b", "1:a:b:c"]) expect(() => parseDirectoryCursor(bad)).toThrow(DirectoryError);
});

test("parseDirectoryQuery, the search pattern, titles' precedence, permissions and buckets", () => {
  expect(parseDirectoryQuery({})).toEqual({ limit: 50, state: "listed" });
  expect(parseDirectoryQuery({ q: "  plan ", owned: true, channels: ["web"], space: "project:p1" })).toEqual({ limit: 50, state: "listed", q: "plan", owned: true, channels: ["web"], space: "project:p1" });
  for (const bad of [{ limit: 0 }, { limit: 1.5 }, { state: "gone" }, { q: 3 }, { channels: [] }, { owned: "yes" }, { space: "" }]) expect(() => parseDirectoryQuery(bad)).toThrow(DirectoryError);
  expect(likePattern("100%_a\\B")).toBe("%100\\%\\_a\\\\b%");
  expect(matchesSearch("PLAN", ["The plan"])).toBe(true);
  expect(matchesSearch("%", ["no"])).toBe(false);
  expect([titleApplies(undefined, "first"), titleApplies("first", "model"), titleApplies("model", "model"), titleApplies("model", "first"), titleApplies("rename", "model"), titleApplies("rename", "rename")]).toEqual([true, true, true, false, false, true]);
  expect(permissionsOf("space-owner")).toEqual({ rename: true, archive: true, delete: false });
  expect(permissionsOf("member")).toEqual({ rename: false, archive: false, delete: false });
  expect(permissionsOf("owner")).toEqual({ rename: true, archive: true, delete: true });
  expect([listStateOf({ state: "deleted", mine: { hidden: true } }), listStateOf({ state: "archived", mine: { hidden: true } }), listStateOf({ state: "archived" })]).toEqual(["deleted", "hidden", "archived"]);
  expect([stillHidden(undefined, 1), stillHidden(5, 5), stillHidden(5, 6)]).toEqual([false, true, false]);
});
