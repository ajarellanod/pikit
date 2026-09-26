/**
 * A fake Telegram Bot API for channel-telegram's tests: the methods the channel calls, with
 * Telegram's long polling and offset rules, served on a free local port. Tests make users "say"
 * things and read what the bot sent, without a real bot, token or network.
 */

import type { TelegramUpdate, TelegramUser } from "./api.ts";

export interface SentMessage {
  chatId: number;
  text: string;
  html: boolean;
}

export interface FakeTelegram {
  /** The `apiBase` to configure. */
  url: string;
  token: string;
  bot: TelegramUser;
  /** A user sends `text` in their private chat with the bot (chat id = user id). Returns the update id. */
  say(user: Partial<TelegramUser> & { id: number }, text: string | undefined, options?: { chat?: "private" | "group"; caption?: string }): number;
  sent: SentMessage[];
  actions: { chatId: number; action: string }[];
  /** Offsets asked for, in order: the last one is what Telegram considers confirmed. */
  offsets: (number | undefined)[];
  /** Resolves once `count` messages were sent. */
  sentCount(count: number, timeoutMs?: number): Promise<SentMessage[]>;
  /** What the next calls answer instead of succeeding. */
  webhookUrl: string;
  rejectHtml: boolean;
  rateLimitNextSend?: number;
  /** The next `sendMessage` fails with this Telegram error (403 blocked, 500…). */
  failNextSend?: { code: number; description: string };
  /** Updates Telegram still holds (not confirmed by an offset). */
  pending(): TelegramUpdate[];
  /**
   * Delivers every update again, as Telegram does when a bot crashed before confirming them (a
   * restart asks without the offset it had reached).
   */
  redeliver(): void;
  /**
   * Another bot on the same server (the same `apiBase`, as every account of the channel uses): its
   * own token, updates and sent messages. `stop()` on any bot stops the server.
   */
  addBot(token: string, bot: TelegramUser): FakeTelegram;
  stop(): Promise<void>;
}

type Handler = (method: string, request: Request) => Promise<Response>;

export function startFakeTelegram(): FakeTelegram {
  const handlers = new Map<string, Handler>();
  const endPolls: (() => void)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(request.url).pathname);
      if (match === null) return fail(404, "Not Found");
      const [, given = "", method = ""] = match;
      // As the real Bot API: a path that is not a token's shape is not found; a wrong token is refused.
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(given)) return fail(404, "Not Found");
      const handle = handlers.get(given);
      if (handle === undefined) return fail(401, "Unauthorized");
      return await handle(method, request);
    },
  });
  const shared: Shared = {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      for (const end of endPolls) end();
      await server.stop(true);
    },
    add(token, bot) {
      const { fake, handle, endPoll } = fakeBot(token, bot, shared);
      handlers.set(token, handle);
      endPolls.push(endPoll);
      return fake;
    },
  };
  return shared.add("123456789:fake-token-for-tests", { id: 4242, is_bot: true, first_name: "Test Bot", username: "pikit_test_bot" });
}

interface Shared {
  url: string;
  stop(): Promise<void>;
  add(token: string, bot: TelegramUser): FakeTelegram;
}

const ok = (result: unknown) => Response.json({ ok: true, result });
const fail = (code: number, description: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, error_code: code, description, ...extra }, { status: code });

/** One bot's state, and the handler of its requests. */
function fakeBot(token: string, bot: TelegramUser, shared: Shared): { fake: FakeTelegram; handle: Handler; endPoll(): void } {
  const updates: TelegramUpdate[] = [];
  const history: TelegramUpdate[] = [];
  let nextUpdate = 1;
  let nextMessage = 1;
  let wake: (() => void) | undefined;
  /** The long poll in progress; a new `getUpdates` ends it with 409, as Telegram does. */
  let polling: ((conflict: Response) => void) | undefined;
  const sentWaiters = new Set<() => void>();

  const fake: FakeTelegram = {
    url: shared.url,
    token,
    bot,
    sent: [],
    actions: [],
    offsets: [],
    webhookUrl: "",
    rejectHtml: false,
    say(user, text, options = {}) {
      const from: TelegramUser = { is_bot: false, first_name: "Someone", ...user };
      const chat = options.chat === "group" ? { id: -1000 - user.id, type: "group" as const, title: "A group" } : { id: user.id, type: "private" as const };
      const update: TelegramUpdate = {
        update_id: nextUpdate++,
        message: {
          message_id: nextMessage++,
          from,
          chat,
          date: Math.floor(Date.now() / 1000),
          ...(text !== undefined && { text }),
          ...(options.caption !== undefined && { caption: options.caption }),
        },
      };
      updates.push(update);
      history.push(update);
      wake?.();
      return update.update_id;
    },
    async sentCount(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (fake.sent.length < count) {
        if (Date.now() > deadline) throw new Error(`fake telegram: ${fake.sent.length} message(s) sent, expected ${count}: ${JSON.stringify(fake.sent)}`);
        await new Promise<void>((resolve) => {
          sentWaiters.add(resolve);
          setTimeout(resolve, 20);
        });
      }
      return fake.sent.slice(0, count);
    },
    pending: () => [...updates],
    redeliver() {
      // The same updates, with new ids: the channel must recognise the messages, not the deliveries.
      for (const update of history) updates.push({ ...update, update_id: nextUpdate++ });
      wake?.();
    },
    addBot: (otherToken, otherBot) => shared.add(otherToken, otherBot),
    stop: () => shared.stop(),
  };

  const handle: Handler = async (method, request) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    switch (method) {
      case "getMe":
        return ok(bot);
      case "getWebhookInfo":
        return ok({ url: fake.webhookUrl, pending_update_count: updates.length });
      case "sendChatAction":
        fake.actions.push({ chatId: Number(body.chat_id), action: String(body.action) });
        return ok(true);
      case "sendMessage": {
        if (fake.failNextSend !== undefined) {
          const { code, description } = fake.failNextSend;
          delete fake.failNextSend;
          return fail(code, description);
        }
        if (fake.rateLimitNextSend !== undefined) {
          const retryAfter = fake.rateLimitNextSend;
          delete fake.rateLimitNextSend;
          return fail(429, "Too Many Requests: retry later", { parameters: { retry_after: retryAfter } });
        }
        const html = body.parse_mode === "HTML";
        if (html && fake.rejectHtml) return fail(400, "Bad Request: can't parse entities");
        fake.sent.push({ chatId: Number(body.chat_id), text: String(body.text), html });
        for (const resolve of sentWaiters) resolve();
        sentWaiters.clear();
        return ok({ message_id: nextMessage++ });
      }
      case "getUpdates": {
        if (fake.webhookUrl !== "") return fail(409, "Conflict: can't use getUpdates method while webhook is active");
        polling?.(fail(409, "Conflict: terminated by other getUpdates request"));
        const offset = typeof body.offset === "number" ? body.offset : undefined;
        fake.offsets.push(offset);
        // An offset confirms every update before it: Telegram forgets them.
        if (offset !== undefined) while (updates[0] !== undefined && updates[0].update_id < offset) updates.shift();
        const ready = () => updates.filter((u) => offset === undefined || u.update_id >= offset);
        const timeout = Math.min(Number(body.timeout ?? 0), 2);
        if (ready().length > 0 || timeout === 0) return ok(ready());
        return new Promise<Response>((resolve) => {
          const finish = (response: Response) => {
            clearTimeout(timer);
            wake = undefined;
            polling = undefined;
            resolve(response);
          };
          const timer = setTimeout(() => finish(ok(ready())), timeout * 1000);
          wake = () => finish(ok(ready()));
          polling = finish;
          request.signal.addEventListener("abort", () => finish(ok([])), { once: true });
        });
      }
      default:
        return fail(404, `Not Found: method ${method}`);
    }
  };
  return { fake, handle, endPoll: () => polling?.(fail(409, "Conflict: server stopped")) };
}
