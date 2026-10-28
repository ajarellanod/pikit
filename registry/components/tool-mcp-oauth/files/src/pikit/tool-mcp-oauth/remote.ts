/**
 * `mcp.auth` in every App: one server's tokens, over calls to the owner (`owner.ts`), as pi-mcp's
 * `AuthProvider`, which tool-mcp hands to the server's transport.
 *
 * - `token()`: one `token` call, then kept in this App's memory until `EARLY_MS` before the token
 *   expires (until a 401 when the server gave no expiry). On Cloudflare each call is a subrequest of
 *   the conversation's object, so an MCP request costs none while the token is fresh.
 * - `onUnauthorized({ token })`, after a 401: when this App already holds a newer token, nothing (the
 *   transport retries with it); else one `refresh` call naming the rejected token, shared by every
 *   request of this App that was refused the same token. The owner refreshes only when that token is
 *   still the current one, so many objects refused at once cause one refresh.
 * - A `login_required` refusal is `McpLoginRequiredError` (pi-mcp's `McpOAuthAuthorizationRequiredError`),
 *   with the owner's message: "log in again: `pikit tool-mcp-oauth login <server>`". It drops what
 *   this App kept and reports `tool-mcp-oauth:<server>` degraded through `health`, if installed; a
 *   served token reports it up.
 *
 * No error or log line holds a token: the owner's refusals hold none.
 */

import type { AppContext, Clock } from "@pikit/core";
import { ActorCallError, type ActorMailbox, type HealthReporter, isJsonObject, type JsonValue } from "@pikit/contracts";
import { type McpAuth, McpOAuthAuthorizationRequiredError } from "@pikit/pi-adapter/mcp";
import { CALL, EARLY_MS, OWNER_KEY, REFUSAL } from "./calls.ts";

/** A server with no usable login: its message says how to log in again. */
export class McpLoginRequiredError extends McpOAuthAuthorizationRequiredError {
  constructor(message: string) {
    super();
    this.name = "McpLoginRequiredError";
    this.message = message;
  }
}

export interface RemoteOptions {
  server: string;
  url: string;
  mailbox(): ActorMailbox;
  /** The App's context for calls, from `start` on; `undefined` while the App does not run. */
  context(): AppContext | undefined;
  clock: Clock;
  /** The server's health reporter, when `health` is installed. */
  health(): HealthReporter | undefined;
}

export function createMcpAuth(options: RemoteOptions): McpAuth {
  const { server, clock } = options;
  let kept: { token: string; until: number } | undefined;
  /** The refresh asked for each rejected token, while it runs. */
  const refreshing = new Map<string, Promise<void>>();

  const fresh = (): string | undefined => (kept !== undefined && kept.until > clock.now() ? kept.token : undefined);

  const ask = async (type: string, message: JsonValue): Promise<string> => {
    const ctx = options.context();
    if (ctx === undefined) throw new Error(`tool-mcp-oauth: the token of the MCP server "${server}" was asked for while the app is not running`);
    let answer: JsonValue;
    try {
      answer = await options.mailbox().call(OWNER_KEY, type, message, ctx);
    } catch (error) {
      if (error instanceof ActorCallError && error.code === REFUSAL.loginRequired) {
        kept = undefined;
        options.health()?.degraded(error.message.replace(/^tool-mcp-oauth: /, ""));
        throw new McpLoginRequiredError(error.message);
      }
      throw error;
    }
    const token = isJsonObject(answer) ? answer.token : undefined;
    if (typeof token !== "string" || token === "") throw new Error(`tool-mcp-oauth: the owner answered no token for the MCP server "${server}"`);
    const expiresAt = isJsonObject(answer) && typeof answer.expiresAt === "number" ? answer.expiresAt : Number.POSITIVE_INFINITY;
    kept = { token, until: expiresAt - EARLY_MS };
    options.health()?.up();
    return token;
  };

  return {
    url: options.url,
    async token() {
      return fresh() ?? (await ask(CALL.token, { server }));
    },
    async onUnauthorized(context) {
      const rejected = context.token ?? "";
      const held = fresh();
      // Another request of this App got a newer token since: the transport retries with it.
      if (held !== undefined && held !== rejected) return;
      if (held === rejected) kept = undefined;
      let pending = refreshing.get(rejected);
      if (pending === undefined) {
        const started = ask(CALL.refresh, { server, rejected }).then(() => {});
        const done = () => {
          if (refreshing.get(rejected) === started) refreshing.delete(rejected);
        };
        started.then(done, done);
        refreshing.set(rejected, started);
        pending = started;
      }
      await pending;
    },
  };
}
