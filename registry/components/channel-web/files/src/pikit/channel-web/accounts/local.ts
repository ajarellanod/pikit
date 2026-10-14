/**
 * The accounts in this App: better-auth (`better-auth/minimal`, no Kysely) over `storage.sql`
 * (`adapter.ts`). A server's; on Cloudflare, the accounts actor's (`channel-web:accounts`).
 *
 * - **Routes** under `/chat/api/auth` (`AUTH_BASE_PATH`). Cookies `pikit_chat.*` (`__Secure-pikit_chat.*`
 *   on https), path `/chat/`, `HttpOnly`, `SameSite=Lax`, `Secure` on https. The signed cookie cache
 *   (`session_data`) holds a session `sessionCacheSeconds`: a ban or a removal takes effect within it.
 * - **Base URL**: `publicUrl` (`PIKIT_PUBLIC_URL`) when set; else each request's origin, which
 *   better-auth then derives per request (links in its emails, `trustedOrigins`). `Secure` is fixed
 *   when an instance is made, so there is one instance per scheme the requests come with (http, https).
 *   Without `publicUrl`, a link in an email is built from the request's `Host`: set it on a server
 *   behind a proxy that does not set `Host` itself.
 * - **Who may have an account** is decided in one place, `databaseHooks.user.create.before`, for
 *   every method (password, magic link, OAuth, OIDC): `invite` refuses every user but the operator's
 *   (`invite()` marks them with `invitedAt`, a field no request can set: `input: false`),
 *   `allowlist` also admits an email equal to an entry or ending with an `@domain` entry, when it is
 *   verified (a provider's or a magic link's, or a password sign-up that must verify before its first
 *   session), `open` admits anyone. The policy is read at each sign-up (`signUp`): it changes live.
 * - **Bans**: a banned user gets no new session (`session.create.before`), and banning deletes their
 *   sessions. Operators are not better-auth users: their actions use the database directly.
 * - **Invitations** make the user with `emailVerified: true` (the operator vouches for the address; a
 *   provider's verified email then links to it) and a password-reset token: the link sets a password
 *   (`links.ts`). A crash between the user and the token leaves a user to invite again.
 * - **Email** (when `email` is given): verification of a self-made account (required before its first
 *   session), "forgot password", the magic link, invitations and operator's resets. Plain, short, the
 *   link and the assistant's name. A failure is the route's error; nothing retries it.
 * - **Rate limits**: better-auth's, in memory, on (sign-in, sign-up 3 per 10 s; reset and verification
 *   3 per minute; magic link 5 per minute), per client address from `ipHeaders`.
 */

import type { ActorCallErrorCode, SqlDatabase } from "@pikit/contracts";
import { ActorCallError } from "@pikit/contracts";
import type { AppContext, Logger } from "@pikit/core";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import { ACCOUNT_TABLE, MODEL_NAMES, migrate, SESSION_TABLE, sqlAdapter, USER_TABLE } from "./adapter.ts";
import { MAX_AUTH_BODY } from "./forward.ts";
import { AUTH_BASE_PATH, CHAT_LINKS, setPasswordLink } from "./links.ts";
import type { AccountLink, AccountSummary, AccountsPage, AccountUser, Accounts } from "./types.ts";

/** The cookies' name prefix: `pikit_chat.session_token`, `pikit_chat.session_data`. */
export const COOKIE_PREFIX = "pikit_chat";
/** The cookies' path: the chat's, never `/admin/`. */
export const COOKIE_PATH = "/chat/";

export type SignUpPolicy = { mode: "invite" | "allowlist" | "open"; allow: string[] };

export type EmailMessage = { to: string; subject: string; text: string; html?: string };

export type LocalAccountsOptions = {
  /** `storage.sql`: the tables are made at first use. */
  sql: () => SqlDatabase;
  /** better-auth's secret (`CHANNEL_WEB_AUTH_SECRET`), at least 32 characters. */
  secret: string;
  /** `PIKIT_PUBLIC_URL` (an origin, `https://bot.example.com`): the base URL; else each request's origin. */
  publicUrl?: string;
  /** The assistant's name, in emails. */
  name: string;
  /** Email and password sign-in. */
  password: boolean;
  /** Links by email: needs `email`. */
  magicLink: boolean;
  /** better-auth's built-in providers, by id (`google`, `github`…). */
  social: { id: string; clientId: string; clientSecret: string }[];
  /** Other OAuth2/OIDC platforms, by discovery. */
  oidc: { id: string; name: string; discoveryUrl: string; scopes?: string[]; clientId: string; clientSecret: string }[];
  /** Who may have an account, read at each sign-up. */
  signUp: (ctx: AppContext) => Promise<SignUpPolicy>;
  /** Sends one email (`email.send`); without it, no verification, reset or magic link by email. */
  email?: (message: EmailMessage, ctx: AppContext) => Promise<void>;
  /** How long the signed cookie cache holds a session without a database read; 0 turns it off. Default 300. */
  sessionCacheSeconds?: number;
  /** How long an invitation link works. Default 72. */
  inviteTtlHours?: number;
  /** How long a password-reset link works. Default 3600. */
  resetTtlSeconds?: number;
  /** The headers holding the client's address, for rate limits. Default `cf-connecting-ip`, `x-forwarded-for`. */
  ipHeaders?: string[];
  /** Where better-auth's warnings and errors go. */
  logger?: Logger;
};

/** What better-auth calls the method of an account linked by password. */
const CREDENTIAL = "credential";
const SIGN_UP_REFUSED = { code: "SIGN_UP_NOT_ALLOWED", message: "Accounts here are by invitation: ask the operator." };
const BANNED = { code: "BANNED", message: "This account is suspended." };

const refusal = (code: ActorCallErrorCode, message: string): ActorCallError => new ActorCallError(code, message);

/** Whether `email` is an `allow` entry, or ends with an `@domain` entry (case-insensitive). */
export function allowed(allow: readonly string[], email: string): boolean {
  const address = email.trim().toLowerCase();
  return allow.some((entry) => {
    const rule = entry.trim().toLowerCase();
    return rule.startsWith("@") ? address.endsWith(rule) && address.length > rule.length : address === rule;
  });
}

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Instance = ReturnType<typeof build>;

/**
 * The request header naming the call `handle` is in, so that better-auth's callbacks (an email, the
 * sign-up hook) find its `AppContext`: they get the request, or a clone of it (`safeCloneRequest`),
 * never our context. `handle` always overwrites it.
 */
const CALL_HEADER = "x-pikit-chat-call";

function build(options: LocalAccountsOptions, secure: boolean, ready: () => Promise<SqlDatabase>, contexts: Map<string, AppContext>) {
  const { email } = options;
  const appContext = (request: Request | undefined): AppContext | undefined => {
    const call = request?.headers.get(CALL_HEADER);
    return call === null || call === undefined ? undefined : contexts.get(call);
  };
  const send = async (request: Request | undefined, message: EmailMessage): Promise<void> => {
    const ctx = appContext(request);
    if (email === undefined || ctx === undefined) throw new Error("channel-web: an email was asked for outside a request");
    await email(message, ctx);
  };
  const verificationRequired = options.password && email !== undefined;
  const cacheSeconds = options.sessionCacheSeconds ?? 300;
  const logger = options.logger;

  return betterAuth({
    appName: options.name,
    secret: options.secret,
    ...(options.publicUrl !== undefined && { baseURL: options.publicUrl }),
    basePath: AUTH_BASE_PATH,
    database: sqlAdapter({ database: ready }),
    telemetry: { enabled: false },
    logger:
      logger === undefined
        ? { level: "warn" }
        : { level: "warn", log: (level, message) => (level === "error" ? logger.error(`channel-web: ${message}`) : logger.warn(`channel-web: ${message}`)) },
    user: {
      ...MODEL_NAMES.user,
      additionalFields: {
        banned: { type: "boolean", required: false, defaultValue: false, input: false },
        invitedAt: { type: "date", required: false, input: false, returned: false },
      },
    },
    session: { ...MODEL_NAMES.session, cookieCache: { enabled: cacheSeconds > 0, maxAge: Math.max(cacheSeconds, 1) } },
    account: { ...MODEL_NAMES.account, accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false } },
    verification: MODEL_NAMES.verification,
    emailAndPassword: {
      enabled: options.password,
      requireEmailVerification: verificationRequired,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: options.resetTtlSeconds ?? 3600,
      ...(email !== undefined && {
        sendResetPassword: async ({ user, url, token }, request) =>
          send(request, resetMessage(options.name, user.email, setPasswordLink(new URL(url).origin, token, false))),
      }),
    },
    ...(email !== undefined && {
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }, request) => {
          const link = new URL(url);
          link.searchParams.set("callbackURL", CHAT_LINKS.home);
          await send(request, verificationMessage(options.name, user.email, link.toString()));
        },
      },
    }),
    socialProviders: Object.fromEntries(options.social.map((p) => [p.id, { clientId: p.clientId, clientSecret: p.clientSecret }])),
    plugins: [
      ...(options.magicLink && email !== undefined
        ? [magicLink({ expiresIn: 600, sendMagicLink: async ({ email: to, url }, ctx) => send(ctx?.request, magicLinkMessage(options.name, to, url)) })]
        : []),
      ...(options.oidc.length > 0
        ? [
            genericOAuth({
              config: options.oidc.map((p) => ({
                providerId: p.id,
                name: p.name,
                discoveryUrl: p.discoveryUrl,
                clientId: p.clientId,
                clientSecret: p.clientSecret,
                scopes: p.scopes ?? ["openid", "email", "profile"],
                pkce: true,
              })),
            }),
          ]
        : []),
    ],
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 100 },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: secure,
      defaultCookieAttributes: { path: COOKIE_PATH, sameSite: "lax", httpOnly: true, secure },
      ipAddress: { ipAddressHeaders: options.ipHeaders ?? ["cf-connecting-ip", "x-forwarded-for"] },
    },
    databaseHooks: {
      user: {
        create: {
          // The one place who may have an account is decided, for every method.
          before: async (user, endpoint) => {
            if ((user as { invitedAt?: unknown }).invitedAt instanceof Date) return;
            const ctx = appContext(endpoint?.request);
            if (ctx === undefined) throw new APIError("FORBIDDEN", SIGN_UP_REFUSED);
            const policy = await options.signUp(ctx);
            if (policy.mode === "open") return;
            if (policy.mode === "allowlist" && allowed(policy.allow, user.email)) {
              // A provider's or a magic link's verified email; or a password sign-up, which verifies first.
              if (user.emailVerified === true || (verificationRequired && endpoint?.path === "/sign-up/email")) return;
            }
            throw new APIError("FORBIDDEN", SIGN_UP_REFUSED);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const [row] = await (await ready()).query<{ banned: number | null }>(`SELECT "banned" FROM ${USER_TABLE} WHERE "id" = ?`, [session.userId]);
            if (row?.banned === 1) throw new APIError("FORBIDDEN", BANNED);
          },
        },
      },
    },
  });
}

const signature = (name: string): string => `\n\n${name}`;
const resetMessage = (name: string, to: string, link: string): EmailMessage => ({
  to,
  subject: `Set your password for ${name}`,
  text: `Open this link to set a new password:\n\n${link}\n\nIf you did not ask for it, ignore this email.${signature(name)}`,
});
const verificationMessage = (name: string, to: string, link: string): EmailMessage => ({
  to,
  subject: `Confirm your email for ${name}`,
  text: `Open this link to confirm your email and sign in:\n\n${link}\n\nIf you did not sign up, ignore this email.${signature(name)}`,
});
const magicLinkMessage = (name: string, to: string, link: string): EmailMessage => ({
  to,
  subject: `Sign in to ${name}`,
  text: `Open this link to sign in (it works once, for 10 minutes):\n\n${link}\n\nIf you did not ask for it, ignore this email.${signature(name)}`,
});
const invitationMessage = (name: string, to: string, link: string): EmailMessage => ({
  to,
  subject: `You are invited to ${name}`,
  text: `You are invited to chat with ${name}. Open this link to set your password:\n\n${link}${signature(name)}`,
});

type UserRow = { id: string; name: string; email: string; emailVerified: number; image: string | null; createdAt: string; banned: number | null };

/** A cursor of `list`: the last item's creation time and id. */
const CURSOR = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\|(.{1,200})$/;

export function createLocalAccounts(options: LocalAccountsOptions): Accounts {
  if (options.secret.length < 32) throw new Error("channel-web: the accounts' secret is at least 32 characters");
  if (options.magicLink && options.email === undefined) throw new Error("channel-web: signIn.magicLink needs email.send: install an email-* component");

  let migrated: Promise<void> | undefined;
  const ready = async (): Promise<SqlDatabase> => {
    const db = options.sql();
    migrated ??= migrate(db).catch((error: unknown) => {
      migrated = undefined;
      throw error;
    });
    await migrated;
    return db;
  };
  const contexts = new Map<string, AppContext>();
  const instances = new Map<boolean, Instance>();
  const instance = (secure: boolean): Instance => {
    let made = instances.get(secure);
    if (made === undefined) {
      made = build(options, secure, ready, contexts);
      instances.set(secure, made);
    }
    return made;
  };
  const secureFor = (url: string): boolean => new URL(options.publicUrl ?? url).protocol === "https:";
  /** For what needs no request: the operator's actions. */
  const any = (): Instance => instance(options.publicUrl === undefined ? false : secureFor(options.publicUrl));

  const userRow = async (userId: string): Promise<UserRow | undefined> =>
    (await (await ready()).query<UserRow>(`SELECT * FROM ${USER_TABLE} WHERE "id" = ?`, [userId]))[0];

  const resetToken = async (userId: string, ttlMs: number): Promise<{ token: string; expiresAt: number }> => {
    const token = randomToken();
    const expiresAt = Date.now() + ttlMs;
    const context = await any().$context;
    await context.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: userId, expiresAt: new Date(expiresAt) });
    return { token, expiresAt };
  };

  return {
    async handle(request, ctx) {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_AUTH_BODY) return Response.json({ error: "too_large" }, { status: 413 });
      const call = crypto.randomUUID();
      const headers = new Headers(request.headers);
      headers.set(CALL_HEADER, call);
      contexts.set(call, ctx);
      try {
        return await instance(secureFor(request.url)).handler(new Request(request, { headers }));
      } finally {
        contexts.delete(call);
      }
    },

    async user(request) {
      const found = await instance(secureFor(request.url)).api.getSession({ headers: request.headers });
      if (found === null || (found.user as { banned?: boolean | null }).banned === true) return undefined;
      const { id, name, email, emailVerified, image } = found.user;
      return { id, name, email, emailVerified, ...(typeof image === "string" && image !== "" && { image }) } satisfies AccountUser;
    },

    async methods(userId) {
      const rows = await (await ready()).query<{ providerId: string }>(`SELECT DISTINCT "providerId" FROM ${ACCOUNT_TABLE} WHERE "userId" = ?`, [userId]);
      return methodsOf(rows.map((r) => r.providerId));
    },

    async list(page) {
      const limit = Math.min(Math.max(Math.trunc(page.limit), 1), 100);
      const params: (string | number)[] = [];
      let after = "";
      if (page.cursor !== undefined) {
        const m = CURSOR.exec(page.cursor);
        if (m === null) throw refusal("invalid_request", "the cursor is not one this API gave");
        after = ` WHERE "createdAt" < ? OR ("createdAt" = ? AND "id" < ?)`;
        params.push(m[1] as string, m[1] as string, m[2] as string);
      }
      const db = await ready();
      const rows = await db.query<UserRow>(
        `SELECT "id", "name", "email", "emailVerified", "image", "createdAt", "banned" FROM ${USER_TABLE}${after} ORDER BY "createdAt" DESC, "id" DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const shown = rows.slice(0, limit);
      const ids = shown.map((r) => r.id);
      const marks = ids.map(() => "?").join(", ");
      const accounts =
        ids.length === 0 ? [] : await db.query<{ userId: string; providerId: string }>(`SELECT "userId", "providerId" FROM ${ACCOUNT_TABLE} WHERE "userId" IN (${marks})`, ids);
      const seen =
        ids.length === 0
          ? []
          : await db.query<{ userId: string; at: string }>(`SELECT "userId", MAX("updatedAt") AS "at" FROM ${SESSION_TABLE} WHERE "userId" IN (${marks}) GROUP BY "userId"`, ids);
      const items = shown.map((row): AccountSummary => {
        const at = seen.find((s) => s.userId === row.id)?.at;
        return {
          ...summaryUser(row),
          methods: methodsOf(accounts.filter((a) => a.userId === row.id).map((a) => a.providerId)),
          createdAt: Date.parse(row.createdAt),
          ...(at !== undefined && at !== null && { lastSeenAt: Date.parse(at) }),
          banned: row.banned === 1,
        };
      });
      const last = shown.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: `${last.createdAt}|${last.id}` }) } satisfies AccountsPage;
    },

    async invite(person, origin, ctx) {
      const address = person.email.trim().toLowerCase();
      if (address.length > 254 || !EMAIL.test(address)) throw refusal("invalid_request", "that is not an email address");
      const context = await any().$context;
      const found = await context.internalAdapter.findUserByEmail(address, { includeAccounts: true });
      let userId: string;
      if (found !== null) {
        const db = await ready();
        const [sessions] = await db.query<{ n: number }>(`SELECT COUNT(*) AS "n" FROM ${SESSION_TABLE} WHERE "userId" = ?`, [found.user.id]);
        if (found.accounts.length > 0 || Number(sessions?.n ?? 0) > 0) throw refusal("exists", "that person already has an account");
        userId = found.user.id;
      } else {
        const name = person.name?.trim() ?? "";
        const created = await context.internalAdapter.createUser({ email: address, name, emailVerified: true, invitedAt: new Date() }, { method: "admin" });
        userId = created.id;
      }
      const { token, expiresAt } = await resetToken(userId, (options.inviteTtlHours ?? 72) * 3_600_000);
      const link = setPasswordLink(origin, token, true);
      if (options.email !== undefined) await options.email(invitationMessage(options.name, address, link), ctx);
      return { link, expiresAt, emailed: options.email !== undefined, userId } satisfies AccountLink & { userId: string };
    },

    async resetLink(userId, origin, ctx) {
      const row = await userRow(userId);
      if (row === undefined) throw refusal("not_found", "no such user");
      const { token, expiresAt } = await resetToken(userId, (options.resetTtlSeconds ?? 3600) * 1000);
      const link = setPasswordLink(origin, token, false);
      if (options.email !== undefined) await options.email(resetMessage(options.name, row.email, link), ctx);
      return { link, expiresAt, emailed: options.email !== undefined };
    },

    async ban(userId, banned) {
      const db = await ready();
      const { changes } = await db.run(`UPDATE ${USER_TABLE} SET "banned" = ?, "updatedAt" = ? WHERE "id" = ?`, [banned ? 1 : 0, new Date().toISOString(), userId]);
      if (changes === 0) throw refusal("not_found", "no such user");
      if (banned) await db.run(`DELETE FROM ${SESSION_TABLE} WHERE "userId" = ?`, [userId]);
    },

    async remove(userId) {
      if ((await userRow(userId)) === undefined) throw refusal("not_found", "no such user");
      // Sessions, then accounts, then the user: a crash between them leaves a user to remove again.
      await (await any().$context).internalAdapter.deleteUser(userId);
    },
  };
}

/** `password` first, then the providers' ids, once each. */
function methodsOf(providerIds: readonly string[]): string[] {
  const set = new Set(providerIds.map((id) => (id === CREDENTIAL ? "password" : id)));
  return [...set].sort((a, b) => (a === "password" ? -1 : b === "password" ? 1 : a.localeCompare(b)));
}

function summaryUser(row: UserRow): AccountUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified === 1,
    ...(row.image !== null && row.image !== "" && { image: row.image }),
  };
}
