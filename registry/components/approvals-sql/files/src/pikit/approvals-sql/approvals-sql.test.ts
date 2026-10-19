/**
 * approvals-sql's tests, copied with the component: the `approvals` suite (`conformance.ts`) over
 * SQLite and the in-memory mailbox (a server's mailbox-local does the same: every key is the App), and
 * what setup declares.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { ActorCallError, type ActorMailbox } from "@pikit/contracts";
import { createMemoryMailbox } from "@pikit/contracts/testing";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import { createApprovalsConformance } from "./conformance.ts";
import approvalsSql, { APPROVALS_KEY, CALL, isApprover } from "./index.ts";

for (const c of createApprovalsConformance(() => {
  const storage = sqliteStorage();
  const mailbox = createMemoryMailbox();
  return { app: () => [storage, mailbox, approvalsSql] };
})) {
  test(`approvals-sql ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), approvalsSql], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "approvals-sql")).toMatchObject({
    provides: ["approvals"],
    requires: ["storage.sql", "actor.mailbox", "actor.inbox"],
    optional: [],
  });
});

test("only the owner's key is answered: a call that reached another actor is refused", async () => {
  let mailbox: ActorMailbox | undefined;
  const reader = defineComponent({
    name: "reader",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [sqliteStorage(), createMemoryMailbox(), approvalsSql, reader], logger: silentLogger }).create();
  await app.start();
  try {
    const refused = await mailbox?.call("someone-else", CALL.list, {}, app.context()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid");
    expect(await mailbox?.call(APPROVALS_KEY, CALL.list, {}, app.context())).toEqual({ items: [] });
  } finally {
    await app.stop();
  }
});

test("isApprover: an exact sender, or anyone on a channel with <channel>:*", () => {
  expect(isApprover(["telegram:1"], { channel: "telegram", id: "1" })).toBe(true);
  expect(isApprover(["telegram:1"], { channel: "telegram", id: "10" })).toBe(false);
  expect(isApprover(["dashboard:*"], { channel: "dashboard", id: "ops" })).toBe(true);
  expect(isApprover(["dashboard:*"], { channel: "telegram", id: "ops" })).toBe(false);
  expect(isApprover(["google-chat:users/1"], { channel: "google-chat", id: "users/1" })).toBe(true);
  // A channel instance holds a `:`: the whole sender, or its own star; the plain channel's star is not its.
  expect(isApprover(["telegram:ops:12345"], { channel: "telegram:ops", id: "12345" })).toBe(true);
  expect(isApprover(["telegram:ops:*"], { channel: "telegram:ops", id: "7" })).toBe(true);
  expect(isApprover(["telegram:*"], { channel: "telegram:ops", id: "12345" })).toBe(false);
  expect(isApprover(["telegram:ops:*"], { channel: "telegram", id: "7" })).toBe(false);
});
