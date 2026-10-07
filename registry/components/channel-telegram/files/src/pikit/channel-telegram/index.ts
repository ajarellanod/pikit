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
 *   conversation durably accepted it; a redelivery is a duplicate request, answered once, and a
 *   redelivered command runs once. One whose admission keeps failing is tried again for 15 minutes,
 *   then its sender is told and it is skipped.
 * - Answers: one per run, whichever messages the run took, delivered by `startAnswerDelivery`
 *   (`@pikit/contracts`) from `agent.submissions`' feed (runtime-pi provides it), with a cursor and
 *   marks in this channel's namespace of `storage.kv` (`storage-kv-sql`). `agent.settled` /
 *   `agent.failed` only wake it: an answer that ended while the channel was stopped (a deploy), whose
 *   event was lost, or whose delivery failed, is delivered when it reads again. One chat's answers go
 *   in order, and chats do not wait for each other. The channel supplies only what is Telegram's: its
 *   bots' transports (`transport.ts`), which bot a conversation is, its words (`replyText`) and its
 *   waits (`DELIVERY`).
 *   With an `outbound.queue` installed (`outbound-durable`), answers are enqueued, stored before
 *   they are sent, through the same transports; without one, each piece is sent directly and marked,
 *   so a crash resends at most the piece in flight, marked `↻ `.
 * - Replies of its own (commands, a stranger told their id) and "typing…" go through `replies.ts`.
 *
 * It refuses to start when a bot has no valid token, no allowed user, or a webhook (Telegram
 * delivers to the webhook or by polling, never both).
 *
 * With a `health` provider (`health-registry`), each bot reports whether it receives messages: the
 * default one as `channel-telegram`, a named one as `channel-telegram:<name>` (`poller.ts`).
 *
 * Target: `server`: long polling needs a process that keeps running.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent } from "@pikit/core";
import { type AgentResult, type AnswerDelivery, type ChannelTransport, type DeliveryPolicy, isDashboardRequest, type RunSettlement, startAnswerDelivery } from "@pikit/contracts";
import Type from "typebox";
import { type Account, ACCOUNT_NAME, accountsOf, chatIn } from "./account.ts";
import { botLink, createTelegramApi, parseAllowedUsers, TelegramError } from "./api.ts";
import { handleUpdate, type InboundDeps, tellNotTaken } from "./inbound.ts";
import { type Poller, startPolling } from "./poller.ts";
import { createReplies, type Replies } from "./replies.ts";
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

/**
 * How answers are delivered (`startAnswerDelivery`): an answer that failed is tried again after 1 s,
 * 5 s, 30 s, then every minute (or after Telegram's `retry_after`), and logged as an error from its
 * 3rd failure in a row; other chats go on, up to 200 answers past one stuck; a run sends at most 20
 * pieces before it reads again; a send Telegram has not answered after 30 s may have reached it.
 */
const DELIVERY: DeliveryPolicy = { retryMs: [1_000, 5_000, 30_000, 60_000], blockedAfter: 3, window: 200, piecesPerRun: 20, sendTimeoutMs: 30_000 };

/** One bot, running. */
interface RunningBot {
  account: Account;
  transport: ChannelTransport;
  replies: Replies;
  poller: Poller;
}

export default defineComponent({
  name: "channel-telegram",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    // Every run's end, recorded by the runtime, and this channel's place in it: no answer is lost
    // while the channel is stopped.
    const submissions = pikit.use("agent.submissions");
    const storage = pikit.use("storage.kv");
    // Optional: with it, answers are stored before they are sent (@pikit/contracts' outbound.ts).
    const outbound = pikit.useOptional("outbound.queue");
    // Optional: with it, each bot reports whether it receives messages (@pikit/contracts' health.ts).
    const health = pikit.useOptional("health");

    let running: { bots: RunningBot[]; answers: AnswerDelivery } | undefined;

    /** The bot and chat of a conversation this channel made, or `undefined` for another channel's. */
    const find = (bots: readonly RunningBot[], key: string): { bot: RunningBot; chatId: number } | undefined => {
      for (const bot of bots) {
        const chatId = chatIn(bot.account.instance, key);
        if (chatId !== undefined) return { bot, chatId };
      }
      return undefined;
    };

    pikit.on("agent.started", ({ conversation, requestId }) => {
      // A run an operator's message from the dashboard started shows nothing in the chat: its answer stays there.
      if (isDashboardRequest(requestId)) return;
      const found = find(running?.bots ?? [], conversation.key);
      found?.bot.replies.typingStarted(found.chatId);
    });
    // A run ended: its answer is in the feed, and delivery reads it now (or when the channel starts again).
    const ended = async (result: AgentResult, ctx: AppContext): Promise<void> => {
      const now = running;
      const found = find(now?.bots ?? [], result.conversation.key);
      if (now === undefined || found === undefined) return;
      found.bot.replies.typingStopped(found.chatId);
      await now.answers.wake(ctx);
    };
    pikit.on("agent.settled", ended);
    pikit.on("agent.failed", ended);

    return {
      async start(ctx) {
        // Updates and replies outlive start: they get the app's context, not start's.
        const background: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
        const bots: RunningBot[] = [];
        try {
          for (const account of accountsOf(config.accounts)) bots.push(await startBot(account, ctx.abortSignal, background));
          // Once the bots run: what ended while the channel was stopped is delivered now.
          const answers = await startAnswerDelivery(ctx, {
            name: "channel-telegram",
            answers: submissions.get().answers,
            store: storage.get().namespace("channel-telegram"),
            transports: new Map(bots.map((bot) => [bot.account.instance, bot.transport])),
            route: (key) => find(bots, key)?.bot.account.instance,
            text: replyText,
            queue: outbound.get(),
            policy: DELIVERY,
          });
          running = { bots, answers };
        } catch (error) {
          // A bot that could not start leaves none of the others running.
          await stopBots(bots, undefined);
          throw error;
        }
      },

      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping === undefined) return;
        // A direct send in flight is aborted, and its piece stays `sending`: sent again, marked, at
        // the next start. The queue's sends through these transports end or are aborted too.
        await stopping.answers.stop(ctx.abortSignal);
        await stopBots(stopping.bots, ctx.abortSignal);
      },
    };

    async function startBot(account: Account, signal: AbortSignal | undefined, background: AppContext): Promise<RunningBot> {
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
      const replies = createReplies(api, transport, background.logger, account.instance);
      const deps: InboundDeps = {
        instance: account.instance,
        bot: me,
        allowed,
        delivery: replies,
        conversations: conversations.get(),
        runtime: runtime.get(),
        store: storage.get().namespace("channel-telegram"),
        ctx: background,
        refused: new Set(),
      };
      // It answered getMe and getWebhookInfo: up until a poll says otherwise.
      const reporter = health.get()?.reporter(account.name === undefined ? "channel-telegram" : `channel-telegram:${account.name}`);
      reporter?.up();
      const poller = startPolling({
        api,
        timeoutSeconds: config.pollTimeoutSeconds,
        handle: (update) => handleUpdate(update, deps),
        giveUp: (update) => tellNotTaken(update, deps),
        logger: background.logger,
        ...(reporter !== undefined && { health: reporter }),
      });
      background.logger.info("channel-telegram: receiving messages", {
        instance: account.instance,
        bot: `@${me.username ?? me.first_name}`,
        link: botLink(me),
        allowedUsers: allowed.size,
      });
      return { account, transport, replies, poller };
    }
  },
});

/** Stops polling and "typing…", and waits for the replies in flight. */
async function stopBots(bots: RunningBot[], signal: AbortSignal | undefined): Promise<void> {
  await Promise.all(
    bots.map(async ({ replies, poller }) => {
      await poller.stop(signal);
      await replies.close();
    }),
  );
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
