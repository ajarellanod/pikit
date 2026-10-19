/**
 * What crosses between credentials-do's Apps: the owner object's key, its call types, and the check
 * every credential passes when it arrives (from a call, from the operator's route).
 *
 * The credentials are one object's, the owner (`CREDENTIALS_KEY`, an object of the conversations'
 * class that is never a conversation), reached by `actor.mailbox.call`, answered with
 * `actor.inbox.answer` (`owner.ts`):
 *
 * | Type | Message | Answer |
 * |---|---|---|
 * | `credentials-do.read` | `{ providerId }` | `{ credential? }`: as stored, possibly expiring |
 * | `credentials-do.list` | — | `{ credentials: [{ providerId, type }] }`: no secret |
 * | `credentials-do.acquire` | `{ providerId }` | `{ lease, credential? }`: the provider's lock, once free; the credential read under it |
 * | `credentials-do.release` | `{ providerId, lease, credential?, failed? }` | `{}`: writes `credential` (or records a failed refresh), frees the lock; a repeat (same lease, same outcome) answers `{}` again |
 * | `credentials-do.put` | `{ providerId, credential }` | `{ providerId, type }`: an operator's upload, under the lock |
 * | `credentials-do.delete` | `{ providerId }` | `{ deleted }`, under the lock |
 *
 * A refusal is an `ActorCallError` with one of `REFUSAL`'s codes. No message ever holds a secret but
 * `read`'s and `acquire`'s answers and `release`'s and `put`'s messages, which carry the credential
 * itself between the app's own objects.
 */

import type { Credential } from "@pikit/pi-adapter";
import { ActorCallError, isJsonObject, type JsonValue } from "@pikit/contracts";

/** The object that keeps the credentials: of the conversations' class, never a conversation. */
export const CREDENTIALS_KEY = "credentials-do";

export const CALL = {
  read: "credentials-do.read",
  list: "credentials-do.list",
  acquire: "credentials-do.acquire",
  release: "credentials-do.release",
  put: "credentials-do.put",
  delete: "credentials-do.delete",
} as const;

/** The codes the owner refuses with. */
export const REFUSAL = {
  /** A message the owner cannot take: a bad provider id, a credential of no known shape. */
  invalid: "invalid_request",
  /** The provider's last refresh failed a moment ago: it is not tried again yet. */
  refreshFailed: "refresh_failed",
  /** A release whose lease is no longer the provider's latest: a newer one was granted after it expired. */
  leaseLost: "lease_lost",
} as const;

/** A provider id as pi-ai names them (`anthropic`, `openai-codex`): what a route and a call accept. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const invalid = (message: string) => new ActorCallError(REFUSAL.invalid, `credentials-do: ${message}`);

/** The provider id of a message, or a refusal. */
export function providerIdOf(message: JsonValue): string {
  const providerId = isJsonObject(message) ? message.providerId : undefined;
  if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) throw invalid('"providerId" is a provider id (lowercase letters, digits, ".", "_", "-")');
  return providerId;
}

/**
 * `value` as pi-ai's `Credential`, or `undefined` when it is none: an API key (`type: "api_key"`, a
 * `key` string, an `env` of strings) or OAuth tokens (`type: "oauth"`, non-empty `access` and
 * `refresh`, a finite `expires`; a flow's own fields are kept). Never says what the value held.
 */
export function credentialOf(value: unknown): Credential | undefined {
  if (!isJsonObject(value)) return undefined;
  if (value.type === "api_key") {
    if (value.key !== undefined && typeof value.key !== "string") return undefined;
    if (value.env !== undefined && !(isJsonObject(value.env) && Object.values(value.env).every((each) => typeof each === "string"))) return undefined;
    return value as Credential;
  }
  if (value.type === "oauth") {
    const { access, refresh, expires } = value;
    if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "") return undefined;
    if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
    return value as Credential;
  }
  return undefined;
}

/** A credential as a call's JSON. */
export const json = (credential: Credential): JsonValue => JSON.parse(JSON.stringify(credential)) as JsonValue;
