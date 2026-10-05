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
 * request id, so it is answered once. An update whose handling keeps failing is skipped after a
 * few attempts, so one bad message cannot stop the bot.
 *
 * Health (with a `health` provider): the bot is `up` after each `getUpdates` that answered,
 * `degraded` after one that failed, and `down` after `DOWN_AFTER_FAILURES` in a row. The reason
 * names the failure by Telegram's code only (`getUpdates failed 5 times: 401`), never the token.
 */

import type { Logger } from "@pikit/core";
import type { HealthReporter } from "@pikit/contracts";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./api.ts";

const ATTEMPTS_PER_UPDATE = 3;
const LONGEST_BACKOFF_MS = 30_000;
/** `getUpdates` failures in a row after which the bot is `down`: about 15 s of backoff, past a blip. */
export const DOWN_AFTER_FAILURES = 5;

export interface Poller {
  /** Stop polling: the request in flight is cancelled, the update being handled finishes. */
  stop(signal?: AbortSignal): Promise<void>;
}

export function startPolling(options: {
  api: TelegramApi;
  timeoutSeconds: number;
  handle(update: TelegramUpdate): Promise<void>;
  logger: Logger;
  /** Where the bot reports its state; none without a `health` provider. */
  health?: HealthReporter;
  /** The wait after a first failed `getUpdates`, doubled after each next one up to 30 s. */
  firstRetryMs?: number;
}): Poller {
  const { api, handle, logger, health } = options;
  const firstRetryMs = options.firstRetryMs ?? 1000;
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
    const attempts = new Map<number, number>();
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
          const tried = (attempts.get(update.update_id) ?? 0) + 1;
          attempts.set(update.update_id, tried);
          if (tried < ATTEMPTS_PER_UPDATE) {
            logger.warn("channel-telegram: an update failed; it will be tried again", { update: update.update_id, error: String(error) });
            await sleep(1000 * tried);
            break;
          }
          logger.error("channel-telegram: an update kept failing and is skipped", { update: update.update_id, error: String(error) });
        }
        attempts.delete(update.update_id);
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
