/**
 * How channel-web gets its accounts (`accounts/types.ts`), apart from the channel: made here, used by
 * the routes. A test hands its own (`createChannelWeb({ accounts })`): a double, never better-auth.
 *
 * - `local`: better-auth over this App's `storage.sql` (`accounts/local.ts`). A server's, and on
 *   Cloudflare the accounts actor's (`channel-web:accounts`), made at its first call.
 * - `remote`: the Worker's. Every method is a call to the accounts actor (`AUTH_CALL`), but `user`,
 *   which first checks better-auth's signed cookie cache in the Worker (`accounts/session.ts`) and
 *   calls only when it is missing, expired or not the session's. better-auth's own routes cross as
 *   JSON (`accounts/forward.ts`), every `set-cookie` kept.
 * - `answer`: the accounts actor answers those calls with its local accounts, each message checked on
 *   arrival. A refusal (`not_found`, `exists`, `invalid_request`) is an `ActorCallError` and crosses whole.
 *   Every object registers them (one class), but only `channel-web:accounts` answers: any other key is
 *   refused (`no_handler`, `accountsOnly`) before the accounts are made or read.
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `channel-web.auth.handle` | `ForwardedRequest` (under `/chat/api/auth/`) | `ForwardedResponse` |
 * | `channel-web.auth.user` | `{ url, cookie }` | `AccountSession` (the user, the renewed cookies) or `null` |
 * | `channel-web.auth.methods` | `{ userId }` | `string[]` |
 * | `channel-web.auth.list` | `{ limit, cursor? }` | `AccountsPage` |
 * | `channel-web.auth.invite` | `{ email, name?, origin }` | `AccountLink & { userId }` |
 * | `channel-web.auth.reset` | `{ userId, origin }` | `AccountLink` |
 * | `channel-web.auth.ban` | `{ userId, banned }` | `{}` |
 * | `channel-web.auth.remove` | `{ userId }` | `{}` |
 */

import type { AppContext, Logger } from "@pikit/core";
import { ActorCallError, type ActorInbox, type ActorMailbox, CLIENT_ADDRESS_HEADER, type EmailSender, type JsonValue, type SqlDatabase } from "@pikit/contracts";
import { checkForwardedRequest, checkForwardedResponse, forwardRequest, forwardResponse, requestOf, responseOf, TooLarge } from "./accounts/forward.ts";
import { createLocalAccounts } from "./accounts/local.ts";
import { cachedUser } from "./accounts/session.ts";
import type { AccountLink, AccountSession, AccountsPage, Accounts } from "./accounts/types.ts";
import { ACCOUNTS_KEY, accountsOnly } from "./calls.ts";
import type { AccountSecrets, ChannelWebConfig, SignUpSettings } from "./config.ts";

/** What the local accounts are made with. */
export type LocalAccountsDeps = {
  sql: () => SqlDatabase;
  config: ChannelWebConfig;
  secrets: AccountSecrets;
  /** Who may sign up now (the live setting, else the config's): read at each sign-up. */
  signUp: (ctx: AppContext) => Promise<SignUpSettings>;
  /** `email.send`, when installed. */
  email: EmailSender | undefined;
  logger: Logger;
  /** Without `PIKIT_PUBLIC_URL`, whether any request's host is trusted for links (Cloudflare), not only a loopback one (a server). */
  trustRequestHost: boolean;
};

/** What the Worker's accounts are made with. */
export type RemoteAccountsDeps = {
  mailbox: () => ActorMailbox;
  config: ChannelWebConfig;
  /** `CHANNEL_WEB_AUTH_SECRET`: the cookie cache's signature is checked with it. */
  secret: string;
  /** `PIKIT_PUBLIC_URL`, when set: its scheme says which cookies (`__Secure-` on https). */
  publicUrl?: string;
};

export interface AccountsWiring {
  local(deps: LocalAccountsDeps): Accounts;
  remote(deps: RemoteAccountsDeps): Accounts;
  answer(inbox: ActorInbox, accounts: (ctx: AppContext) => Promise<Accounts>): void;
}


export const AUTH_CALL = {
  handle: "channel-web.auth.handle",
  user: "channel-web.auth.user",
  methods: "channel-web.auth.methods",
  list: "channel-web.auth.list",
  invite: "channel-web.auth.invite",
  reset: "channel-web.auth.reset",
  ban: "channel-web.auth.ban",
  remove: "channel-web.auth.remove",
} as const;

type Fields = Record<string, unknown>;
const fieldsOf = (message: JsonValue): Fields => (typeof message === "object" && message !== null && !Array.isArray(message) ? (message as Fields) : {});
const invalid = (what: string): ActorCallError => new ActorCallError("invalid_request", `channel-web: ${what}`);
const text = (fields: Fields, field: string, max = 1000): string => {
  const value = fields[field];
  if (typeof value !== "string" || value === "" || value.length > max) throw invalid(`"${field}" is a string of 1 to ${max} characters`);
  return value;
};
const origin = (fields: Fields): string => {
  const value = text(fields, "origin");
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) throw invalid('"origin" is an http(s) origin');
  return new URL(value).origin;
};
const json = (value: unknown): JsonValue => value as JsonValue;

/** The accounts actor's answer to `channel-web.auth.user`, checked on arrival at the Worker. */
function sessionOf(value: unknown): AccountSession | undefined {
  if (value === null) return undefined;
  const { user, cookies } = fieldsOf(value as JsonValue);
  const fields = fieldsOf((user ?? null) as JsonValue);
  const valid =
    typeof fields.id === "string" &&
    typeof fields.name === "string" &&
    typeof fields.email === "string" &&
    typeof fields.emailVerified === "boolean" &&
    (fields.image === undefined || typeof fields.image === "string") &&
    Array.isArray(cookies) &&
    cookies.length <= 20 &&
    cookies.every((cookie) => typeof cookie === "string");
  if (!valid) throw new ActorCallError("failed", "channel-web: the accounts actor answered something that is not a session");
  return value as AccountSession;
}

/** The accounts better-auth makes. */
export const BETTER_AUTH: AccountsWiring = {
  local: ({ sql, config, secrets, signUp, email, logger, trustRequestHost }) =>
    createLocalAccounts({
      sql,
      secret: secrets.secret,
      ...(secrets.publicUrl !== undefined && { publicUrl: secrets.publicUrl }),
      trustRequestHost,
      // A proxy's header only when the operator says every request comes through it; then the server's.
      ipHeaders: [...config.trustedProxyHeaders, CLIENT_ADDRESS_HEADER],
      name: config.name,
      password: config.signIn.password,
      magicLink: config.signIn.magicLink,
      social: secrets.social,
      oidc: secrets.oidc,
      signUp,
      ...(email !== undefined && {
        email: async (message, ctx) => {
          await email.send(message, ctx);
        },
      }),
      sessionCacheSeconds: config.sessionCacheSeconds,
      inviteTtlHours: config.inviteTtlHours,
      logger,
    }),

  remote({ mailbox, secret, publicUrl }) {
    const call = async <T>(type: string, message: JsonValue, ctx: AppContext): Promise<T> => (await mailbox().call(ACCOUNTS_KEY, type, message, ctx)) as T;
    return {
      async handle(request, ctx) {
        let forwarded;
        try {
          forwarded = await forwardRequest(request);
        } catch (error) {
          if (error instanceof TooLarge) return Response.json({ error: "too_large" }, { status: 413, headers: { "cache-control": "no-store" } });
          throw error;
        }
        const answer = checkForwardedResponse(await call<JsonValue>(AUTH_CALL.handle, json(forwarded), ctx));
        if (answer === undefined) throw new ActorCallError("failed", "channel-web: the accounts actor answered something that is not a response");
        return responseOf(answer);
      },
      async user(request, ctx) {
        const cookie = request.headers.get("cookie");
        if (cookie === null) return undefined;
        // The signed cookie cache first: no call while it vouches for the session. Past it, the actor's
        // answer carries the renewed cache, which the route sends back: the next requests cost no call.
        const cached = await cachedUser(request, secret, publicUrl);
        if (cached !== undefined) return { user: cached, cookies: [] };
        return sessionOf(await call<JsonValue>(AUTH_CALL.user, { url: request.url, cookie }, ctx));
      },
      methods: (userId, ctx) => call<string[]>(AUTH_CALL.methods, { userId }, ctx),
      list: (page, ctx) => call<AccountsPage>(AUTH_CALL.list, json(page), ctx),
      invite: (person, at, ctx) => call<AccountLink & { userId: string }>(AUTH_CALL.invite, { ...person, origin: at }, ctx),
      resetLink: (userId, at, ctx) => call<AccountLink>(AUTH_CALL.reset, { userId, origin: at }, ctx),
      async ban(userId, banned, ctx) {
        await call<JsonValue>(AUTH_CALL.ban, { userId, banned }, ctx);
      },
      async remove(userId, ctx) {
        await call<JsonValue>(AUTH_CALL.remove, { userId }, ctx);
      },
    };
  },

  answer(calls, accountsOf) {
    const inbox = accountsOnly(calls);
    inbox.answer(AUTH_CALL.handle, async (_key, message, ctx) => {
      const forwarded = checkForwardedRequest(message);
      if (forwarded === undefined) throw invalid("not a request to /chat/api/auth/");
      const response = await (await accountsOf(ctx)).handle(requestOf(forwarded), ctx);
      return json(await forwardResponse(response));
    });
    inbox.answer(AUTH_CALL.user, async (_key, message, ctx) => {
      const fields = fieldsOf(message);
      const url = text(fields, "url", 8192);
      if (!URL.canParse(url)) throw invalid('"url" is a URL');
      const request = new Request(url, { headers: { cookie: text(fields, "cookie", 16 * 1024) } });
      return json((await (await accountsOf(ctx)).user(request, ctx)) ?? null);
    });
    inbox.answer(AUTH_CALL.methods, async (_key, message, ctx) => json(await (await accountsOf(ctx)).methods(text(fieldsOf(message), "userId", 200), ctx)));
    inbox.answer(AUTH_CALL.list, async (_key, message, ctx) => {
      const { limit, cursor } = fieldsOf(message);
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('"limit" is an integer from 1 to 100');
      if (cursor !== undefined && typeof cursor !== "string") throw invalid('"cursor" is a string');
      return json(await (await accountsOf(ctx)).list({ limit, ...(cursor !== undefined && { cursor }) }, ctx));
    });
    inbox.answer(AUTH_CALL.invite, async (_key, message, ctx) => {
      const fields = fieldsOf(message);
      if (fields.name !== undefined && typeof fields.name !== "string") throw invalid('"name" is a string');
      const person = { email: text(fields, "email", 254), ...(typeof fields.name === "string" && { name: fields.name }) };
      return json(await (await accountsOf(ctx)).invite(person, origin(fields), ctx));
    });
    inbox.answer(AUTH_CALL.reset, async (_key, message, ctx) => {
      const fields = fieldsOf(message);
      return json(await (await accountsOf(ctx)).resetLink(text(fields, "userId", 200), origin(fields), ctx));
    });
    inbox.answer(AUTH_CALL.ban, async (_key, message, ctx) => {
      const fields = fieldsOf(message);
      if (typeof fields.banned !== "boolean") throw invalid('"banned" is a boolean');
      await (await accountsOf(ctx)).ban(text(fields, "userId", 200), fields.banned, ctx);
      return {};
    });
    inbox.answer(AUTH_CALL.remove, async (_key, message, ctx) => {
      await (await accountsOf(ctx)).remove(text(fieldsOf(message), "userId", 200), ctx);
      return {};
    });
  },
};
