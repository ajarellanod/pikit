/**
 * `model.credentials` in every object's App: pi-ai's `CredentialStore` over calls to the owner object
 * (`owner.ts`), so every conversation reads the one copy of each credential.
 *
 * - `read`, `list`, `delete`: one call each. `read` answers the credential as stored, possibly about
 *   to expire, as pi-ai's contract says; pi-ai then refreshes it through `modify`.
 * - `modify(providerId, fn)`: `fn` runs here, under the owner's lock for that provider: `acquire`
 *   answers a lease and the credential read under it, `fn` sees that credential, `release` writes
 *   what `fn` returned. pi-ai's refresh is such an `fn`: it checks the credential again and refreshes
 *   only if it still needs to, so of many conversations that found the token expiring, the first
 *   refreshes and the others, which waited for the lock, get its tokens. When `fn` throws (a
 *   refresh refused), the release says so, and the owner refuses the next refreshes for a while
 *   (`retryAfterMs`) instead of letting each conversation try again.
 *
 * `options.signal` cancels `read`, `list` and `delete`. It does not cancel waiting for the lock: a
 * lease granted to a caller that left would hold it until it expires; once the lease is held, an
 * aborted signal releases it untouched.
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import { type ActorMailbox, isJsonObject, type JsonValue } from "@pikit/contracts";
import type { Credential, CredentialInfo, CredentialStore } from "@pikit/pi-adapter";
import { CALL, CREDENTIALS_KEY, credentialOf, json } from "./calls.ts";

export interface RemoteOptions {
  mailbox(): ActorMailbox;
  /** The App's context for calls, from `start` on; `undefined` while the App does not run. */
  context(): AppContext | undefined;
}

export function createRemoteCredentials(options: RemoteOptions): CredentialStore {
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

  return {
    async read(providerId, readOptions) {
      return arrived((await call(CALL.read, { providerId }, readOptions?.signal)).credential);
    },
    async list(listOptions) {
      const { credentials } = await call(CALL.list, null, listOptions?.signal);
      if (!Array.isArray(credentials)) throw new Error("credentials-do: the owner object answered no list");
      return credentials.flatMap((each): CredentialInfo[] =>
        isJsonObject(each) && typeof each.providerId === "string" && (each.type === "api_key" || each.type === "oauth") ? [{ providerId: each.providerId, type: each.type }] : [],
      );
    },
    async modify(providerId, fn, modifyOptions) {
      const signal = modifyOptions?.signal;
      const acquired = await call(CALL.acquire, { providerId });
      const lease = acquired.lease;
      if (typeof lease !== "string") throw new Error("credentials-do: the owner object answered no lease");
      const release = (outcome: { credential?: Credential; failed?: boolean }) =>
        call(CALL.release, { providerId, lease, ...(outcome.credential !== undefined && { credential: json(outcome.credential) }), ...(outcome.failed === true && { failed: true }) });
      let current: Credential | undefined;
      let next: Credential | undefined;
      try {
        current = arrived(acquired.credential);
        signal?.throwIfAborted();
        next = await fn(current);
      } catch (error) {
        // A refresh that failed, unless the caller gave up (pi-ai's `fn` throws its abort first).
        await release({ failed: signal?.aborted !== true && current !== undefined }).catch(() => {});
        throw error;
      }
      await release(next === undefined ? {} : { credential: next });
      return next ?? current;
    },
    async delete(providerId, deleteOptions) {
      await call(CALL.delete, { providerId }, deleteOptions?.signal);
    },
  };
}
