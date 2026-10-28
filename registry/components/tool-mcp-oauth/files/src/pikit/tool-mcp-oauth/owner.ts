/**
 * The owner's side (`OWNER_KEY`): each configured server's login in its `storage.sql`, and the only
 * refreshes of the deployment.
 *
 * - **One row per server name** (`tool_mcp_oauth`): the login as the operator uploaded it (`Login`:
 *   client, tokens, expiry, discovery), for the URL it was made for, and why it stopped being
 *   usable when a refresh was refused. Two server names never share a row, even with one URL (two
 *   accounts of one service).
 * - **A login is used only with its URL.** One whose `url` is not the server's in config now (the
 *   config changed since the login) is not served: log in again.
 * - **Only the owner refreshes, one refresh per server at a time.** Refresh tokens rotate: two
 *   refreshes from one refresh token would leave one of them with a revoked token. `refresh` runs under
 *   the server's lock (this actor's memory) and refreshes only when the rejected token is still the
 *   current one; every caller that waited behind it gets the tokens it stored. `token` refreshes the
 *   same way first when the token expires within `EARLY_MS`.
 * - **A refused refresh ends the login** (`invalid_grant`, `invalid_client`, any OAuth error but
 *   `server_error`): the tokens are dropped, the reason kept, and every caller is told to log in again
 *   (`login_required`) without another request to the authorization server, until a new login. One
 *   that could not be made (the server down, a timeout, `server_error`) keeps the login and is
 *   `refresh_failed`: the next 401 tries again.
 *
 * The lock is memory: an owner evicted mid-refresh (Cloudflare may) forgets it, and a refresh token
 * the authorization server rotated in an answer that never arrived is lost: the next refresh is then
 * refused, and the server needs a new login. Logins are in the clear in the owner's storage, as
 * credentials-do keeps model logins: only the app's code reads it. No log line holds a secret.
 */

import type { AppContext, Clock } from "@pikit/core";
import { ActorCallError, type ActorInbox, isJsonObject, type SqlDatabase } from "@pikit/contracts";
import { type McpFetch, OAuthError, refreshAuthorization, selectResource } from "@pikit/pi-adapter/mcp";
import { CALL, EARLY_MS, invalid, json, type Login, loginCommand, loginOf, OWNER_KEY, REFUSAL, scrub, secretsOf, serverOf, type ServerStatus } from "./calls.ts";

const TABLE = "tool_mcp_oauth";

/** How long a refresh may take before it is `refresh_failed`. */
export const REFRESH_TIMEOUT_MS = 15_000;

export interface OwnerOptions {
  sql(): SqlDatabase;
  clock: Clock;
  /** The servers in config: name → the URL their logins are for. */
  servers: Readonly<Record<string, { url: string }>>;
  /** The `fetch` refreshes use (tests); the platform's by default, called without a receiver. */
  fetch?: McpFetch;
}

/** What `token` and `refresh` answer. */
export interface Served {
  token: string;
  expiresAt?: number;
}

export interface Owner {
  token(server: string, ctx: AppContext): Promise<Served>;
  refresh(server: string, rejected: string, ctx: AppContext): Promise<Served>;
  put(server: string, login: Login, ctx: AppContext): Promise<ServerStatus>;
  list(): Promise<ServerStatus[]>;
  delete(server: string, ctx: AppContext): Promise<boolean>;
}

interface Row {
  url: string;
  login: Login | undefined;
  refused: string | undefined;
}

export function loginRequired(server: string, why: string): ActorCallError {
  return new ActorCallError(REFUSAL.loginRequired, `tool-mcp-oauth: the MCP server "${server}" is not logged in (${why}): log in again: \`${loginCommand(server)}\``);
}

export function createOwner(options: OwnerOptions): Owner {
  const { clock } = options;
  const fetcher: McpFetch = options.fetch ?? ((input, init) => fetch(input, init));
  /** Each server's refreshes, one at a time. */
  const queues = new Map<string, Promise<void>>();

  let ready: Promise<void> | undefined;
  const sql = async (): Promise<SqlDatabase> => {
    const database = options.sql();
    ready ??= database.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (server TEXT PRIMARY KEY, url TEXT NOT NULL, login TEXT, refused TEXT, updated_at BIGINT NOT NULL)`).then(
      () => {},
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
    await ready;
    return database;
  };

  const configured = (server: string): string => {
    const found = Object.hasOwn(options.servers, server) ? options.servers[server] : undefined;
    if (found === undefined) throw invalid(`"${server}" is not a server in tool-mcp-oauth's config`);
    return found.url;
  };

  const read = async (server: string): Promise<Row | undefined> => {
    const [row] = await (await sql()).query<{ url: string; login: string | null; refused: string | null }>(`SELECT url, login, refused FROM ${TABLE} WHERE server = ?`, [server]);
    if (row === undefined) return undefined;
    // Only this file writes the table, through `loginOf`: a row of no known shape is a hand's edit.
    const login = row.login === null ? undefined : loginOf(JSON.parse(row.login));
    return { url: row.url, login, refused: row.refused ?? (row.login !== null && login === undefined ? "its stored login is unreadable" : undefined) };
  };

  const write = async (server: string, url: string, login: Login | undefined, refused: string | undefined): Promise<void> => {
    await (await sql()).transaction(async (tx) => {
      await tx.run(`DELETE FROM ${TABLE} WHERE server = ?`, [server]);
      await tx.run(`INSERT INTO ${TABLE} (server, url, login, refused, updated_at) VALUES (?, ?, ?, ?, ?)`, [server, url, login === undefined ? null : JSON.stringify(login), refused ?? null, clock.now()]);
    });
  };

  /** The server's login, usable for its URL in config now, or `login_required`. */
  const usable = async (server: string): Promise<Login> => {
    const url = configured(server);
    const row = await read(server);
    if (row === undefined) throw loginRequired(server, "no login yet");
    if (row.url !== url) throw loginRequired(server, `its login is for ${row.url}, and the server is now ${url}`);
    if (row.login === undefined) throw loginRequired(server, row.refused ?? "logged out");
    return row.login;
  };

  const served = (login: Login): Served => ({ token: login.tokens.access_token, ...(login.tokensExpireAt !== undefined && { expiresAt: login.tokensExpireAt }) });
  const expiring = (login: Login): boolean => login.tokensExpireAt !== undefined && login.tokensExpireAt - clock.now() <= EARLY_MS;

  const serially = <T>(server: string, work: () => Promise<T>): Promise<T> => {
    const run = (queues.get(server) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => {},
      () => {},
    );
    queues.set(server, settled);
    void settled.then(() => {
      if (queues.get(server) === settled) queues.delete(server);
    });
    return run;
  };

  /** Under the server's lock: refreshes when `rejected` is still the current token (and, `early`, expiring). */
  const refreshIfCurrent = async (server: string, rejected: string, early: boolean, ctx: AppContext): Promise<Served> => {
    const login = await usable(server);
    if (login.tokens.access_token !== rejected || (early && !expiring(login))) return served(login);
    const refreshToken = login.tokens.refresh_token;
    if (refreshToken === undefined || refreshToken === "") {
      await write(server, login.url, undefined, "the token expired, and the server gave no refresh token");
      ctx.logger.warn("tool-mcp-oauth: a token was rejected and cannot be refreshed (no refresh token): the server needs a new login", { server });
      throw loginRequired(server, "the token expired, and the server gave no refresh token");
    }
    let tokens: Login["tokens"];
    try {
      const metadata = login.discovery.authorizationServerMetadata;
      const resource = selectResource(login.url, login.discovery.resourceMetadata);
      tokens = await refreshAuthorization(login.discovery.authorizationServerUrl, {
        ...(metadata !== undefined && { metadata }),
        clientInformation: login.clientInformation,
        ...(resource !== undefined && { resource }),
        refreshToken,
        fetch: fetcher,
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      const secrets = secretsOf(login);
      const said = scrub(error instanceof Error ? error.message : String(error), secrets);
      if (error instanceof OAuthError && error.code !== "server_error") {
        // Refused for good: the next login replaces it. Nothing asks the authorization server again until then.
        const why = `the authorization server refused the refresh: ${error.code}`;
        await write(server, login.url, undefined, why);
        ctx.logger.warn("tool-mcp-oauth: a refresh was refused: the server needs a new login", { server, code: error.code });
        throw loginRequired(server, why);
      }
      ctx.logger.warn("tool-mcp-oauth: a refresh could not be made; the next 401 tries again", { server, error: said });
      throw new ActorCallError(REFUSAL.refreshFailed, `tool-mcp-oauth: the token of the MCP server "${server}" could not be refreshed now (${said}): try again`);
    }
    const now = clock.now();
    const next: Login = { ...login, tokens };
    if (tokens.expires_in !== undefined) next.tokensExpireAt = now + tokens.expires_in * 1000;
    else delete next.tokensExpireAt;
    await write(server, login.url, next, undefined);
    ctx.logger.info("tool-mcp-oauth: token refreshed", { server, rotated: tokens.refresh_token !== refreshToken });
    return served(next);
  };

  const status = (server: string, url: string, row: Row | undefined): ServerStatus => {
    if (row === undefined) return { server, url, loggedIn: false, reason: "no login yet" };
    if (row.url !== url) return { server, url, loggedIn: false, reason: `its login is for ${row.url}` };
    if (row.login === undefined) return { server, url, loggedIn: false, reason: row.refused ?? "logged out" };
    return { server, url, loggedIn: true, ...(row.login.tokensExpireAt !== undefined && { expiresAt: row.login.tokensExpireAt }) };
  };

  return {
    async token(server, ctx) {
      const login = await usable(server);
      if (!expiring(login)) return served(login);
      try {
        return await serially(server, () => refreshIfCurrent(server, login.tokens.access_token, true, ctx));
      } catch (error) {
        // Not refreshed now, but not expired yet either: the server may still take it.
        if (error instanceof ActorCallError && error.code === REFUSAL.refreshFailed && (login.tokensExpireAt as number) > clock.now()) return served(login);
        throw error;
      }
    },
    async refresh(server, rejected, ctx) {
      configured(server);
      return await serially(server, () => refreshIfCurrent(server, rejected, false, ctx));
    },
    async put(server, login, ctx) {
      const url = configured(server);
      if (login.url !== url) throw invalid(`the login is for ${login.url}, and the server "${server}" is ${url} in config`);
      // Under the lock: a refresh in progress never overwrites a new login.
      return await serially(server, async () => {
        await write(server, url, login, undefined);
        ctx.logger.info("tool-mcp-oauth: login uploaded", { server });
        return status(server, url, { url, login, refused: undefined });
      });
    },
    async list() {
      return Promise.all(Object.entries(options.servers).map(async ([server, { url }]) => status(server, url, await read(server))));
    },
    async delete(server, ctx) {
      configured(server);
      return await serially(server, async () => {
        const { changes } = await (await sql()).run(`DELETE FROM ${TABLE} WHERE server = ?`, [server]);
        if (changes > 0) ctx.logger.info("tool-mcp-oauth: logged out", { server });
        return changes > 0;
      });
    },
  };
}

/** Only the owner's key is answered: a call that reached another actor would read and write that one's storage. */
const owned = (key: string): void => {
  if (key !== OWNER_KEY) throw invalid(`${key} does not hold the logins (${OWNER_KEY} does)`);
};

/** Registers the owner's answers. Every actor's App registers them; only the owner's key is answered. Call it in `start`. */
export function answerCalls(inbox: ActorInbox, owner: Owner): void {
  inbox.answer(CALL.token, async (key, message, ctx) => (owned(key), json(await owner.token(serverOf(message), ctx))));
  inbox.answer(CALL.refresh, async (key, message, ctx) => {
    owned(key);
    const rejected = isJsonObject(message) ? message.rejected : undefined;
    if (typeof rejected !== "string") throw invalid('"rejected" is the token the server refused');
    return json(await owner.refresh(serverOf(message), rejected, ctx));
  });
  inbox.answer(CALL.put, async (key, message, ctx) => {
    owned(key);
    const server = serverOf(message);
    const login = loginOf(isJsonObject(message) ? message.login : undefined);
    if (login === undefined) throw invalid('"login" is a login: { url, clientInformation, tokens, tokensExpireAt?, discovery }');
    return json(await owner.put(server, login, ctx));
  });
  inbox.answer(CALL.list, async (key) => (owned(key), { servers: json(await owner.list()) }));
  inbox.answer(CALL.delete, async (key, message, ctx) => (owned(key), { deleted: await owner.delete(serverOf(message), ctx) }));
}
