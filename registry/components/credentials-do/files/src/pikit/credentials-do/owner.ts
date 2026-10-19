/**
 * The owner object's side (`CREDENTIALS_KEY`): the credentials in its `storage.sql`, and one lock per
 * provider id, which is how a refresh happens once.
 *
 * pi-ai refreshes an OAuth token inside the store's `modify`, and asks the store for "mutual exclusion
 * per provider id, cross-process too". Refresh tokens rotate: two conversation objects refreshing one
 * token at once would leave one of them with a refresh token the provider already revoked. So every
 * `modify` of every object goes through this object's lock (`acquire`, then `release`):
 *
 * - **One lease at a time per provider.** `acquire` waits until the provider's lock is free, then
 *   answers a lease and the credential read under it: a conversation that waited behind a refresh
 *   gets the refreshed tokens, pi-ai sees they need no refresh, and nothing is refreshed twice.
 * - **A lease expires** (`LEASE_MS`, twice pi-ai's refresh timeout), so an object that died holding
 *   one stalls the others that long at most. A release is taken while its lease is the provider's
 *   latest, expired or not; once a newer one was granted, it is refused (`lease_lost`).
 * - **A failed refresh is not retried in a loop.** A release that says its refresh failed starts a
 *   cooldown (`retryAfterMs`): until it ends, every `acquire` of that provider (the waiters behind
 *   the failure included) is refused `refresh_failed` at once, and nothing reaches the provider. An
 *   operator's upload ends it.
 * - The operator's `put` and `delete` take the lock too, so a refresh in progress never overwrites a
 *   new login.
 *
 * The lock is this object's memory: an object evicted or restarted mid-refresh forgets it (a deploy
 * restarts every object), and a refresh started before can then meet another. The credentials are in
 * the clear in this object's SQLite, as credentials-file keeps them in a file: only the Worker's code
 * reads a Durable Object's storage. No log line holds a credential.
 */

import type { AppContext, Clock } from "@pikit/core";
import { ActorCallError, type ActorInbox, isJsonObject, type JsonValue, type SqlDatabase } from "@pikit/contracts";
import type { Credential } from "@pikit/pi-adapter";
import { CALL, credentialOf, invalid, json, providerIdOf, REFUSAL } from "./calls.ts";

const TABLE = "credentials_do";

/** How long a lease holds the lock: twice pi-ai's refresh timeout (15 s). */
export const LEASE_MS = 30_000;

/** What is stored for a provider, without its secret: pi-ai's `CredentialInfo`, as JSON that crosses a call. */
export type Stored = { providerId: string; type: Credential["type"] };

interface Lock {
  lease: string;
  until: number;
  /** Resolves once the lease is released. */
  released: Promise<void>;
  release(): void;
}

export interface OwnerOptions {
  sql(): SqlDatabase;
  clock: Clock;
  /** After a failed refresh, how long a provider's `acquire` is refused before one is tried again. */
  retryAfterMs: number;
}

export interface Owner {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<Stored[]>;
  /** Waits for the provider's lock; resolves with the lease and the credential read under it. */
  acquire(providerId: string): Promise<{ lease: string; credential: Credential | undefined }>;
  /** Writes `credential` (or records a failed refresh) and frees the lock, if `lease` is still the latest. */
  release(providerId: string, lease: string, outcome: { credential?: Credential; failed?: boolean }, ctx: AppContext): Promise<void>;
  put(providerId: string, credential: Credential, ctx: AppContext): Promise<Stored>;
  delete(providerId: string, ctx: AppContext): Promise<boolean>;
}

export function createOwner(options: OwnerOptions): Owner {
  const { clock } = options;
  const locks = new Map<string, Lock>();
  /** When each provider's last refresh failed, until an upload or a refresh succeeds. */
  const failures = new Map<string, number>();

  let ready: Promise<void> | undefined;
  const sql = async (): Promise<SqlDatabase> => {
    const database = options.sql();
    ready ??= database
      .run(`CREATE TABLE IF NOT EXISTS ${TABLE} (provider_id TEXT PRIMARY KEY, type TEXT NOT NULL, credential TEXT NOT NULL, updated_at BIGINT NOT NULL)`)
      .then(
        () => {},
        (error: unknown) => {
          ready = undefined;
          throw error;
        },
      );
    await ready;
    return database;
  };

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const [row] = await (await sql()).query<{ credential: string }>(`SELECT credential FROM ${TABLE} WHERE provider_id = ?`, [providerId]);
    if (row === undefined) return undefined;
    const credential = credentialOf(JSON.parse(row.credential));
    // Only this file writes the table, through `credentialOf`: a row of no known shape is a bug or a hand's edit.
    if (credential === undefined) throw new Error(`credentials-do: the stored credential of "${providerId}" is not an api_key or oauth credential`);
    return credential;
  };

  const write = async (providerId: string, credential: Credential): Promise<void> => {
    await (await sql()).transaction(async (tx) => {
      await tx.run(`DELETE FROM ${TABLE} WHERE provider_id = ?`, [providerId]);
      await tx.run(`INSERT INTO ${TABLE} (provider_id, type, credential, updated_at) VALUES (?, ?, ?, ?)`, [providerId, credential.type, JSON.stringify(credential), clock.now()]);
    });
  };

  /** Waits until the provider's lock is free (or its lease expired), and takes it. */
  const take = async (providerId: string): Promise<string> => {
    for (;;) {
      const held = locks.get(providerId);
      const now = clock.now();
      if (held === undefined || held.until <= now) {
        let release = () => {};
        const released = new Promise<void>((resolve) => (release = resolve));
        const lease = crypto.randomUUID();
        locks.set(providerId, { lease, until: now + LEASE_MS, released, release });
        return lease;
      }
      await Promise.race([held.released, clock.sleep(held.until - now)]);
    }
  };

  const free = (providerId: string, lease: string): void => {
    const held = locks.get(providerId);
    if (held?.lease !== lease) return;
    locks.delete(providerId);
    held.release();
  };

  /** `work` under the provider's lock, taken and freed here. */
  const locked = async <T>(providerId: string, work: () => Promise<T>): Promise<T> => {
    const lease = await take(providerId);
    try {
      return await work();
    } finally {
      free(providerId, lease);
    }
  };

  const cooling = (providerId: string): boolean => {
    const failedAt = failures.get(providerId);
    return failedAt !== undefined && clock.now() - failedAt < options.retryAfterMs;
  };

  return {
    read,
    async list() {
      const rows = await (await sql()).query<{ provider_id: string; type: string }>(`SELECT provider_id, type FROM ${TABLE} ORDER BY provider_id`);
      return rows.map((row) => ({ providerId: row.provider_id, type: row.type as Credential["type"] }));
    },
    async acquire(providerId) {
      const lease = await take(providerId);
      try {
        if (cooling(providerId)) {
          throw new ActorCallError(REFUSAL.refreshFailed, `credentials-do: the OAuth refresh of "${providerId}" failed a moment ago; it is tried again after ${Math.ceil(options.retryAfterMs / 1000)} s. If it keeps failing, log in again (\`pikit configure --login ${providerId}\`)`);
        }
        return { lease, credential: await read(providerId) };
      } catch (error) {
        free(providerId, lease);
        throw error;
      }
    },
    async release(providerId, lease, outcome, ctx) {
      if (locks.get(providerId)?.lease !== lease) {
        throw new ActorCallError(REFUSAL.leaseLost, `credentials-do: the lock of "${providerId}" was held longer than ${LEASE_MS / 1000} s and given to another; what it wrote is dropped`);
      }
      try {
        if (outcome.failed === true) {
          failures.set(providerId, clock.now());
          ctx.logger.warn("credentials-do: an OAuth refresh failed; the provider is not asked again until the cooldown ends", { providerId, retryAfterMs: options.retryAfterMs });
        } else if (outcome.credential !== undefined) {
          await write(providerId, outcome.credential);
          failures.delete(providerId);
          ctx.logger.info("credentials-do: credential written", { providerId, type: outcome.credential.type });
        }
      } finally {
        free(providerId, lease);
      }
    },
    put: (providerId, credential, ctx) =>
      locked(providerId, async () => {
        await write(providerId, credential);
        failures.delete(providerId);
        ctx.logger.info("credentials-do: credential uploaded", { providerId, type: credential.type });
        return { providerId, type: credential.type };
      }),
    delete: (providerId, ctx) =>
      locked(providerId, async () => {
        const { changes } = await (await sql()).run(`DELETE FROM ${TABLE} WHERE provider_id = ?`, [providerId]);
        failures.delete(providerId);
        if (changes > 0) ctx.logger.info("credentials-do: credential deleted", { providerId });
        return changes > 0;
      }),
  };
}

/** Registers the owner's answers. Every object registers them; only the owner object is called. Call it in `start`. */
export function answerCalls(inbox: ActorInbox, owner: Owner): void {
  const credentialIn = (message: JsonValue, required: boolean): Credential | undefined => {
    const value = isJsonObject(message) ? message.credential : undefined;
    if (value === undefined && !required) return undefined;
    const credential = credentialOf(value);
    if (credential === undefined) throw invalid('"credential" is an api_key or oauth credential');
    return credential;
  };
  inbox.answer(CALL.read, async (_key, message) => {
    const credential = await owner.read(providerIdOf(message));
    return credential === undefined ? {} : { credential: json(credential) };
  });
  inbox.answer(CALL.list, async () => ({ credentials: await owner.list() }));
  inbox.answer(CALL.acquire, async (_key, message) => {
    const { lease, credential } = await owner.acquire(providerIdOf(message));
    return credential === undefined ? { lease } : { lease, credential: json(credential) };
  });
  inbox.answer(CALL.release, async (_key, message, ctx) => {
    const providerId = providerIdOf(message);
    const fields = isJsonObject(message) ? message : {};
    if (typeof fields.lease !== "string" || fields.lease === "") throw invalid('"lease" is the lease acquire answered');
    const credential = credentialIn(message, false);
    await owner.release(providerId, fields.lease, { ...(credential !== undefined && { credential }), ...(fields.failed === true && { failed: true }) }, ctx);
    return {};
  });
  inbox.answer(CALL.put, async (_key, message, ctx) => {
    const providerId = providerIdOf(message);
    return await owner.put(providerId, credentialIn(message, true) as Credential, ctx);
  });
  inbox.answer(CALL.delete, async (_key, message, ctx) => ({ deleted: await owner.delete(providerIdOf(message), ctx) }));
}
