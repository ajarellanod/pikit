/**
 * Sending the agent's answers to Telegram chats directly, and "typing…" while it works.
 *
 * - Used when no `outbound.queue` is installed; with one (`outbound-durable`), answers are enqueued
 *   instead (`index.ts`) and only "typing…" and the channel's own short replies (commands, a refused
 *   stranger) go through here.
 * - One chat's messages go out one at a time, in order; chats do not wait for each other.
 * - Each piece goes through the channel's transport (`transport.ts`: HTML or plain text, failures
 *   classified), retried in this process: a rate limit after Telegram's wait (at most a minute), a
 *   transient failure with backoff. A permanent one is logged and dropped.
 *
 * Delivery guarantee: best effort within the process. The answer is always in the conversation's
 * session; a reply lost to a crash while sending is not sent again. `outbound-durable` is the durable
 * delivery. An answer read from `agent.submissions`' feed is sent with `sendOrFail`, which rejects
 * when it could not be sent, so the feed's reader keeps it and tries again (`answers.ts`).
 */

import { type Logger } from "@pikit/core";
import { type ChannelTransport, DeliveryError } from "@pikit/contracts";
import type { TelegramApi } from "./api.ts";
import { conversationKeyOf } from "./account.ts";

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
  /** Queue `text` for `chatId`. Resolves when it was sent or given up (logged); never rejects. */
  send(chatId: number, text: string): Promise<void>;
  /**
   * Queue `text` for `chatId`, in the same line as `send`. Resolves once it was sent, or refused for
   * good (the user blocked the bot, the chat is gone: logged, as sending it again would fail the same
   * way). Rejects when Telegram could not be reached after the retries, or the channel stopped first:
   * the caller still has the answer and sends it again later. A long answer sent again may repeat
   * the pieces that had gone out.
   */
  sendOrFail(chatId: number, text: string): Promise<void>;
  /** Stop every "typing…", abandon waits between retries, and wait for sends in flight. */
  close(): Promise<void>;
}

/** Direct delivery through one bot: `instance` is its account's. */
export function createDelivery(api: TelegramApi, transport: ChannelTransport, logger: Logger, instance: string): Delivery {
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

  const sendPiece = async (chatId: number, text: string, index: number): Promise<void> => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await transport.send({ key: `direct:${chatId}:${index}`, conversationKey: conversationKeyOf(instance, chatId), text, possibleDuplicate: false }, closing.signal);
        return;
      } catch (error) {
        if (closing.signal.aborted) throw error;
        if (!(error instanceof DeliveryError) || error.kind === "permanent" || attempt === ATTEMPTS) throw error;
        await wait(error.kind === "rate_limited" ? Math.min(error.retryAfterMs ?? 1_000, LONGEST_WAIT_MS) : 1000 * 2 ** (attempt - 1));
      }
    }
  };

  const typingStopped = (chatId: number): void => {
    clearInterval(typing.get(chatId));
    typing.delete(chatId);
  };

  /** Sends every piece of `text` after the chat's previous messages; rejects with the first piece that failed. */
  const line = (chatId: number, text: string): Promise<void> => {
    const previous = lines.get(chatId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (closing.signal.aborted) throw new Error("channel-telegram: stopping");
      for (const [index, piece] of transport.split(text).entries()) await sendPiece(chatId, piece, index);
    });
    // The line itself never rejects: one message's failure does not stop the chat's next ones.
    const settled = next.catch(() => {});
    lines.set(chatId, settled);
    void settled.then(() => {
      if (lines.get(chatId) === settled) lines.delete(chatId);
    });
    return next;
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
      return line(chatId, text).catch((error: unknown) => logger.error("channel-telegram: a reply could not be sent", { chat: chatId, error: String(error) }));
    },
    async sendOrFail(chatId, text) {
      try {
        await line(chatId, text);
      } catch (error) {
        if (closing.signal.aborted || !(error instanceof DeliveryError) || error.kind !== "permanent") throw error;
        logger.error("channel-telegram: Telegram refused a reply for good; it is not sent", { chat: chatId, error: String(error) });
      }
    },
    async close() {
      closing.abort(new Error("channel-telegram: stopping"));
      for (const chatId of [...typing.keys()]) typingStopped(chatId);
      await Promise.allSettled([...lines.values()]);
    },
  };
}
