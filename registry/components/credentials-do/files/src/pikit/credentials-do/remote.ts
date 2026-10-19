/**
 * `model.credentials` in every object's App: pi-ai's `CredentialStore` over calls to the owner object
 * (`owner.ts`), so every conversation reads the one copy of each credential.
 *
 * - `read`: one call, then kept in this object for `cacheTtlMs`. On Cloudflare each call is a
 *   subrequest, counted against the invocation's budget (50 on the Free plan, for a whole alarm
 *   slice), and pi-ai reads before every model request. What `read` answered (none included) and what
 *   this object's `modify` wrote are served from memory until the TTL ends, and an OAuth credential
 *   never past its expiry minus pi-ai's refresh margin (`OAUTH_REFRESH_MARGIN_MS`): pi-ai then sees
 *   it expiring, as stored, and refreshes it through `modify`. So an upload or a delete made
 *   elsewhere (the operator's, another conversation's refresh) reaches a running object within the
 *   TTL; this object's own `modify` and `delete` replace or drop what it kept at once.
 * - `list`, `delete`: one call each.
 * - `modify(providerId, fn)`: `fn` runs here, under the owner's lock for that provider: `acquire`
 *   answers a lease and the credential read under it, `fn` sees that credential, `release` writes
 *   what `fn` returned. pi-ai's refresh is such an `fn`: it checks the credential again and refreshes
 *   only if it still needs to, so of many conversations that found the token expiring, the first
 *   refreshes and the others, which waited for the lock, get its tokens. When `fn` throws (a
 *   refresh refused), the release says so, and the owner refuses the next refreshes for a while
 *   (`retryAfterMs`) instead of letting each conversation try again. This object's own `modify`s and
 *   `delete`s of a provider run one at a time, so what each keeps lands in the owner's order.
 * - **A release that fails is tried again** (`RELEASE_RETRY_MS`; the owner answers a repeat of a
 *   release it took as it did the first time). A refresh has already rotated the refresh token at
 *   the provider: when the owner still does not take the new credential, this object keeps it
 *   ("unsaved"), serves it, logs an error (no secret), and writes it back at its next chance: the
 *   next `modify` of that provider here, or the first `read` after the TTL, while the owner still
 *   holds the credential it was refreshed from. Until then the other conversations hold a revoked
 *   refresh token; if one of them refreshes first, it fails and the owner cools down.
 *
 * `options.signal` cancels `read`, `list` and `delete`. It does not cancel waiting for the lock: a
 * lease granted to a caller that left would hold it until it expires; once the lease is held, an
 * aborted signal releases it untouched.
 */

import { type AppContext, type Clock, withAbortSignal } from "@pikit/core";
import { ActorCallError, type ActorMailbox, isJsonObject, type JsonValue } from "@pikit/contracts";
import type { Credential, CredentialInfo, CredentialStore } from "@pikit/pi-adapter";
import { CALL, CREDENTIALS_KEY, credentialOf, json, REFUSAL } from "./calls.ts";

/**
 * pi-ai refreshes an OAuth token that has less than this left (`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`,
 * pi-ai 1.2.0's `auth/resolve.ts`): the cache never serves a token past `expires` minus it.
 */
export const OAUTH_REFRESH_MARGIN_MS = 5 * 60_000;

/** The waits before each new try of a release that failed: four tries in about 4 s, well within a lease. */
export const RELEASE_RETRY_MS = [200, 1_000, 3_000] as const;

export interface RemoteOptions {
  mailbox(): ActorMailbox;
  /** The App's context for calls, from `start` on; `undefined` while the App does not run. */
  context(): AppContext | undefined;
  clock: Clock;
  /** How long (ms) what `read` answered is served from this object's memory; 0 keeps nothing. */
  cacheTtlMs: number;
}

type Outcome = { credential?: Credential; failed?: boolean };

export function createRemoteCredentials(options: RemoteOptions): CredentialStore {
  const { clock } = options;
  const call = async (type: string, message: JsonValue, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const base = options.context();
    if (base === undefined) throw new Error("credentials-do: model.credentials used while the app is not running");
    const ctx = signal === undefined ? base : base.derive((context) => withAbortSignal(signal, context));
    const answer = await options.mailbox().call(CREDENTIALS_KEY, type, message, ctx);
    return isJsonObject(answer) ? answer : {};
  };
  /** A credential from the owner, checked as it arrives. */
  const arrived = (value: unknown): Credential | undefined => {
    if (value === undefined) return undefined;
    const credential = credentialOf(value);
    if (credential === undefined) throw new Error("credentials-do: the owner object answered a credential of no known shape");
    return credential;
  };
  const same = (a: Credential | undefined, b: Credential | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);

  /** What this object last read or wrote of each provider, and until when it is served. */
  const cache = new Map<string, { credential: Credential | undefined; until: number }>();
  /** Bumped by each `modify` and `delete` here: a `read` that saw it move keeps nothing. */
  const epochs = new Map<string, number>();
  /** This object's `modify`s and `delete`s of each provider, one at a time. */
  const queues = new Map<string, Promise<void>>();
  /** Refreshed credentials the owner did not take, with the credential each was refreshed from. */
  const unsaved = new Map<string, { from: Credential | undefined; credential: Credential }>();

  const keep = (providerId: string, credential: Credential | undefined): void => {
    const now = clock.now();
    const until = Math.min(now + options.cacheTtlMs, credential?.type === "oauth" ? credential.expires - OAUTH_REFRESH_MARGIN_MS : Number.POSITIVE_INFINITY);
    if (until > now) cache.set(providerId, { credential, until });
    else cache.delete(providerId);
  };
  const kept = (providerId: string): { credential: Credential | undefined } | undefined => {
    const hit = cache.get(providerId);
    if (hit !== undefined && hit.until > clock.now()) return hit;
    cache.delete(providerId);
    return undefined;
  };

  const serially = <T>(providerId: string, work: () => Promise<T>): Promise<T> => {
    epochs.set(providerId, (epochs.get(providerId) ?? 0) + 1);
    cache.delete(providerId);
    const run = (queues.get(providerId) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => {},
      () => {},
    );
    queues.set(providerId, settled);
    void settled.then(() => {
      if (queues.get(providerId) === settled) queues.delete(providerId);
    });
    return run;
  };

  const releaseOnce = (providerId: string, lease: string, outcome: Outcome) =>
    call(CALL.release, { providerId, lease, ...(outcome.credential !== undefined && { credential: json(outcome.credential) }), ...(outcome.failed === true && { failed: true }) });
  /** The release, tried again after a failure the owner may not repeat (not a refusal of the lease or the message). */
  const release = async (providerId: string, lease: string, outcome: Outcome): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await releaseOnce(providerId, lease, outcome);
        return;
      } catch (error) {
        const wait = RELEASE_RETRY_MS[attempt];
        if (wait === undefined || (error instanceof ActorCallError && (error.code === REFUSAL.leaseLost || error.code === REFUSAL.invalid))) throw error;
        await clock.sleep(wait);
      }
    }
  };
  /** What a failure is, for a log line: a refusal's code or an error's name, never its message. */
  const reasonOf = (error: unknown): string => (error instanceof ActorCallError ? error.code : error instanceof Error ? error.name : "unknown");

  const modify: CredentialStore["modify"] = (providerId, fn, modifyOptions) =>
    serially(providerId, async () => {
      const signal = modifyOptions?.signal;
      const acquired = await call(CALL.acquire, { providerId });
      const lease = acquired.lease;
      if (typeof lease !== "string") throw new Error("credentials-do: the owner object answered no lease");
      let from: Credential | undefined;
      let current: Credential | undefined;
      let next: Credential | undefined;
      try {
        from = arrived(acquired.credential);
        current = from;
        const own = unsaved.get(providerId);
        if (own !== undefined) {
          // The owner still holds what this object refreshed from: the refreshed credential is the latest.
          if (same(from, own.from)) current = own.credential;
          else unsaved.delete(providerId);
        }
        signal?.throwIfAborted();
        next = await fn(current);
      } catch (error) {
        // A refresh that failed, unless the caller gave up (pi-ai's `fn` throws its abort first).
        await releaseOnce(providerId, lease, { failed: signal?.aborted !== true && current !== undefined }).catch(() => {});
        throw error;
      }
      const result = next ?? current;
      // An unsaved credential is written back even when `fn` left it as it was.
      const written = next ?? (current === from ? undefined : current);
      try {
        await release(providerId, lease, written === undefined ? {} : { credential: written });
      } catch (error) {
        const logger = options.context()?.logger;
        if (written === undefined) {
          // Nothing to write: the lock stays held until the lease expires, and that is all.
          logger?.warn("credentials-do: the owner object did not take a release; the provider's lock is free once the lease expires", { providerId, reason: reasonOf(error) });
          keep(providerId, result);
          return result;
        }
        unsaved.set(providerId, { from, credential: written });
        logger?.error("credentials-do: the owner object did not take a new credential (a refreshed token, rotated at the provider); this object keeps it and writes it back at its next chance, and other conversations may fail to refresh until then", {
          providerId,
          type: written.type,
          reason: reasonOf(error),
        });
        keep(providerId, written);
        return written;
      }
      unsaved.delete(providerId);
      keep(providerId, result);
      return result;
    });

  /** Writes back an unsaved credential (a `modify` that changes nothing writes it), or serves it while the owner does not take it. */
  const writeBack = async (providerId: string, signal: AbortSignal | undefined): Promise<Credential | undefined> => {
    try {
      return await modify(providerId, async () => undefined, signal === undefined ? undefined : { signal });
    } catch (error) {
      const still = unsaved.get(providerId);
      if (still === undefined) throw error;
      keep(providerId, still.credential);
      return still.credential;
    }
  };

  return {
    async read(providerId, readOptions) {
      const hit = kept(providerId);
      if (hit !== undefined) return hit.credential;
      if (unsaved.has(providerId)) return writeBack(providerId, readOptions?.signal);
      const epoch = epochs.get(providerId);
      const credential = arrived((await call(CALL.read, { providerId }, readOptions?.signal)).credential);
      if (epochs.get(providerId) === epoch && !queues.has(providerId)) keep(providerId, credential);
      return credential;
    },
    async list(listOptions) {
      const { credentials } = await call(CALL.list, null, listOptions?.signal);
      if (!Array.isArray(credentials)) throw new Error("credentials-do: the owner object answered no list");
      return credentials.flatMap((each): CredentialInfo[] =>
        isJsonObject(each) && typeof each.providerId === "string" && (each.type === "api_key" || each.type === "oauth") ? [{ providerId: each.providerId, type: each.type }] : [],
      );
    },
    modify,
    async delete(providerId, deleteOptions) {
      await serially(providerId, async () => {
        await call(CALL.delete, { providerId }, deleteOptions?.signal);
        unsaved.delete(providerId);
      });
    },
  };
}
