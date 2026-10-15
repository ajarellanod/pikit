/**
 * What the channel asks of its accounts (features/completed/channel-web.md, "Accounts: better-auth"), apart
 * from better-auth: the routes (`routes.ts`) and the admin routes are written over this interface.
 *
 * - **Local** (`accounts/local.ts`, `createLocalAccounts`): better-auth in this App, over its
 *   `storage.sql` (the adapter, `accounts/adapter.ts`). A server's; on Cloudflare, the accounts
 *   actor's (`channel-web:accounts`), which answers the Worker's calls with it.
 * - **Remote** (`accounts/remote.ts`): the Worker's, every call forwarded to the accounts actor
 *   (`actor.mailbox.call`), but `user`, which checks the signed cookie cache in the Worker first and
 *   calls only when it is missing or expired.
 *
 * What crosses an actor is JSON: these types are `type` aliases, checked on arrival.
 */

import { ActorCallError } from "@pikit/contracts";
import type { AppContext } from "@pikit/core";

/** A user, as the channel knows them. */
export type AccountUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string;
};

/**
 * The user of a request's session, and the `set-cookie` values to send back with the route's answer:
 * better-auth's own (`getSession`), a renewed cookie cache when the session was read from the database
 * (none when the cache vouched for it), so the next requests cost no database read again.
 */
export type AccountSession = { user: AccountUser; cookies: string[] };

/** A user as the operator lists them. */
export type AccountSummary = AccountUser & {
  /** `password`, and the provider ids linked. */
  methods: string[];
  createdAt: number;
  /** Epoch ms they were last seen: a sign-in, or a request at most `sessionCacheSeconds` (at least a minute) after it; kept through a ban or a sign-out. Absent: never. */
  lastSeenAt?: number;
  banned: boolean;
};

/** A link the operator hands over (an invitation, a password reset), and whether it was emailed too. */
export type AccountLink = { link: string; expiresAt: number; emailed: boolean };

/** A user's state, as the operator filters them: `banned`; `invited` (not banned, no way to sign in, never seen); else `active`. */
export type AccountState = "active" | "invited" | "banned";
export const ACCOUNT_STATES: readonly AccountState[] = ["active", "invited", "banned"];

/** A page of `list`: `limit` users from `offset`, of those in `state` (all when absent) whose name, email or id holds `q`. */
export type AccountsQuery = { limit: number; offset: number; state?: AccountState; q?: string };

/**
 * A query as it arrives (the admin route's parameters, the accounts actor's message), checked: `limit`
 * an integer from 1 to 100, `offset` from 0, `state` one of `ACCOUNT_STATES`, `q` at most 200
 * characters (blank is none). Else `invalid_request`.
 */
export function accountsQuery(fields: { limit?: unknown; offset?: unknown; state?: unknown; q?: unknown }): AccountsQuery {
  const { limit, offset = 0, state, q } = fields;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActorCallError("invalid_request", "limit is an integer from 1 to 100");
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new ActorCallError("invalid_request", "offset is an integer from 0");
  if (state !== undefined && !ACCOUNT_STATES.includes(state as AccountState)) throw new ActorCallError("invalid_request", `state is one of ${ACCOUNT_STATES.join(", ")}`);
  if (q !== undefined && (typeof q !== "string" || q.length > 200)) throw new ActorCallError("invalid_request", "q is at most 200 characters");
  const needle = typeof q === "string" ? q.trim() : "";
  return { limit, offset, ...(state !== undefined && { state: state as AccountState }), ...(needle !== "" && { q: needle }) };
}

/** `total`: the users `state` and `q` select (what the pages cover); `counts`: those `q` selects, by state. */
export type AccountsPage = { items: AccountSummary[]; total: number; counts: Record<"all" | AccountState, number> };

/** Why an operator's action was refused: the admin routes answer with its code. */
export type AccountsRefusal = "not_found" | "exists" | "invalid_request";

export interface Accounts {
  /** better-auth's own routes (`/chat/api/auth/*`): the response as it made it, every `set-cookie` kept. */
  handle(request: Request, ctx: AppContext): Promise<Response>;
  /** The user whose session `request` carries, with the cookies to send back, or `undefined`: none, expired, revoked, banned. */
  user(request: Request, ctx: AppContext): Promise<AccountSession | undefined>;
  /** How `userId` signs in: `password` and the provider ids linked. */
  methods(userId: string, ctx: AppContext): Promise<string[]>;

  /** The operator's (behind `admin.auth`). Newest first. */
  list(query: AccountsQuery, ctx: AppContext): Promise<AccountsPage>;
  /** Makes the user (or finds one not signed in yet) and a link that lets them in; `exists` when they already have an account in use. */
  invite(person: { email: string; name?: string }, origin: string, ctx: AppContext): Promise<AccountLink & { userId: string }>;
  /** A link that sets a new password; `not_found`. */
  resetLink(userId: string, origin: string, ctx: AppContext): Promise<AccountLink>;
  /** Bans (every session revoked) or lifts it; `not_found`. */
  ban(userId: string, banned: boolean, ctx: AppContext): Promise<void>;
  /** Removes the user, their sessions and accounts; `not_found`. */
  remove(userId: string, ctx: AppContext): Promise<void>;
}
