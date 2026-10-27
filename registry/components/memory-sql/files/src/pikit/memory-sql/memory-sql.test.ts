/**
 * memory-sql's tests, copied with the component: the `memory` suite (`conformance.ts`) over an App of
 * memory-sql, an in-memory mailbox (`createMemoryMailbox`, every key's actor is the App, as on a server)
 * and `sqliteStorage()` (a restart is a second App over the same database), with one agent kept apart
 * (`agentScope`); then what only this provider promises: an owner's actor answers only for that owner,
 * and checks what it is sent; and how a query becomes FTS5 queries.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createMemoryConformance } from "./conformance.ts";
import memorySql, { actorKey, CALL, searchAttempts } from "./index.ts";

for (const c of createMemoryConformance(() => {
  const storage = sqliteStorage();
  const mailbox = createMemoryMailbox();
  return { components: () => [storage, mailbox, memorySql], config: { "memory-sql": { agentScope: ["trader"] } }, agentScope: ["trader"] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), memorySql], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "memory-sql")).toEqual({
    name: "memory-sql",
    provides: ["memory"],
    requires: ["storage.sql", "actor.mailbox", "actor.inbox"],
    optional: [],
  });
});

test("an owner's actor refuses a call for another owner, a kind the owner does not keep, and a malformed call, as invalid", async () => {
  let mailbox: ActorMailbox | undefined;
  const caller = defineComponent({
    name: "caller",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), memorySql, caller], logger: silentLogger }).create();
  await app.start();
  try {
    const call = (key: string, type: string, message: Parameters<ActorMailbox["call"]>[2]) => mailbox?.call(key, type, message, app.context());
    const codeOf = (work: Promise<unknown> | undefined) => work?.then(() => "resolved", (error: unknown) => (error instanceof ActorCallError ? error.code : String(error)));
    const team = { type: "space", space: "googlechat:spaces/A" } as const;
    const other = { type: "space", space: "googlechat:spaces/B" } as const;
    const ana = { type: "person", channel: "googlechat", id: "users/1" } as const;
    const fact = { id: "x", kind: "fact", status: "active", text: "likes tea", createdAt: 1 };

    expect(await codeOf(call(actorKey(other), CALL.list, { owner: team, kinds: ["fact"], limit: 10 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(other), CALL.remember, { owner: team, memory: fact }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana), CALL.list, { owner: team, kinds: ["fact"], limit: 10 }))).toBe("invalid");
    // A person's channel with a colon is not another person's key.
    expect(await codeOf(call(actorKey({ type: "person", channel: "a", id: "b:c" }), CALL.list, { owner: { type: "person", channel: "a:b", id: "c" }, kinds: ["preference"], limit: 1 }))).toBe(
      "invalid",
    );
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["fact"], limit: 0 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["secret"], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["preference"], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: [], limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, { owner: team, kinds: ["rule"], status: "maybe", limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.remember, { owner: team, memory: { ...fact, createdAt: undefined } as never }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.forget, { owner: { type: "space" }, id: "x", kinds: ["fact"] }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.approve, { owner: team, id: "x", kind: "preference" }))).toBe("invalid");
    expect(await codeOf(call(actorKey(team), CALL.list, ["not", "an", "object"]))).toBe("invalid");
    expect(await call(actorKey(team), CALL.list, { owner: team, kinds: ["fact"], limit: 10 })).toEqual([]);
  } finally {
    await app.stop();
  }
});

test("a query becomes FTS5 queries of its quoted words: all, the phrase, any; none without a word", () => {
  expect(searchAttempts("ana@example.com")).toEqual(['"ana" AND "example" AND "com"', '"ana example com"', '"ana" OR "example" OR "com"']);
  expect(searchAttempts('tea "NOT" (cake*')).toEqual(['"tea" AND "NOT" AND "cake"', '"tea NOT cake"', '"tea" OR "NOT" OR "cake"']);
  expect(searchAttempts("tea")).toEqual(['"tea"']);
  expect(searchAttempts("?! -- ...")).toEqual([]);
});
