/**
 * channel-telegram: talk to your agents in Telegram.
 *
 * Each bot receives messages by long polling (no public URL needed), lets through only the Telegram
 * users its allowlist names, hands each message to its conversation (`<instance>:<chat id>`) and
 * sends the agent's answer back, with "typing…" while it works. `pikit configure` sets it up: it
 * checks each bot's token and allows you by asking you to send the bot a message.
 *
 * - Accounts (`account.ts`): one bot by default (`TELEGRAM_BOT_TOKEN`, instance `telegram`); each
 *   name in `accounts` adds one (`TELEGRAM_<NAME>_BOT_TOKEN`, instance `telegram:<name>`), with its
 *   own allowed users and conversations. A router can send each bot to its own agent
 *   (`router-rules`).
 * - Ingress (`poller.ts`, `inbound.ts`): a message is acknowledged to Telegram only once its
 *   conversation durably accepted it; a redelivery is a duplicate request, answered once.
 * - Replies: the chat gets one answer per run, whichever messages the run took.
 *   - With `agent.submissions` (runtime-pi provides it) and `storage.kv` (`storage-kv-sql`) installed,
 *     answers are read from its feed with a cursor of this channel's own (`answers.ts`), and `agent.settled` /
 *     `agent.failed` only wake the reader: an answer that ended while the channel was stopped (a
 *     deploy), or whose delivery failed, is delivered when it reads again. Its cursor moves only past
 *     answers delivered: stored in the outbox, or sent to Telegram.
 *   - Without them, the channel answers from `agent.settled` / `agent.failed` directly. An answer that
 *     arrives while it is stopped is not sent, and is logged as such.
 *   With an `outbound.queue` installed (`outbound-durable`), the answer is enqueued, stored before it
 *   is sent, and delivered through the bot's transport (`transport.ts`), which the channel attaches
 *   while it runs: it survives crashes and outages. Without one, it is sent directly (`replies.ts`),
 *   retried in the process: best effort.
 *
 * It refuses to start when a bot has no valid token, no allowed user, or a webhook (Telegram
 * delivers to the webhook or by polling, never both).
 *
 * Target: `server`: long polling needs a process that keeps running.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { type AgentResult, answerKey, type OutboundQueue, type RunSettlement } from "@pikit/contracts";
import Type from "typebox";
import { type Account, ACCOUNT_NAME, accountsOf, chatIn } from "./account.ts";
import { type AnswerReader, openCursors, startAnswerReader } from "./answers.ts";
import { botLink, createTelegramApi, parseAllowedUsers, TelegramError } from "./api.ts";
import { handleUpdate, type InboundDeps } from "./inbound.ts";
import { type Poller, startPolling } from "./poller.ts";
import { createDelivery, type Delivery } from "./replies.ts";
import { createTelegramTransport } from "./transport.ts";

/** The default bot's secrets; a named account's are in `account.ts`. */
export const TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";
export const ALLOWED_SECRET = "TELEGRAM_ALLOWED_USERS";

const Config = Type.Object({
  /** The Bot API server. A value, for a local Bot API server or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.telegram.org" }),
  /** How long one `getUpdates` waits for messages. Longer means fewer requests, not slower answers. */
  pollTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 50, default: 30 }),
  /** More bots, by name, besides the default one: `["ops"]` runs `telegram:ops` with `TELEGRAM_OPS_BOT_TOKEN`. */
  accounts: Type.Array(Type.String({ pattern: ACCOUNT_NAME }), { default: [], uniqueItems: true }),
});

/** One bot, running. */
interface RunningBot {
  account: Account;
  delivery: Delivery;
  poller: Poller;
}

export default defineComponent({
  name: "channel-telegram",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    // Optional: with it, answers are stored before they are sent (@pikit/contracts' outbound.ts).
    const outbound = pikit.useOptional("outbound.queue");
    // Optional, together: with them, answers are delivered from the record of every run's end, from a
    // cursor kept in storage.kv, so none is lost while the channel is stopped (`answers.ts`).
    const submissions = pikit.useOptional("agent.submissions");
    const storage = pikit.useOptional("storage.kv");

    let running: { bots: RunningBot[]; queue: OutboundQueue | undefined; background: AppContext; reader: AnswerReader | undefined } | undefined;
    /**
     * Whether answers come from the feed: decided by what is installed, not by whether the channel
     * started, since the runtime resumes runs (and ends some) before the channel's first start.
     */
    const fromFeed = (): boolean => submissions.get() !== undefined && storage.get() !== undefined;
    /** Every instance this channel serves, from config: a key of theirs is this channel's, running or not. */
    const instances = accountsOf(config.accounts).map((account) => account.instance);
    const ours = (key: string): boolean => instances.some((instance) => chatIn(instance, key) !== undefined);

    /** The bot and chat of a conversation this channel made, or `undefined` for another channel's. */
    const find = (bots: readonly RunningBot[], key: string): { bot: RunningBot; chatId: number } | undefined => {
      for (const bot of bots) {
        const chatId = chatIn(bot.account.instance, key);
        if (chatId !== undefined) return { bot, chatId };
      }
      return undefined;
    };

    /**
     * Hands one run's answer to its chat: enqueued with the outbox, else sent directly. Rejects when
     * the outbox could not store it, or Telegram could not be reached (or the channel stopped) before
     * it was sent. A run that answered nothing (aborted, or an empty text) sends nothing.
     */
    const deliver = async (answer: RunSettlement, bots: readonly RunningBot[], queue: OutboundQueue | undefined): Promise<void> => {
      const found = find(bots, answer.conversation.key);
      if (found === undefined) return;
      const { bot, chatId } = found;
      bot.delivery.typingStopped(chatId);
      const text = replyText(answer);
      if (text === undefined) return;
      if (queue === undefined) {
        await bot.delivery.sendOrFail(chatId, text);
        return;
      }
      // One key per run (the request that started it): a run resumed after a crash is not answered twice.
      await queue.enqueue({
        idempotencyKey: answerKey(answer.conversation, answer.requestId),
        channel: bot.account.instance,
        conversationKey: answer.conversation.key,
        text,
      });
    };

    pikit.on("agent.started", ({ conversation }) => {
      const found = find(running?.bots ?? [], conversation.key);
      found?.bot.delivery.typingStarted(found.chatId);
    });
    const answer = async (result: AgentResult, ctx: AppContext): Promise<void> => {
      if (!ours(result.conversation.key)) return;
      const now = running;
      if (fromFeed()) {
        // The answer is in the feed: the reader delivers it now, or when the channel starts again.
        if (now === undefined) return;
        const found = find(now.bots, result.conversation.key);
        found?.bot.delivery.typingStopped(found.chatId);
        now.reader?.wake();
        return;
      }
      if (now === undefined) {
        ctx.logger.warn("channel-telegram: an answer ended while the channel was stopped, and is not sent; install a runtime that provides agent.submissions (runtime-pi) to deliver it when the channel starts again", {
          conversation: result.conversation.key,
          run: result.requestId,
        });
        return;
      }
      if (find(now.bots, result.conversation.key) === undefined) {
        ctx.logger.warn("channel-telegram: an answer for a bot that is not running is not sent", { conversation: result.conversation.key, run: result.requestId });
        return;
      }
      if (now.queue === undefined) {
        // Best effort: nothing would try it again.
        void deliver(result, now.bots, undefined).catch((error: unknown) =>
          now.background.logger.error("channel-telegram: a reply could not be sent", { conversation: result.conversation.key, run: result.requestId, error: String(error) }),
        );
        return;
      }
      await deliver(result, now.bots, now.queue).catch((error: unknown) =>
        now.background.logger.error("channel-telegram: an answer could not be stored for delivery, and is not sent; install a runtime that provides agent.submissions (runtime-pi) to try it again", {
          conversation: result.conversation.key,
          run: result.requestId,
          error: String(error),
        }),
      );
    };
    pikit.on("agent.settled", answer);
    pikit.on("agent.failed", answer);

    return {
      async start(ctx) {
        // Updates and replies outlive start: they get the app's context, not start's.
        const background: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
        const queue = outbound.get();
        const recorded = submissions.get();
        const kv = storage.get();
        if (recorded !== undefined && kv === undefined) {
          background.logger.warn("channel-telegram: agent.submissions is installed but storage.kv is not, so answers come from events only: one that ends while the channel is stopped is not sent; install storage-kv-sql");
        }
        const cursors = recorded !== undefined && kv !== undefined ? await openCursors(kv.namespace("channel-telegram"), recorded.answers) : undefined;
        const bots: RunningBot[] = [];
        try {
          for (const account of accountsOf(config.accounts)) {
            bots.push(await startBot(account, ctx.abortSignal, background, queue));
          }
        } catch (error) {
          // A bot that could not start leaves none of the others running.
          await stopBots(bots, queue, undefined);
          throw error;
        }
        // Once the bots run: the first read delivers what ended while the channel was stopped.
        const reader =
          recorded !== undefined && cursors !== undefined
            ? startAnswerReader({ answers: recorded.answers, cursors, deliver: (fact) => deliver(fact, bots, queue), logger: background.logger })
            : undefined;
        running = { bots, queue, background, reader };
      },

      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping === undefined) return;
        // The reader stops; a direct send in flight is aborted with the bots, and its answer is not
        // behind the saved cursor: it is sent at the next start.
        const reading = stopping.reader?.halt();
        await stopBots(stopping.bots, stopping.queue, ctx.abortSignal);
        if (reading !== undefined) await Promise.race([reading, aborted(ctx.abortSignal)]);
      },
    };

    async function startBot(account: Account, signal: AbortSignal | undefined, background: AppContext, queue: OutboundQueue | undefined): Promise<RunningBot> {
      const token = await secrets.get().get(account.tokenSecret);
      if (token === undefined) {
        throw new Error(`channel-telegram: ${account.tokenSecret} is not set. Create a bot with @BotFather, then run \`pikit configure\``);
      }
      const allowed = parseAllowedUsers(await secrets.get().get(account.allowedSecret));
      if (allowed instanceof Error) throw new Error(`channel-telegram: ${allowed.message.replace("TELEGRAM_ALLOWED_USERS", account.allowedSecret)}`);
      if (allowed.size === 0) {
        throw new Error(`channel-telegram: ${account.allowedSecret} is empty, so nobody could talk to the bot. Run \`pikit configure\`: it allows you`);
      }

      const api = createTelegramApi(token, config.apiBase);
      const me = await api.getMe(signal).catch((error: unknown) => {
        if (error instanceof TelegramError && error.code === 401) throw new Error(`channel-telegram: ${account.tokenSecret} is not valid (Telegram answered 401)`);
        throw error;
      });
      const webhook = await api.getWebhookInfo(signal);
      if (webhook.url !== "") {
        throw new Error(
          `channel-telegram: the bot of ${account.tokenSecret} has a webhook, so Telegram does not deliver its messages by polling. ` +
            `If nothing else uses it, remove it: \`curl https://api.telegram.org/bot$${account.tokenSecret}/deleteWebhook\``,
        );
      }

      const transport = createTelegramTransport(api, account.instance);
      const delivery = createDelivery(api, transport, background.logger, account.instance);
      queue?.attach(account.instance, transport);
      const deps: InboundDeps = {
        instance: account.instance,
        bot: me,
        allowed,
        delivery,
        conversations: conversations.get(),
        runtime: runtime.get(),
        ctx: background,
        refused: new Set(),
      };
      const poller = startPolling({ api, timeoutSeconds: config.pollTimeoutSeconds, handle: (update) => handleUpdate(update, deps), logger: background.logger });
      background.logger.info("channel-telegram: receiving messages", {
        instance: account.instance,
        bot: `@${me.username ?? me.first_name}`,
        link: botLink(me),
        allowedUsers: allowed.size,
      });
      return { account, delivery, poller };
    }
  },
});

/** Stops polling, takes each transport back from the queue (sends in flight end or are aborted), and stops "typing…". */
async function stopBots(bots: RunningBot[], queue: OutboundQueue | undefined, signal: AbortSignal | undefined): Promise<void> {
  await Promise.all(
    bots.map(async ({ account, delivery, poller }) => {
      await poller.stop(signal);
      await queue?.detach(account.instance, signal);
      await delivery.close();
    }),
  );
}

/** Resolves when `signal` aborts; never, without one. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * What the chat is told about a run: its answer, or that it failed. Nothing for an aborted or empty one.
 * A message the runtime abandoned (`abandoned`: nothing could answer it) is never answered: the user
 * is asked to send it again.
 */
function replyText(answer: Pick<RunSettlement, "kind" | "text" | "error">): string | undefined {
  if (answer.kind === "failed" && answer.error?.code === "abandoned") return "Sorry, we could not answer your message. Please send it again.";
  if (answer.kind === "failed") return `Sorry, something went wrong while answering (${answer.error?.code ?? "error"}). Try again in a moment.`;
  if (answer.kind === "completed" && (answer.text ?? "").trim() !== "") return answer.text;
  return undefined;
}
