/**
 * The accounts in this App: better-auth (`better-auth/minimal`, no Kysely) over `storage.sql`
 * (`adapter.ts`). A server's; on Cloudflare, the accounts actor's (`channel-web:accounts`).
 *
 * - **Routes** under `/chat/api/auth` (`AUTH_BASE_PATH`). Cookies `pikit_chat.*` (`__Secure-pikit_chat.*`
 *   on https), path `/chat/`, `HttpOnly`, `SameSite=Lax`, `Secure` on https. The signed cookie cache
 *   (`session_data`) holds a session `sessionCacheSeconds`: a ban or a removal takes effect within it.
 * - **Base URL**: `publicUrl` (`PIKIT_PUBLIC_URL`) when set; else the request's origin, which
 *   better-auth then derives per request (links in its emails, OAuth redirect URIs, `trustedOrigins`),
 *   only when its host is trusted (`linkOrigin`): with `trustRequestHost` (Cloudflare: the Worker's
 *   route, which a client cannot make another's), else only a loopback host (a server: a client writes
 *   `Host`). Any other request is `400 public_url_required` before better-auth sees it, so no link is
 *   ever made under a host a client chose. `Secure` is fixed when an instance is made, so there is one
 *   instance per scheme the requests come with (http, https).
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
 * - **Email** (when `email` is given): a self-made account's confirmation, "forgot password", the
 *   magic link, invitations and operator's resets. Plain, short, the link and the assistant's name. A
 *   failure is the route's error; nothing retries it.
 * - **No unverified password** (when `email` is given): a password sign-up (`/sign-up/email`) gets a
 *   random password nobody knows, whatever the request said (a `before` hook on that endpoint, after
 *   better-auth's routing: no spelling of the path escapes it), and its confirmation email is a link that
 *   sets the account's first password (`welcome`). Setting a password with a link (an invitation, a
 *   reset, a confirmation) verifies the email (`onPasswordReset`): a link reached that address, or the
 *   operator vouched. So someone who signs up with another person's address never holds a password
 *   that works once its owner confirms it (by that link, a magic link or a provider).
 * - **Rate limits**: better-auth's, in memory, on (sign-in, sign-up 3 per 10 s; reset and verification
 *   3 per minute; magic link 5 per minute), per client address from `ipHeaders`: by default the
 *   server's (`x-pikit-client-address`, `http.route`), never a header the client wrote.
 * - **Origin and CSRF checks** always on (better-auth's default turns them off under `NODE_ENV=test`): a
 *   request with the cookies whose `Origin` (else `Referer`) is not the base URL's is refused (403).
 * - **Sessions**: `user` is better-auth's `getSession`; read from the database (the cookie cache
 *   expired), its renewed cookies come back with it, for the route to send.
 * - **Last seen** is the user's own (`lastSeenAt`, a field no request can set), never read from
 *   sessions, so a ban or "sign out everywhere" keeps it: written when a session is made, and by
 *   `user` at most once per `sessionCacheSeconds` (at least a minute) for each user this process saw.
 */

import type { ActorCallErrorCode, SqlDatabase } from "@pikit/contracts";
import { ActorCallError, CLIENT_ADDRESS_HEADER } from "@pikit/contracts";
import type { AppContext, Logger } from "@pikit/core";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import { ACCOUNT_TABLE, MODEL_NAMES, migrate, SESSION_TABLE, sqlAdapter, USER_TABLE } from "./adapter.ts";
import { MAX_AUTH_BODY } from "./forward.ts";
import { AUTH_BASE_PATH, linkOrigin, PUBLIC_URL_REQUIRED, setPasswordLink } from "./links.ts";
import type { AccountLink, AccountSession, AccountSummary, AccountsPage, AccountUser, Accounts } from "./types.ts";

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
  /** `PIKIT_PUBLIC_URL` (an origin, `https://bot.example.com`): the base URL; else a trusted request's origin. */
  publicUrl?: string;
  /** Without `publicUrl`, whether any request's host is trusted (Cloudflare: the Worker's route), not only a loopback one. */
  trustRequestHost?: boolean;
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
  /** The headers holding the client's address, for rate limits, first found first. Default the server's, `x-pikit-client-address`. */
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

/** What `build` needs of the accounts around it. */
type Around = {
  ready: () => Promise<SqlDatabase>;
  contexts: Map<string, AppContext>;
  /** A token that sets `userId`'s password (`reset-password`), valid `ttlMs`. */
  resetToken: (userId: string, ttlMs: number) => Promise<{ token: string; expiresAt: number }>;
  /** Writes `userId`'s `lastSeenAt` now (`always`), or when this process has not for a while. */
  seen: (userId: string, always: boolean) => Promise<void>;
};

function build(options: LocalAccountsOptions, secure: boolean, { ready, contexts, resetToken, seen }: Around) {
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
  /** A password sign-up whose password is nobody's: the confirmation emailed sets the first one. */
  const unknowable = createAuthMiddleware(async (ctx) =>
    ctx.path === "/sign-up/email" ? { context: { body: { ...(ctx.body as Record<string, unknown>), password: randomToken() } } } : undefined,
  );
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
        lastSeenAt: { type: "date", required: false, input: false, returned: false },
      },
    },
    // Never refreshCache: it would re-sign the cache without a database read, and a ban would never cut a
    // page that keeps asking. The cache is renewed only by getSession's database read (`user`).
    session: { ...MODEL_NAMES.session, cookieCache: { enabled: cacheSeconds > 0, maxAge: Math.max(cacheSeconds, 1), refreshCache: false } },
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
          send(request, resetMessage(options.name, user.email, setPasswordLink(new URL(url).origin, token, "reset"))),
      }),
      // A link that sets a password reached the address (or the operator handed it): the email is the
      // person's. Not through better-auth's updateUser: nothing else runs on it.
      onPasswordReset: async ({ user }) => {
        await (await ready()).run(`UPDATE ${USER_TABLE} SET "emailVerified" = 1, "updatedAt" = ? WHERE "id" = ? AND "emailVerified" = 0`, [new Date().toISOString(), user.id]);
      },
    },
    ...(email !== undefined && {
      // A self-made account is confirmed by setting its first password with the emailed link, never
      // by better-auth's verify-email link (whose token nobody is sent): the password a sign-up came with
      // is a random one (`handle`).
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: false,
        autoSignInAfterVerification: false,
        sendVerificationEmail: async ({ user, url }, request) => {
          const { token } = await resetToken(user.id, (options.resetTtlSeconds ?? 3600) * 1000);
          await send(request, verificationMessage(options.name, user.email, setPasswordLink(new URL(url).origin, token, "welcome")));
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
    ...(verificationRequired && { hooks: { before: unknowable } }),
    rateLimit: { enabled: true, storage: "memory", window: 60, max: 100 },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: secure,
      defaultCookieAttributes: { path: COOKIE_PATH, sameSite: "lax", httpOnly: true, secure },
      ipAddress: { ipAddressHeaders: options.ipHeaders ?? [CLIENT_ADDRESS_HEADER] },
      // Said, never left to better-auth's default, which turns both off when NODE_ENV is "test" or TEST is set.
      disableOriginCheck: false,
      disableCSRFCheck: false,
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
          after: async (session) => seen(session.userId, true),
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
  text: `Open this link to confirm your email and choose your password:\n\n${link}\n\nIf you did not sign up, ignore this email.${signature(name)}`,
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

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  createdAt: string;
  banned: number | null;
  lastSeenAt: string | null;
};

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
      made = build(options, secure, { ready, contexts, resetToken, seen });
      instances.set(secure, made);
    }
    return made;
  };
  const secureFor = (url: string): boolean => new URL(options.publicUrl ?? url).protocol === "https:";
  /** For what needs no request: the operator's actions. */
  const any = (): Instance => instance(options.publicUrl === undefined ? false : secureFor(options.publicUrl));

  const userRow = async (userId: string): Promise<UserRow | undefined> =>
    (await (await ready()).query<UserRow>(`SELECT * FROM ${USER_TABLE} WHERE "id" = ?`, [userId]))[0];

  // When this process last wrote each user's lastSeenAt: `user` writes it again only past `seenEveryMs`.
  const seenEveryMs = Math.max(options.sessionCacheSeconds ?? 300, 60) * 1000;
  const written = new Map<string, number>();
  async function seen(userId: string, always: boolean): Promise<void> {
    const now = Date.now();
    if (!always && now - (written.get(userId) ?? 0) < seenEveryMs) return;
    if (written.size >= 10_000) for (const [id, at] of written) if (now - at >= seenEveryMs) written.delete(id);
    written.set(userId, now);
    await (await ready()).run(`UPDATE ${USER_TABLE} SET "lastSeenAt" = ? WHERE "id" = ?`, [new Date(now).toISOString(), userId]);
  }

  async function resetToken(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken();
    const expiresAt = Date.now() + ttlMs;
    const context = await any().$context;
    await context.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: userId, expiresAt: new Date(expiresAt) });
    return { token, expiresAt };
  }

  return {
    async handle(request, ctx) {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_AUTH_BODY) return Response.json({ error: "too_large" }, { status: 413 });
      // Every link better-auth makes for this request is under its origin: only a trusted one.
      if (linkOrigin(request.url, options.publicUrl, options.trustRequestHost === true) === undefined) {
        return Response.json(PUBLIC_URL_REQUIRED, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const call = crypto.randomUUID();
      const headers = new Headers(request.headers);
      headers.set(CALL_HEADER, call);
      contexts.set(call, ctx);
      try {
        // From the URL (Bun 1.4 keeps a request's own headers over new ones in `new Request(request, …)` when they are empty).
        const body = request.body;
        return await instance(secureFor(request.url)).handler(new Request(request.url, { method: request.method, headers, body, ...(body !== null && { duplex: "half" }) } as RequestInit));
      } finally {
        contexts.delete(call);
      }
    },

    async user(request) {
      // better-auth's getSession: the cookie cache when it vouches; else the database, and then its
      // set-cookie renews the cache (and the session, past its updateAge), sent back by the route.
      const { headers, response: found } = await instance(secureFor(request.url)).api.getSession({ headers: request.headers, returnHeaders: true });
      if (found === null || (found.user as { banned?: boolean | null }).banned === true) return undefined;
      const { id, name, email, emailVerified, image } = found.user;
      await seen(id, false);
      const user: AccountUser = { id, name, email, emailVerified, ...(typeof image === "string" && image !== "" && { image }) };
      return { user, cookies: headers.getSetCookie() } satisfies AccountSession;
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
        `SELECT "id", "name", "email", "emailVerified", "image", "createdAt", "banned", "lastSeenAt" FROM ${USER_TABLE}${after} ORDER BY "createdAt" DESC, "id" DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const shown = rows.slice(0, limit);
      const ids = shown.map((r) => r.id);
      const marks = ids.map(() => "?").join(", ");
      const accounts =
        ids.length === 0 ? [] : await db.query<{ userId: string; providerId: string }>(`SELECT "userId", "providerId" FROM ${ACCOUNT_TABLE} WHERE "userId" IN (${marks})`, ids);
      const items = shown.map(
        (row): AccountSummary => ({
          ...summaryUser(row),
          methods: methodsOf(accounts.filter((a) => a.userId === row.id).map((a) => a.providerId)),
          createdAt: Date.parse(row.createdAt),
          ...(row.lastSeenAt !== null && { lastSeenAt: Date.parse(row.lastSeenAt) }),
          banned: row.banned === 1,
        }),
      );
      const last = shown.at(-1);
      return { items, ...(rows.length > limit && last !== undefined && { next: `${last.createdAt}|${last.id}` }) } satisfies AccountsPage;
    },

    async invite(person, origin, ctx) {
      // `origin` is the caller's `linkOrigin` (the admin routes'): checked there, before anything is made.
      const address = person.email.trim().toLowerCase();
      if (address.length > 254 || !EMAIL.test(address)) throw refusal("invalid_request", "that is not an email address");
      const context = await any().$context;
      const found = await context.internalAdapter.findUserByEmail(address, { includeAccounts: true });
      let userId: string;
      if (found !== null) {
        // Seen once (a magic link's user has no account row), even with every session gone: theirs.
        if (found.accounts.length > 0 || ((await userRow(found.user.id))?.lastSeenAt ?? null) !== null) throw refusal("exists", "that person already has an account");
        userId = found.user.id;
      } else {
        const name = person.name?.trim() ?? "";
        const created = await context.internalAdapter.createUser({ email: address, name, emailVerified: true, invitedAt: new Date() }, { method: "admin" });
        userId = created.id;
      }
      const { token, expiresAt } = await resetToken(userId, (options.inviteTtlHours ?? 72) * 3_600_000);
      const link = setPasswordLink(origin, token, "invite");
      if (options.email !== undefined) await options.email(invitationMessage(options.name, address, link), ctx);
      return { link, expiresAt, emailed: options.email !== undefined, userId } satisfies AccountLink & { userId: string };
    },

    async resetLink(userId, origin, ctx) {
      const row = await userRow(userId);
      if (row === undefined) throw refusal("not_found", "no such user");
      const { token, expiresAt } = await resetToken(userId, (options.resetTtlSeconds ?? 3600) * 1000);
      const link = setPasswordLink(origin, token, "reset");
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
