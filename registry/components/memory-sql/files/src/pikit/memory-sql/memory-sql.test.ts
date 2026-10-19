/**
 * memory-sql's tests, copied with the component: the `memory` suite (`conformance.ts`) over an App of
 * memory-sql, an in-memory mailbox (`createMemoryMailbox`, every key's actor is the App, as on a server)
 * and `sqliteStorage()` (a restart is a second App over the same database); then what only this
 * provider promises: a person's actor answers only for that person, and checks what it is sent.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createMemoryConformance } from "./conformance.ts";
import memorySql, { actorKey, CALL } from "./index.ts";

for (const c of createMemoryConformance(() => {
  const storage = sqliteStorage();
  const mailbox = createMemoryMailbox();
  return { components: () => [storage, mailbox, memorySql] };
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

test("a person's actor refuses a call for another person, and a malformed one, as invalid", async () => {
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
    const ana = { agent: "assistant", person: "telegram:1" };

    expect(await codeOf(call(actorKey("telegram:2"), CALL.list, { ...ana, kind: "fact", limit: 10 }))).toBe("invalid");
    expect(await codeOf(call(actorKey("telegram:2"), CALL.remember, { ...ana, memory: { id: "x", kind: "fact", text: "likes tea", createdAt: 1 } }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana.person), CALL.list, { ...ana, kind: "fact", limit: 0 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana.person), CALL.list, { ...ana, kind: "secret", limit: 1 }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana.person), CALL.remember, { ...ana, memory: { id: "x", kind: "fact", text: "likes tea" } }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana.person), CALL.forget, { agent: "assistant", id: "x" }))).toBe("invalid");
    expect(await codeOf(call(actorKey(ana.person), CALL.list, ["not", "an", "object"]))).toBe("invalid");
    expect(await call(actorKey(ana.person), CALL.list, { ...ana, kind: "fact", limit: 10 })).toEqual([]);
  } finally {
    await app.stop();
  }
});
