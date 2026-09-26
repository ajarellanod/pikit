/**
 * Sending the agent's answers to Telegram chats, and "typing…" while it works.
 *
 * - One chat's messages go out one at a time, in order; chats do not wait for each other.
 * - An answer is split (`format.ts`) and each piece is sent as Telegram HTML, or as plain text when
 *   Telegram refuses the HTML.
 * - A piece that fails is retried in this process: after `retry_after` for a 429, with backoff for a
 *   network error or a 5xx. Other refusals (a chat that blocked the bot) are logged and dropped.
 *
 * Delivery guarantee (M1): best effort within the process. The answer is always in the
 * conversation's session; a reply lost to a crash while sending is not sent again. Durable delivery
 * with retries across restarts is `outbound-durable`'s job (M2), through `channel.transport`.
 */

import type { Logger } from "@pikit/core";
import { type TelegramApi, TelegramError } from "./api.ts";
import { MAX_MESSAGE_LENGTH, splitMessage, toTelegramHtml } from "./format.ts";

/** How often "typing…" is renewed: Telegram shows it for about 5 seconds. */
const TYPING_EVERY_MS = 4_000;
/** A run that has not ended after this long stops showing "typing…". */
const TYPING_AT_MOST_MS = 10 * 60_000;
const ATTEMPTS = 4;
const LONGEST_WAIT_MS = 60_000;

export interface Delivery {
  /** Show "typing…" in `chatId` until `typingStopped` (or a limit). */
  typingStarted(chatId: number): void;
  typingStopped(chatId: number): void;
  /** Queue `text` for `chatId`. Resolves when it was sent or given up; never rejects. */
  send(chatId: number, text: string): Promise<void>;
  /** Stop every "typing…", abandon waits between retries, and wait for sends in flight. */
  close(): Promise<void>;
}

export function createDelivery(api: TelegramApi, logger: Logger): Delivery {
  const closing = new AbortController();
  const lines = new Map<number, Promise<void>>();
  const typing = new Map<number, ReturnType<typeof setInterval>>();

  /** Waits `ms`, or less when the channel stops. */
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        closing.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      closing.signal.addEventListener("abort", done, { once: true });
    });

  const sendPiece = async (chatId: number, piece: string): Promise<void> => {
    const html = toTelegramHtml(piece);
    let asHtml = html.length <= MAX_MESSAGE_LENGTH;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await api.sendMessage(chatId, asHtml ? html : piece, { html: asHtml }, closing.signal);
        return;
      } catch (error) {
        if (closing.signal.aborted) throw error;
        if (!(error instanceof TelegramError)) throw error;
        if (error.code === 400 && asHtml) {
          // Telegram could not parse the HTML: the same words, as plain text.
          asHtml = false;
          attempt--;
          continue;
        }
        const retryable = error.code === 0 || error.code === 429 || error.code >= 500;
        if (!retryable || attempt === ATTEMPTS) throw error;
        await wait(error.retryAfter !== undefined ? Math.min(error.retryAfter * 1000, LONGEST_WAIT_MS) : 1000 * 2 ** (attempt - 1));
      }
    }
  };

  const typingStopped = (chatId: number): void => {
    clearInterval(typing.get(chatId));
    typing.delete(chatId);
  };

  return {
    typingStarted(chatId) {
      if (typing.has(chatId) || closing.signal.aborted) return;
      const show = () => void api.sendChatAction(chatId, "typing", closing.signal).catch(() => {});
      show();
      const since = Date.now();
      typing.set(
        chatId,
        setInterval(() => (Date.now() - since > TYPING_AT_MOST_MS ? typingStopped(chatId) : show()), TYPING_EVERY_MS),
      );
    },
    typingStopped,
    send(chatId, text) {
      const previous = lines.get(chatId) ?? Promise.resolve();
      const next = previous.then(async () => {
        for (const piece of splitMessage(text)) {
          try {
            await sendPiece(chatId, piece);
          } catch (error) {
            logger.error("channel-telegram: a reply could not be sent", { chat: chatId, error: String(error) });
            return;
          }
        }
      });
      lines.set(chatId, next);
      void next.finally(() => {
        if (lines.get(chatId) === next) lines.delete(chatId);
      });
      return next;
    },
    async close() {
      closing.abort(new Error("channel-telegram: stopping"));
      for (const chatId of [...typing.keys()]) typingStopped(chatId);
      await Promise.allSettled([...lines.values()]);
    },
  };
}
