/**
 * Receiving updates by long polling (`getUpdates`): the bot asks Telegram for new messages and
 * waits up to `timeoutSeconds` for them. No public URL, certificate or open port is needed, so the
 * same project works on a laptop and on a VPS without a domain. (A webhook, which a Cloudflare
 * deployment needs, would be another component.)
 *
 * Acknowledgement: Telegram forgets an update once a later `getUpdates` asks for an `offset` past
 * it. The offset moves past an update only after `handle` resolved, that is once the message is
 * durably accepted by its conversation (`dispatch`'s admission, @pikit/contracts' agent.ts). A crash before that gets
 * the update again after the restart, and the conversation recognises it as a duplicate by its
 * request id, so it is answered once.
 *
 * An update whose handling fails (what admission needs is down for a while: a restart, a busy
 * database) is tried again with backoff, and the offset stays before it meanwhile: Telegram keeps it,
 * and the bot's later updates wait behind it, in order. One that still fails after
 * `GIVE_UP_AFTER_MS` is taken for a poison message: its sender is told (`giveUp`), and it is skipped,
 * so one bad message cannot stop the bot for good.
 *
 * Health (with a `health` provider): the bot is `up` after each `getUpdates` that answered,
 * `degraded` after one that failed, and `down` after `DOWN_AFTER_FAILURES` in a row. The reason
 * names the failure by Telegram's code only (`getUpdates failed 5 times: 401`), never the token.
 */

import type { Logger } from "@pikit/core";
import type { HealthReporter } from "@pikit/contracts";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./api.ts";

/** Waits between tries of `getUpdates` that failed: 1 s, doubling, up to this long. */
const LONGEST_BACKOFF_MS = 30_000;
/** `getUpdates` failures in a row after which the bot is `down`: about 15 s of backoff, past a blip. */
export const DOWN_AFTER_FAILURES = 5;

/**
 * How long an update that keeps failing is tried, from its first failure, before it is skipped and
 * its sender told: 15 minutes. Longer than what admission needs usually takes to come back (a
 * restart, a deploy, a database failover), so a transient failure loses nothing; short enough that a
 * poison message holds the bot's other chats up only that long. Telegram keeps an update for 24 hours,
 * so waiting costs nothing else.
 */
export const GIVE_UP_AFTER_MS = 15 * 60_000;

/** How an update that keeps failing is tried: after 0.5 s, doubling, up to a minute apart (about 20 tries in all). */
export interface UpdateRetry {
  firstMs: number;
  longestMs: number;
  giveUpAfterMs: number;
}
export const UPDATE_RETRY: UpdateRetry = { firstMs: 500, longestMs: 60_000, giveUpAfterMs: GIVE_UP_AFTER_MS };
/** From this failure of one update on, each one is logged as an error: the bot's chats are waiting. */
const LOUD_AFTER = 3;

export interface Poller {
  /** Stop polling: the request in flight is cancelled, the update being handled finishes. */
  stop(signal?: AbortSignal): Promise<void>;
}

export function startPolling(options: {
  api: TelegramApi;
  timeoutSeconds: number;
  handle(update: TelegramUpdate): Promise<void>;
  /** Tells the sender of an update that kept failing, before it is skipped; best effort. */
  giveUp(update: TelegramUpdate): Promise<void>;
  logger: Logger;
  /** Where the bot reports its state; none without a `health` provider. */
  health?: HealthReporter;
  /** The wait after a first failed `getUpdates`, doubled after each next one up to 30 s. */
  firstRetryMs?: number;
  /** `UPDATE_RETRY` unless a test shortens it. */
  retry?: UpdateRetry;
}): Poller {
  const { api, handle, giveUp, logger, health } = options;
  const firstRetryMs = options.firstRetryMs ?? 1000;
  const retry = options.retry ?? UPDATE_RETRY;
  const stopping = new AbortController();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stopping.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stopping.signal.addEventListener("abort", done, { once: true });
    });

  let offset: number | undefined;
  const loop = (async () => {
    let failures = 0;
    /** The update that is failing: the offset stays before it until it is handled or given up. */
    let failing: { updateId: number; since: number; tries: number } | undefined;
    while (!stopping.signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await api.getUpdates({ ...(offset !== undefined && { offset }), timeout: options.timeoutSeconds }, stopping.signal);
        failures = 0;
        health?.up();
      } catch (error) {
        if (stopping.signal.aborted) break;
        failures++;
        logger.warn("channel-telegram: could not receive updates", { error: String(error), hint: hintFor(error) });
        const reason = `getUpdates failed${failures > 1 ? ` ${failures} times` : ""}: ${failureCode(error)}`;
        if (failures >= DOWN_AFTER_FAILURES) health?.down(reason);
        else health?.degraded(reason);
        const retryAfter = error instanceof TelegramError ? error.retryAfter : undefined;
        await sleep(retryAfter !== undefined ? retryAfter * 1000 : Math.min(LONGEST_BACKOFF_MS, firstRetryMs * 2 ** (failures - 1)));
        continue;
      }
      for (const update of updates) {
        if (stopping.signal.aborted) break;
        try {
          await handle(update);
        } catch (error) {
          if (stopping.signal.aborted) break;
          if (failing?.updateId !== update.update_id) failing = { updateId: update.update_id, since: Date.now(), tries: 0 };
          failing.tries++;
          const failedFor = Date.now() - failing.since;
          if (failedFor < retry.giveUpAfterMs) {
            const wait = Math.min(retry.longestMs, retry.firstMs * 2 ** (failing.tries - 1));
            const fields = { update: update.update_id, tries: failing.tries, failingForMs: failedFor, error: String(error) };
            if (failing.tries < LOUD_AFTER) logger.warn("channel-telegram: an update failed; it will be tried again", fields);
            else logger.error("channel-telegram: an update keeps failing; the bot's later messages wait behind it", fields);
            await sleep(wait);
            // Asks again from the same offset: Telegram answers this update first.
            break;
          }
          logger.error("channel-telegram: an update kept failing and is skipped; its sender is told", {
            update: update.update_id,
            tries: failing.tries,
            failingForMs: failedFor,
            error: String(error),
          });
          await giveUp(update).catch((told: unknown) => logger.error("channel-telegram: the sender of a skipped update could not be told", { update: update.update_id, error: String(told) }));
        }
        failing = undefined;
        offset = update.update_id + 1;
      }
    }
  })();

  return {
    async stop(signal) {
      stopping.abort(new Error("channel-telegram: stopping"));
      await (signal === undefined ? loop : Promise.race([loop, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]));
      // Confirm what was handled, so the next process does not receive it again. Best effort.
      if (offset !== undefined) await api.getUpdates({ offset, timeout: 0 }, signal).catch(() => {});
    },
  };
}

/** What failed, for an operator: Telegram's code, `unreachable`, or the error's name. Never its message, which could quote a URL. */
function failureCode(error: unknown): string {
  if (error instanceof TelegramError) return error.code === 0 ? "unreachable" : String(error.code);
  return error instanceof Error ? error.name : "error";
}

function hintFor(error: unknown): string | undefined {
  if (!(error instanceof TelegramError)) return undefined;
  if (error.code === 409) return "another process is receiving this bot's messages (a second `pikit dev` or `pikit up`?), or a webhook was set";
  if (error.code === 401) return "TELEGRAM_BOT_TOKEN is no longer valid: create a new one with @BotFather and run `pikit configure`";
  if (error.code === 0) return "Telegram is unreachable from this machine";
  return undefined;
}
