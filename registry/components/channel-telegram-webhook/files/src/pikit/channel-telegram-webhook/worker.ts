/**
 * The Worker's half of channel-telegram-webhook (SPEC §4.1, C1, C6): where Telegram posts each update.
 * It checks and routes; the conversation's actor (the object's half, `index.ts`) does the rest.
 *
 *   POST /telegram           the default bot
 *   POST /telegram/<name>    each bot of `accounts`
 *
 * For each request:
 * 1. **The secret.** Telegram sends the webhook's secret (`TELEGRAM_[<NAME>_]WEBHOOK_SECRET`, given to
 *    `setWebhook` after a deploy) in `X-Telegram-Bot-Api-Secret-Token`; anything else is `401`
 *    (`secret.ts`: compared in constant time).
 * 2. **What this channel handles**: a message with text from a person in a private chat. Anything
 *    else (a group, a bot, an edit) is acknowledged with `200` and dropped, as channel-telegram does.
 * 3. **Who may talk**: the ids in `TELEGRAM_[<NAME>_]ALLOWED_USERS`. A stranger is told their id, so
 *    the owner can add it, and nothing reaches the agent. A message with no text gets a hint.
 * 4. **The actor**: `actor.mailbox.send("<instance>:<chat>", "telegram.update", update)`. It resolves
 *    once the conversation holds the message durably, and the Worker answers `200`; if it rejects, `500`,
 *    and Telegram delivers the update again (the object recognises it: answered once).
 *
 * It answers as soon as the message is durable, never after the run: Telegram does not publish how
 * long it waits for a webhook, and the run takes as long as the agent does.
 *
 * On Cloudflare this component goes in the Worker's App (`export const worker` of pikit.config.ts),
 * with `secrets` and `actor.mailbox`; `component.json` names it in `apps.worker`. On a server both
 * halves can share one App (`mailbox-local` delivers to the object's half in the same process).
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { JsonValue } from "@pikit/contracts";
import Type from "typebox";
import { type Account, ACCOUNT_NAME, accountsOf, conversationKeyOf } from "./account.ts";
import { createTelegramApi, parseAllowedUsers, type TelegramApi } from "./api.ts";
import { TELEGRAM_TIMEOUT_MS, within } from "./bot.ts";
import { type Digest, digest, matches, SECRET_HEADER, secretProblem } from "./secret.ts";
import { isPrivateMessage, readUpdate, textOf, UPDATE_TYPE } from "./update.ts";

export const WORKER_NAME = "channel-telegram-webhook-worker";

const WorkerConfig = Type.Object({
  /** The Bot API server, for the replies to strangers. A value, for a local Bot API server or a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://api.telegram.org" }),
  /** More bots, by name, besides the default one; the same list as the object half's `accounts`. */
  accounts: Type.Array(Type.String({ pattern: ACCOUNT_NAME }), { default: [], uniqueItems: true }),
});

/** Strangers told their id, per bot, remembered while the Worker's isolate lives; at most this many. */
const STRANGERS_REMEMBERED = 1_000;

/** One bot's webhook, ready. */
interface Endpoint {
  account: Account;
  secret: Digest;
  allowed: ReadonlySet<number>;
  api: TelegramApi;
  told: Set<number>;
}

const ok = (): Response => new Response(null, { status: 200 });
const status = (code: number, text: string): Response => new Response(text, { status: code });

export const worker = defineComponent({
  name: WORKER_NAME,
  config: WorkerConfig,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const mailbox = pikit.use("actor.mailbox");
    const accounts = accountsOf(config.accounts);
    let endpoints: Map<string, Endpoint> | undefined;

    /** Tells a chat something, once, best effort: the update is acknowledged whatever happens. */
    const tell = async (endpoint: Endpoint, chatId: number, text: string, ctx: AppContext): Promise<void> => {
      await endpoint.api.sendMessage(chatId, text, {}, within(TELEGRAM_TIMEOUT_MS, ctx.abortSignal)).catch((error: unknown) =>
        ctx.logger.warn("channel-telegram-webhook: a reply could not be sent", { chat: chatId, error: String(error) }),
      );
    };

    const receive = async (account: Account, request: Request, ctx: AppContext): Promise<Response> => {
      const endpoint = endpoints?.get(account.instance);
      if (endpoint === undefined) return status(503, "not running");
      if (!(await matches(request.headers.get(SECRET_HEADER), endpoint.secret))) return status(401, "unauthorized");
      const update = readUpdate(await request.json().catch(() => undefined));
      if (update === undefined) return status(400, "not a Telegram update");
      if (!isPrivateMessage(update)) return ok();
      const { message } = update;
      const chatId = message.chat.id;

      if (!endpoint.allowed.has(message.from.id)) {
        ctx.logger.warn("channel-telegram-webhook: a message from a user who is not allowed", { instance: account.instance, user: message.from.id });
        if (!endpoint.told.has(message.from.id)) {
          if (endpoint.told.size >= STRANGERS_REMEMBERED) endpoint.told.clear();
          endpoint.told.add(message.from.id);
          await tell(
            endpoint,
            chatId,
            `This bot is private. Your Telegram user id is ${message.from.id}: its owner can let you in by adding it to ${account.allowedSecret}.`,
            ctx,
          );
        }
        return ok();
      }
      if (textOf(message) === undefined) {
        await tell(endpoint, chatId, "I can only read text messages for now.", ctx);
        return ok();
      }

      try {
        await mailbox.get().send(conversationKeyOf(account.instance, chatId), UPDATE_TYPE, update as unknown as JsonValue, ctx);
      } catch (error) {
        // Not acknowledged: Telegram delivers it again, and the conversation recognises it.
        ctx.logger.error("channel-telegram-webhook: the conversation could not take an update; Telegram will deliver it again", {
          instance: account.instance,
          update: update.update_id,
          error: error instanceof Error ? error.message : String(error),
        });
        return status(500, "not taken");
      }
      return ok();
    };

    for (const account of accounts) pikit.provideKeyed("http.route", `POST ${account.path}`, (request, ctx) => receive(account, request, ctx));

    return {
      async start() {
        const ready = new Map<string, Endpoint>();
        for (const account of accounts) ready.set(account.instance, await endpointOf(account));
        endpoints = ready;
      },
      stop() {
        endpoints = undefined;
      },
    };

    /** One bot's webhook from its secrets; a missing or unusable one fails the start (P5). */
    async function endpointOf(account: Account): Promise<Endpoint> {
      const store = secrets.get();
      const token = await store.get(account.tokenSecret);
      if (token === undefined) throw new Error(`channel-telegram-webhook: ${account.tokenSecret} is not set. Create a bot with @BotFather, then run \`pikit configure\``);
      const allowed = parseAllowedUsers(await store.get(account.allowedSecret));
      if (allowed instanceof Error) throw new Error(`channel-telegram-webhook: ${allowed.message.replace("TELEGRAM_ALLOWED_USERS", account.allowedSecret)}`);
      if (allowed.size === 0) throw new Error(`channel-telegram-webhook: ${account.allowedSecret} is empty, so nobody could talk to the bot. Run \`pikit configure\`: it allows you`);
      const secret = await store.get(account.webhookSecret);
      if (secret === undefined) throw new Error(`channel-telegram-webhook: ${account.webhookSecret} is not set. Run \`pikit configure\`: it generates one`);
      const problem = secretProblem(secret);
      if (problem !== undefined) throw new Error(`channel-telegram-webhook: ${account.webhookSecret} is not usable: ${problem}. Run \`pikit configure\` to generate one`);
      return { account, secret: await digest(secret), allowed, api: createTelegramApi(token, config.apiBase), told: new Set() };
    }
  },
});
