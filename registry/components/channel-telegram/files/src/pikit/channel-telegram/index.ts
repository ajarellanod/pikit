/**
 * channel-telegram: talk to your agent in Telegram (SPEC §5).
 *
 * The bot receives messages by long polling (no public URL needed), lets through only the Telegram
 * users in `TELEGRAM_ALLOWED_USERS`, hands each message to its conversation (`telegram:<chat id>`)
 * and sends the agent's answer back, with "typing…" while it works. `pikit configure` sets it up:
 * it checks the bot's token and allows you by asking you to send the bot a message.
 *
 * - Ingress (`poller.ts`, `inbound.ts`): a message is acknowledged to Telegram only once its
 *   conversation durably accepted it; a redelivery is a duplicate request, answered once.
 * - Replies: the channel listens to `agent.settled` / `agent.failed` and answers the chat once per
 *   run, whichever messages the run took. With an `outbound.queue` installed (`outbound-durable`),
 *   the answer is enqueued, stored before it is sent, and delivered through this channel's transport
 *   (`transport.ts`), which the channel attaches while it runs: it survives crashes and outages.
 *   Without one, it is sent directly (`replies.ts`), retried in the process: best effort.
 *
 * It refuses to start without a valid token, without at least one allowed user, or when the bot has
 * a webhook (Telegram delivers to the webhook or by polling, never both).
 *
 * Target: `server`: long polling needs a process that keeps running.
 */

import { type AgentResult, type AppContext, BACKGROUND_CONTEXT, defineComponent, type OutboundQueue } from "@pikit/core";
import Type from "typebox";
import { botLink, createTelegramApi, parseAllowedUsers, TelegramError } from "./api.ts";
import { CHANNEL, chatOf, handleUpdate, type InboundDeps } from "./inbound.ts";
import { type Poller, startPolling } from "./poller.ts";
import { createDelivery, type Delivery } from "./replies.ts";
import { createTelegramTransport } from "./transport.ts";

export const TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";
export const ALLOWED_SECRET = "TELEGRAM_ALLOWED_USERS";

const Config = Type.Object({
  /** The Bot API server. A value, for a local Bot API server or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.telegram.org" }),
  /** How long one `getUpdates` waits for messages. Longer means fewer requests, not slower answers. */
  pollTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 50, default: 30 }),
});

export default defineComponent({
  name: "channel-telegram",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    // Optional: with it, answers are stored before they are sent (SPEC §5, "Outbound delivery").
    const outbound = pikit.useOptional("outbound.queue");

    let running: { delivery: Delivery; poller: Poller; queue: OutboundQueue | undefined; background: AppContext } | undefined;

    pikit.on("agent.started", ({ conversation }) => {
      const chatId = chatOf(conversation.key);
      if (chatId !== undefined) running?.delivery.typingStarted(chatId);
    });
    const answer = async (result: AgentResult): Promise<void> => {
      const chatId = chatOf(result.conversation.key);
      const now = running;
      if (chatId === undefined || now === undefined) return;
      now.delivery.typingStopped(chatId);
      let text: string | undefined;
      if (result.kind === "failed") text = `Sorry, something went wrong while answering (${result.error?.code ?? "error"}). Try again in a moment.`;
      else if (result.kind === "completed" && (result.text ?? "").trim() !== "") text = result.text ?? "";
      if (text === undefined) return;
      if (now.queue === undefined) {
        void now.delivery.send(chatId, text);
        return;
      }
      // One key per run (the request that started it): a run resumed after a crash is not answered twice.
      await now.queue
        .enqueue({ idempotencyKey: `${result.conversation.sessionId}:${result.requestId}`, channel: CHANNEL, conversationKey: result.conversation.key, text })
        .catch((error: unknown) => now.background.logger.error("channel-telegram: an answer could not be stored for delivery", { chat: chatId, error: String(error) }));
    };
    pikit.on("agent.settled", answer);
    pikit.on("agent.failed", answer);

    return {
      async start(ctx) {
        const token = await secrets.get().get(TOKEN_SECRET);
        if (token === undefined) {
          throw new Error(`channel-telegram: ${TOKEN_SECRET} is not set. Create a bot with @BotFather, then run \`pikit configure\``);
        }
        const allowed = parseAllowedUsers(await secrets.get().get(ALLOWED_SECRET));
        if (allowed instanceof Error) throw new Error(`channel-telegram: ${allowed.message}`);
        if (allowed.size === 0) {
          throw new Error(`channel-telegram: ${ALLOWED_SECRET} is empty, so nobody could talk to the bot. Run \`pikit configure\`: it allows you`);
        }

        const api = createTelegramApi(token, config.apiBase);
        const bot = await api.getMe(ctx.abortSignal).catch((error: unknown) => {
          if (error instanceof TelegramError && error.code === 401) throw new Error(`channel-telegram: ${TOKEN_SECRET} is not valid (Telegram answered 401)`);
          throw error;
        });
        const webhook = await api.getWebhookInfo(ctx.abortSignal);
        if (webhook.url !== "") {
          throw new Error(
            "channel-telegram: this bot has a webhook, so Telegram does not deliver its messages by polling. " +
              "If nothing else uses it, remove it: `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook`",
          );
        }

        // Updates and replies outlive start: they get the app's context, not start's (SPEC §4.7).
        const background: AppContext = ctx.derive(() => BACKGROUND_CONTEXT);
        const transport = createTelegramTransport(api);
        const delivery = createDelivery(api, transport, background.logger);
        const queue = outbound.get();
        queue?.attach(CHANNEL, transport);
        const deps: InboundDeps = {
          bot,
          allowed,
          delivery,
          conversations: conversations.get(),
          runtime: runtime.get(),
          ctx: background,
          refused: new Set(),
        };
        const poller = startPolling({ api, timeoutSeconds: config.pollTimeoutSeconds, handle: (update) => handleUpdate(update, deps), logger: background.logger });
        running = { delivery, poller, queue, background };
        ctx.logger.info("channel-telegram: receiving messages", { bot: `@${bot.username ?? bot.first_name}`, link: botLink(bot), allowedUsers: allowed.size });
      },

      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping === undefined) return;
        await stopping.poller.stop(ctx.abortSignal);
        // Sends in flight end, or are aborted at the stop deadline and sent again next time.
        await stopping.queue?.detach(CHANNEL, ctx.abortSignal);
        await stopping.delivery.close();
      },
    };
  },
});
