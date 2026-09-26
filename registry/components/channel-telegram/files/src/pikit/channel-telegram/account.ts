/**
 * The bots this channel runs (SPEC §5, "Channels, accounts and keys"). Each Telegram bot is an
 * account, and each account a channel instance with its own token, allowed users, conversations and
 * transport:
 *
 * | Account | Instance | Token | Allowed users |
 * |---|---|---|---|
 * | the default one | `telegram` | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALLOWED_USERS` |
 * | `ops` (in `accounts`) | `telegram:ops` | `TELEGRAM_OPS_BOT_TOKEN` | `TELEGRAM_OPS_ALLOWED_USERS` |
 *
 * A conversation key is `<instance>:<chat id>`: `telegram:12345`, `telegram:ops:12345`. The default
 * account keeps the keys it always had. Only this channel reads its keys back.
 */

export const KIND = "telegram";

export interface Account {
  /** `undefined` for the default account. */
  name: string | undefined;
  /** The channel instance: `telegram` or `telegram:<name>`. */
  instance: string;
  tokenSecret: string;
  allowedSecret: string;
}

/** An account name: lowercase letters, digits and `-`, starting with a letter. */
export const ACCOUNT_NAME = "^[a-z][a-z0-9-]*$";

/** The default account, then one per name in `accounts`, in order. */
export function accountsOf(names: readonly string[]): Account[] {
  return [undefined, ...names].map((name) => {
    const infix = name === undefined ? "" : `${name.toUpperCase().replaceAll("-", "_")}_`;
    return {
      name,
      instance: name === undefined ? KIND : `${KIND}:${name}`,
      tokenSecret: `TELEGRAM_${infix}BOT_TOKEN`,
      allowedSecret: `TELEGRAM_${infix}ALLOWED_USERS`,
    };
  });
}

/** The conversation of a chat with `instance`'s bot. */
export const conversationKeyOf = (instance: string, chatId: number): string => `${instance}:${chatId}`;

/** The chat of a conversation `instance` made, or `undefined` for any other (another account's too). */
export function chatIn(instance: string, conversationKey: string): number | undefined {
  if (!conversationKey.startsWith(`${instance}:`)) return undefined;
  const rest = conversationKey.slice(instance.length + 1);
  return /^-?\d+$/.test(rest) ? Number(rest) : undefined;
}
