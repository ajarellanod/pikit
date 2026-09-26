/**
 * channel-telegram: talk to your agents in Telegram (SPEC §5).
 *
 * Each bot receives messages by long polling (no public URL needed), lets through only the Telegram
 * users its allowlist names, hands each message to its conversation (`<instance>:<chat id>`) and
 * sends the agent's answer back, with "typing…" while it works. `pikit configure` sets it up: it
 * checks each bot's token and allows you by asking you to send the bot a message.
 *
 * - Accounts (`account.ts`): one bot by default (`TELEGRAM_BOT_TOKEN`, instance `telegram`); each
 *   name in `accounts` adds one (`TELEGRAM_<NAME>_BOT_TOKEN`, instance `telegram:<name>`), with its
 *   own allowed users and conversations. A router can send each bot to its own agent (SPEC §5,
 *   "Routing to many agents").
 * - Ingress (`poller.ts`, `inbound.ts`): a message is acknowledged to Telegram only once its
 *   conversation durably accepted it; a redelivery is a duplicate request, answered once.
 * - Replies: the channel listens to `agent.settled` / `agent.failed` and answers the chat once per
 *   run, whichever messages the run took. With an `outbound.queue` installed (`outbound-durable`),
 *   the answer is enqueued, stored before it is sent, and delivered through the bot's transport
 *   (`transport.ts`), which the channel attaches while it runs: it survives crashes and outages.
 *   Without one, it is sent directly (`replies.ts`), retried in the process: best effort.
 *
 * It refuses to start when a bot has no valid token, no allowed user, or a webhook (Telegram
 * delivers to the webhook or by polling, never both).
 *
 * Target: `server`: long polling needs a process that keeps running.
 */

import { type AgentResult, type AppContext, BACKGROUND_CONTEXT, defineComponent, type OutboundQueue } from "@pikit/core";
import Type from "typebox";
import { type Account, ACCOUNT_NAME, accountsOf, chatIn } from "./account.ts";
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
    // Optional: with it, answers are stored before they are sent (SPEC §5, "Outbound delivery").
    const outbound = pikit.useOptional("outbound.queue");

    let running: { bots: RunningBot[]; queue: OutboundQueue | undefined; background: AppContext } | undefined;

    /** The bot and chat of a conversation this channel made, or `undefined` for another channel's. */
    const find = (key: string): { bot: RunningBot; chatId: number } | undefined => {
      for (const bot of running?.bots ?? []) {
        const chatId = chatIn(bot.account.instance, key);
        if (chatId !== undefined) return { bot, chatId };
      }
      return undefined;
    };

    pikit.on("agent.started", ({ conversation }) => {
      const found = find(conversation.key);
      found?.bot.delivery.typingStarted(found.chatId);
    });
    const answer = async (result: AgentResult): Promise<void> => {
      const found = find(result.conversation.key);
      const now = running;
      if (found === undefined || now === undefined) return;
      const { bot, chatId } = found;
      bot.delivery.typingStopped(chatId);
      let text: string | undefined;
      if (result.kind === "failed") text = `Sorry, something went wrong while answering (${result.error?.code ?? "error"}). Try again in a moment.`;
      else if (result.kind === "completed" && (result.text ?? "").trim() !== "") text = result.text ?? "";
      if (text === undefined) return;
      if (now.queue === undefined) {
        void bot.delivery.send(chatId, text);
        return;
      }
      // One key per run (the request that started it): a run resumed after a crash is not answered twice.
      await now.queue
        .enqueue({
          idempotencyKey: `${result.conversation.sessionId}:${result.requestId}`,
          channel: bot.account.instance,
          conversationKey: result.conversation.key,
          text,
        })
        .catch((error: unknown) => now.background.logger.error("channel-telegram: an answer could not be stored for delivery", { chat: chatId, error: String(error) }));
    };
    pikit.on("agent.settled", answer);
    pikit.on("agent.failed", answer);

    return {
      async start(ctx) {
        // Updates and replies outlive start: they get the app's context, not start's (SPEC §4.7).
        const background: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
        const queue = outbound.get();
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
        running = { bots, queue, background };
      },

      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping !== undefined) await stopBots(stopping.bots, stopping.queue, ctx.abortSignal);
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
