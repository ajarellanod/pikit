/**
 * The poller against `fake-telegram.test-support.ts`: an update whose handling fails is tried again
 * without the poller moving past it, and only one that fails past the time budget is skipped, its
 * sender told first. The budget is shortened here; `UPDATE_RETRY` is what the channel runs with.
 */

import { afterEach, expect, test } from "bun:test";
import { silentLogger } from "@pikit/core";
import { createTelegramApi, type TelegramUpdate } from "./api.ts";
import { type FakeTelegram, startFakeTelegram } from "./fake-telegram.test-support.ts";
import { type InboundDeps, NOT_TAKEN, tellNotTaken } from "./inbound.ts";
import { type Poller, startPolling, UPDATE_RETRY, type UpdateRetry } from "./poller.ts";

const OWNER = { id: 1001, first_name: "Ada" };
const STRANGER = { id: 2002, first_name: "Eve" };

const fakes: FakeTelegram[] = [];
const pollers: Poller[] = [];
afterEach(async () => {
  for (const poller of pollers.splice(0)) await poller.stop();
  for (const fake of fakes.splice(0)) await fake.stop();
});

function poll(handle: (update: TelegramUpdate) => Promise<void>, giveUp: (update: TelegramUpdate) => Promise<void>, retry: UpdateRetry) {
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const start = () => pollers.push(startPolling({ api: createTelegramApi(telegram.token, telegram.url), timeoutSeconds: 1, handle, giveUp, logger: silentLogger, retry }));
  return { telegram, start };
}

async function until(done: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test("the channel gives a failing update minutes, not seconds", () => {
  expect(UPDATE_RETRY.giveUpAfterMs).toBeGreaterThanOrEqual(10 * 60_000);
  expect(UPDATE_RETRY.longestMs).toBeLessThanOrEqual(UPDATE_RETRY.giveUpAfterMs);
});

test("an update that keeps failing is tried again, and the poller does not move past it until it is taken", async () => {
  const calls: number[] = [];
  const skipped: number[] = [];
  let failures = 6;
  const { telegram, start } = poll(
    async (update) => {
      calls.push(update.update_id);
      if (update.update_id === 1 && failures-- > 0) throw new Error("the runtime cannot take messages for a while");
    },
    async (update) => void skipped.push(update.update_id),
    { firstMs: 5, longestMs: 20, giveUpAfterMs: 60_000 },
  );
  telegram.say(OWNER, "first");
  telegram.say(OWNER, "second");
  start();

  await until(() => calls.includes(2), "the second update");

  // Six failures, more than the old three tries: the first is taken, then the second, in order.
  expect(calls).toEqual([1, 1, 1, 1, 1, 1, 1, 2]);
  expect(skipped).toEqual([]);
});

test("an update that still fails past the budget is skipped, and its sender is told first", async () => {
  const calls: number[] = [];
  const events: string[] = [];
  const { telegram, start } = poll(
    async (update) => {
      calls.push(update.update_id);
      if (update.update_id === 1) throw new Error("a poison message");
      events.push(`handled ${update.update_id}`);
    },
    async (update) => void events.push(`told ${update.update_id}`),
    { firstMs: 5, longestMs: 20, giveUpAfterMs: 100 },
  );
  telegram.say(OWNER, "poison");
  telegram.say(OWNER, "next");
  start();

  await until(() => events.includes("handled 2"), "the update after the poison one");

  expect(events).toEqual(["told 1", "handled 2"]);
  expect(calls.filter((id) => id === 1).length).toBeGreaterThan(1);
  // Skipped means confirmed: Telegram does not deliver it again.
  await until(() => telegram.pending().every((update) => update.update_id > 2), "the offset past both updates");
});

test("the sender told is an allowed user in a private chat; anyone else is not", async () => {
  const sent: [number, string][] = [];
  const deps = {
    allowed: new Set([OWNER.id]),
    delivery: { send: async (chatId: number, text: string) => void sent.push([chatId, text]) },
  } as unknown as InboundDeps;
  const update = (from: { id: number; first_name: string }, type: "private" | "group"): TelegramUpdate => ({
    update_id: 1,
    message: { message_id: 1, from: { ...from, is_bot: false }, chat: { id: type === "private" ? from.id : -5, type }, date: 0, text: "hi" },
  });

  await tellNotTaken(update(OWNER, "private"), deps);
  await tellNotTaken(update(STRANGER, "private"), deps);
  await tellNotTaken(update(OWNER, "group"), deps);

  expect(sent).toEqual([[OWNER.id, NOT_TAKEN]]);
});
