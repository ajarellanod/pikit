/**
 * Receiving updates by long polling (`getUpdates`): the bot asks Telegram for new messages and
 * waits up to `timeoutSeconds` for them. No public URL, certificate or open port is needed, so the
 * same project works on a laptop and on a VPS without a domain. (A webhook, which a Cloudflare
 * deployment needs, would be another component.)
 *
 * Acknowledgement: Telegram forgets an update once a later `getUpdates` asks for an `offset` past
 * it. The offset moves past an update only after `handle` resolved, that is once the message is
 * durably accepted by its conversation (`dispatch`'s admission, SPEC §5). A crash before that gets
 * the update again after the restart, and the conversation recognises it as a duplicate by its
 * request id, so it is answered once. An update whose handling keeps failing is skipped after a
 * few attempts, so one bad message cannot stop the bot.
 */

import type { Logger } from "@pikit/core";
import { type TelegramApi, TelegramError, type TelegramUpdate } from "./api.ts";

const ATTEMPTS_PER_UPDATE = 3;
const LONGEST_BACKOFF_MS = 30_000;

export interface Poller {
  /** Stop polling: the request in flight is cancelled, the update being handled finishes. */
  stop(signal?: AbortSignal): Promise<void>;
}

export function startPolling(options: {
  api: TelegramApi;
  timeoutSeconds: number;
  handle(update: TelegramUpdate): Promise<void>;
  logger: Logger;
}): Poller {
  const { api, handle, logger } = options;
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
      } catch (error) {
        if (stopping.signal.aborted) break;
        failures++;
        logger.warn("channel-telegram: could not receive updates", { error: String(error), hint: hintFor(error) });
        const retryAfter = error instanceof TelegramError ? error.retryAfter : undefined;
        await sleep(retryAfter !== undefined ? retryAfter * 1000 : Math.min(LONGEST_BACKOFF_MS, 1000 * 2 ** (failures - 1)));
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

function hintFor(error: unknown): string | undefined {
  if (!(error instanceof TelegramError)) return undefined;
  if (error.code === 409) return "another process is receiving this bot's messages (a second `pikit dev` or `pikit up`?), or a webhook was set";
  if (error.code === 401) return "TELEGRAM_BOT_TOKEN is no longer valid: create a new one with @BotFather and run `pikit configure`";
  if (error.code === 0) return "Telegram is unreachable from this machine";
  return undefined;
}
