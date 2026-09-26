/**
 * channel-telegram's step of `pikit configure`: everything a person needs to do, asked in order,
 * checked on the spot. The CLI finds this file in an installed component and calls `configure(io)`;
 * it knows nothing about Telegram (SPEC §11).
 *
 * 1. The bot token. Without one, it explains @BotFather in three lines and asks for it; every token
 *    is checked with `getMe` at once, so a typo shows now and not at `pikit up`.
 * 2. Who may talk to the bot. Instead of asking for a Telegram user id (which nobody knows), it asks
 *    you to send the bot any message, reads it, shows who sent it and allows that person. The bot
 *    confirms in the chat. You can also type ids, or set `TELEGRAM_ALLOWED_USERS` yourself.
 *
 * Without a terminal it asks nothing: both variables come from the environment (or `.env`), and the
 * token is still checked. It never prints the token.
 */

import { type Account, accountsOf } from "./account.ts";
import { botLink, createTelegramApi, parseAllowedUsers, type TelegramApi, TelegramError, type TelegramUser } from "./api.ts";

/** What `pikit configure` gives a component's step. Structural, so this file imports nothing from the CLI. */
export interface ConfigureIO {
  /** A person answers at a terminal. False in scripts and CI: ask nothing. */
  interactive: boolean;
  /** This component's config in `pikit.config.ts`, as written there (defaults not applied). */
  config: Readonly<Record<string, unknown>>;
  /** A variable from `.env`, or exported in the environment. */
  get(name: string): string | undefined;
  /** Write a variable to `.env` (mode 0600) now; nothing happens when `.env` already has that value. */
  set(name: string, value: string): void;
  ask(question: string): Promise<string>;
  /** Asks without echoing the answer. */
  askSecret(question: string): Promise<string>;
  /** Yes or no, Enter giving `initialValue`. Optional: a CLI before it only has `ask`. */
  confirm?(message: string, initialValue: boolean): Promise<boolean>;
  say(line: string): void;
}

/** How long to wait for the first message to the bot. */
const WAIT_FOR_MESSAGE_SECONDS = 120;

/** Configures the channel, one bot after the other; returns what is still missing (empty when done). */
export async function configure(io: ConfigureIO): Promise<string[]> {
  const apiBase = typeof io.config.apiBase === "string" ? io.config.apiBase : "https://api.telegram.org";
  const names = Array.isArray(io.config.accounts) ? io.config.accounts.filter((name): name is string => typeof name === "string") : [];
  const missing: string[] = [];
  for (const account of accountsOf(names)) {
    if (account.name !== undefined) io.say(`\nTelegram bot "${account.name}" (${account.instance}): ${account.tokenSecret}, ${account.allowedSecret}`);
    missing.push(...(await configureBot(io, apiBase, account)));
  }
  return missing;
}

/** One bot: its token, then who may talk to it. */
async function configureBot(io: ConfigureIO, apiBase: string, account: Account): Promise<string[]> {
  const { tokenSecret, allowedSecret } = account;
  const bot = await token(io, apiBase, tokenSecret);
  if (bot === undefined) return [`${tokenSecret}: create a bot with @BotFather and give its token to \`pikit configure\` (or set ${tokenSecret})`];

  const given = io.get(allowedSecret);
  const current = parseAllowedUsers(given);
  if (current instanceof Error) io.say(`✗ ${current.message}`);
  else if (current.size > 0 && given !== undefined) {
    // Saved to .env even when it came from the environment: the app reads .env.
    io.set(allowedSecret, given);
    io.say(`  ${allowedSecret}: ${current.size} user(s) allowed`);
    return [];
  }
  if (!io.interactive) return [`${allowedSecret}: set the Telegram user ids allowed to talk to the bot, or run \`pikit configure\` in a terminal`];
  const allowed = await allow(io, bot.api, bot.me, allowedSecret);
  if (allowed === undefined) return [`${allowedSecret}: nobody is allowed to talk to the bot yet; run \`pikit configure\` again`];
  io.set(allowedSecret, allowed);
  io.say(`✓ ${allowedSecret} set: only they can talk to your agent (add more ids to that line in .env)`);
  return [];
}

/**
 * The bot token in what was pasted: BotFather's token is `<bot id>:<secret>`, and people paste it
 * with its message around it, quotes, or spaces. `undefined` when there is none.
 */
export function findToken(text: string): string | undefined {
  return /\d{3,}:[A-Za-z0-9_-]{10,}/.exec(text)?.[0];
}

/** A checked token, saved; or `undefined` when there is none. */
async function token(io: ConfigureIO, apiBase: string, tokenSecret: string): Promise<{ api: TelegramApi; me: TelegramUser } | undefined> {
  let value = io.get(tokenSecret);
  const saved = value !== undefined && value !== "";
  if (!saved && !io.interactive) return undefined;
  if (!saved) {
    io.say("\nTelegram: your agent needs a bot of its own.");
    io.say("  1. In Telegram, open https://t.me/BotFather and send /newbot");
    io.say("  2. Choose a name and a username ending in \"bot\"");
    io.say("  3. BotFather answers with a token like 123456789:AAE…; paste it here");
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    if (value === undefined || value === "") {
      const pasted = await io.askSecret(`${tokenSecret}: `);
      if (pasted.trim() === "") return undefined;
      value = findToken(pasted);
      if (value === undefined) {
        // Only the length is shown: what was pasted may be the token with something around it.
        io.say(`✗ That is not a bot token (${pasted.trim().length} characters, no 123456789:AAE… in them). Copy only the token from BotFather's message, then paste it again:`);
        continue;
      }
    } else {
      value = findToken(value) ?? value;
    }
    const api = createTelegramApi(value, apiBase);
    try {
      const me = await api.getMe();
      // Saved to .env even when it came from the environment: the app reads .env.
      io.set(tokenSecret, value);
      io.say(`✓ ${saved ? `${tokenSecret}: ` : ""}bot @${me.username ?? me.first_name} (${botLink(me)})`);
      return { api, me };
    } catch (error) {
      // 401: a token of the right shape that Telegram does not know. 404: not a token's shape at all.
      if (!(error instanceof TelegramError) || (error.code !== 401 && error.code !== 404)) throw error;
      io.say(`✗ Telegram does not know that token (${error.code}).${io.interactive ? " Paste it again:" : ""}`);
      if (!io.interactive) return undefined;
      value = undefined;
    }
  }
  return undefined;
}

/** The ids to allow, as `TELEGRAM_ALLOWED_USERS` holds them; `undefined` when nobody was allowed. */
async function allow(io: ConfigureIO, api: TelegramApi, bot: TelegramUser, allowedSecret: string): Promise<string | undefined> {
  io.say(`\nWho may talk to the bot? Open ${botLink(bot)} and send it any message now.`);
  io.say(`  (waiting up to ${WAIT_FOR_MESSAGE_SECONDS / 60} minutes; or press Ctrl-C and set ${allowedSecret} in .env yourself)`);
  const deadline = Date.now() + WAIT_FOR_MESSAGE_SECONDS * 1000;
  let offset: number | undefined;
  while (Date.now() < deadline) {
    let updates: Awaited<ReturnType<TelegramApi["getUpdates"]>>;
    try {
      updates = await api.getUpdates({ ...(offset !== undefined && { offset }), timeout: Math.min(25, Math.ceil((deadline - Date.now()) / 1000)) });
    } catch (error) {
      if (error instanceof TelegramError && error.code === 409) {
        io.say(
          error.message.includes("webhook")
            ? "✗ The bot has a webhook, so Telegram does not hand its messages to anyone else. If nothing uses it, remove it (https://api.telegram.org/bot<token>/deleteWebhook) and run `pikit configure` again."
            : "✗ The bot is already running somewhere (pikit up / pikit dev), and only one program can read its messages. Stop it, then run `pikit configure` again.",
        );
        return undefined;
      }
      throw error;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const from = update.message?.from;
      if (update.message?.chat.type !== "private" || from === undefined || from.is_bot) continue;
      const who = `${[from.first_name, from.last_name].filter(Boolean).join(" ")}${from.username ? ` (@${from.username})` : ""}, id ${from.id}`;
      const question = `Message from ${who}. Allow them to talk to your agent?`;
      const allowed = io.confirm ? await io.confirm(question, true) : /^(y|yes)?$/.test((await io.ask(`${question} [Y/n] `)).trim().toLowerCase());
      if (!allowed) continue;
      // Confirm the update, so the running bot does not answer this setup message later.
      await api.getUpdates({ offset, timeout: 0 }).catch(() => {});
      await api.sendMessage(update.message.chat.id, "✓ You can talk to this bot once it runs (pikit up).").catch(() => {});
      return String(from.id);
    }
  }
  io.say("✗ No message arrived.");
  return undefined;
}
