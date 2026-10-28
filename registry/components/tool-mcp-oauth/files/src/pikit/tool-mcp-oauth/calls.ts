/**
 * What crosses between tool-mcp-oauth's parts: the owner's key, its call types, the refusals, and the
 * check a login passes when it arrives (from the operator's route, from a call).
 *
 * The logins are one actor's, the owner (`OWNER_KEY`): on a server the App itself (mailbox-local), on
 * Cloudflare one Durable Object of the conversations' class that is never a conversation. Every App
 * reaches it by `actor.mailbox.call`; it answers with `actor.inbox.answer` (`owner.ts`):
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `tool-mcp-oauth.token` | `{ server }` | `{ token, expiresAt? }`: the access token to send now (refreshed first when it expires within `EARLY_MS`) |
 * | `tool-mcp-oauth.refresh` | `{ server, rejected }` | `{ token, expiresAt? }`: after a 401; refreshes only if `rejected` is still the current token, one refresh per server at a time |
 * | `tool-mcp-oauth.put` | `{ server, login }` | `ServerStatus`: an operator's upload |
 * | `tool-mcp-oauth.list` | — | `{ servers: ServerStatus[] }`: no secret |
 * | `tool-mcp-oauth.delete` | `{ server }` | `{ deleted }`: a logout |
 *
 * A refusal is an `ActorCallError` with one of `REFUSAL`'s codes. Only `token`'s and `refresh`'s
 * answers and `put`'s message carry a secret, between the app's own actors; no message of a refusal
 * ever does.
 */

import { ActorCallError, isJsonObject, type JsonValue } from "@pikit/contracts";
import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from "@pikit/pi-adapter/mcp";

/** The actor that keeps the logins: of the conversations' class on Cloudflare, never a conversation. */
export const OWNER_KEY = "tool-mcp-oauth";

export const CALL = {
  token: "tool-mcp-oauth.token",
  refresh: "tool-mcp-oauth.refresh",
  put: "tool-mcp-oauth.put",
  list: "tool-mcp-oauth.list",
  delete: "tool-mcp-oauth.delete",
} as const;

export const REFUSAL = {
  /** A message the owner cannot take: a server not in config, a login of no known shape, another URL. */
  invalid: "invalid_request",
  /** No login the owner can use: none yet, logged out, or its refresh refused. Log in again. */
  loginRequired: "login_required",
  /** The refresh could not be made now (the authorization server down, a timeout): try again. */
  refreshFailed: "refresh_failed",
} as const;

/** A server name, as tool-mcp's config allows them: it starts its tools' names. */
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** A token is sent again (refreshed first) when it expires within this. */
export const EARLY_MS = 60_000;

/** The command that logs in to `server`: every "log in again" names it. */
export const loginCommand = (server: string): string => `pikit tool-mcp-oauth login ${server}`;

export const invalid = (message: string) => new ActorCallError(REFUSAL.invalid, `tool-mcp-oauth: ${message}`);

/**
 * What a login holds, as the login command uploads it and the owner keeps it: what pi-mcp's
 * `McpOAuthProvider` saved after the code exchange, for `url`.
 */
export interface Login {
  /** The MCP server endpoint the login was made for: it is used for no other. */
  url: string;
  /** The client that dynamic registration gave (`client_id`, and `client_secret` when it has one). */
  clientInformation: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  /** When the access token expires, epoch ms; absent when the server did not say. */
  tokensExpireAt?: number;
  /** Where the tokens come from and are refreshed: the authorization server and its metadata. */
  discovery: OAuthDiscoveryState;
}

/** What the operator sees of a configured server: never a secret. */
export interface ServerStatus {
  server: string;
  url: string;
  loggedIn: boolean;
  /** When the current access token expires, epoch ms, when known. */
  expiresAt?: number;
  /** Why it is not logged in, when a login was refused or is for another URL. */
  reason?: string;
}

/** The server name of a message, or a refusal. */
export function serverOf(message: JsonValue): string {
  const server = isJsonObject(message) ? message.server : undefined;
  if (typeof server !== "string" || !SERVER_NAME.test(server)) throw invalid('"server" is a server name (letters, digits, "_", "-")');
  return server;
}

const text = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * `value` as a `Login`, or `undefined` when it is none: a `url`, `clientInformation` with a
 * `client_id`, `tokens` with an `access_token` and a `token_type`, a finite `tokensExpireAt` if any,
 * and `discovery` with the `authorizationServerUrl`. Never says what the value held.
 */
export function loginOf(value: unknown): Login | undefined {
  if (!isJsonObject(value)) return undefined;
  const { url, clientInformation, tokens, tokensExpireAt, discovery } = value;
  if (!text(url) || !URL.canParse(url)) return undefined;
  if (!isJsonObject(clientInformation) || !text(clientInformation.client_id)) return undefined;
  if (clientInformation.client_secret !== undefined && typeof clientInformation.client_secret !== "string") return undefined;
  if (!isJsonObject(tokens) || !text(tokens.access_token) || !text(tokens.token_type)) return undefined;
  if (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== "string") return undefined;
  if (tokensExpireAt !== undefined && (typeof tokensExpireAt !== "number" || !Number.isFinite(tokensExpireAt))) return undefined;
  if (!isJsonObject(discovery) || !text(discovery.authorizationServerUrl)) return undefined;
  return {
    url,
    clientInformation: clientInformation as unknown as OAuthClientInformationMixed,
    tokens: tokens as unknown as OAuthTokens,
    ...(tokensExpireAt !== undefined && { tokensExpireAt }),
    discovery: discovery as unknown as OAuthDiscoveryState,
  };
}

/** The secrets a login holds: what no message, log line or answer may show. */
export function secretsOf(login: Login | undefined): string[] {
  if (login === undefined) return [];
  return [login.tokens.access_token, login.tokens.refresh_token, login.tokens.id_token, login.clientInformation.client_secret].filter(text);
}

/** `message` with each of `secrets` replaced: for text an authorization server wrote. */
export function scrub(message: string, secrets: readonly string[]): string {
  return secrets.reduce((scrubbed, secret) => scrubbed.replaceAll(secret, "[redacted]"), message);
}

/** A value as a call's JSON. */
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
