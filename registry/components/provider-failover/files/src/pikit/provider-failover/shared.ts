/**
 * provider-failover's cooldowns shared by every App: what one conversation learnt (a model's 429,
 * refused credentials, an answer that cleared them) protects the others, and survives a restart.
 *
 * - **One owner.** The cooldowns are one actor's, `provider-failover:cooldowns` (`COOLDOWNS_KEY`),
 *   reached with `actor.mailbox.call(COOLDOWNS_KEY, "provider-failover.sync", …)` and answered by the
 *   handler every App with `actor.inbox` and `storage.sql` registers (`answerSync`; only the owner is
 *   called). On a server (mailbox-local) the owner is this App; on `durable` (actors-do) it is the
 *   Durable Object of that key. It keeps them in its `storage.sql` table `provider_failover_cooldowns`:
 *   the key (a model or a provider), why, until when and when it was learnt. Never an error's text,
 *   nor a credential.
 * - **A local copy.** Each App reads its own copy (`createCooldowns`), so no request waits on the
 *   owner but an App's first, and that one at most `firstWaitMs` (while the start's sync is out). A
 *   failure updates the copy at once and is reported (`sync` with the entry), and the answer is every
 *   entry the owner holds, merged into the copy. The copy is read again on a request once it is
 *   `refreshMs` old.
 * - **Idempotent, in any order.** Each entry carries when it was learnt (`at`), and the newest of a key
 *   wins, at the owner as in each copy: a report sent again, or one that arrives after a newer answer,
 *   changes nothing. An entry not taken by the owner stays to send with the next sync.
 * - **Never in a request's way.** A sync that fails (no owner, its storage, a timeout) is logged, once
 *   per streak, and the App goes on with its copy.
 *
 * Neutral: no node-only import.
 */

import { type AppContext, withAbortSignal } from "@pikit/core";
import { ActorCallError, type ActorInbox, type ActorMailbox, isJsonObject, type JsonValue, type SqlDatabase } from "@pikit/contracts";
import type { CooldownEntry, Cooldowns, FailureKind } from "./failover.ts";

/** The actor that owns the cooldowns. */
export const COOLDOWNS_KEY = "provider-failover:cooldowns";
/** `{ entries }` learnt by the caller; answered `{ entries }`, every one the owner holds. */
export const SYNC = "provider-failover.sync";
export const TABLE = "provider_failover_cooldowns";

const KINDS: readonly FailureKind[] = ["rate", "auth", "unavailable", "transient"];
const KEY = /^(provider|model):\S{1,300}$/;
const MAX_ENTRIES = 500;
/** How long the owner keeps an entry past its end and its learning: a late report of something older still loses to it. */
const KEEP_MS = 24 * 60 * 60_000;
/** How long a sync may take before it counts as failed. */
export const CALL_TIMEOUT_MS = 5_000;

const invalid = (what: string) => new ActorCallError("invalid", `provider-failover: ${what}`);
const epoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The entries of a sync's message or answer, checked as they arrive (they crossed an actor as JSON). */
export function entriesOf(value: JsonValue | undefined): CooldownEntry[] {
  const entries = isJsonObject(value) ? value.entries : undefined;
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw invalid(`a sync is { entries }, at most ${MAX_ENTRIES}`);
  return entries.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.key !== "string" || !KEY.test(entry.key) || !epoch(entry.until) || !epoch(entry.at)) {
      throw invalid("an entry is { key: provider:<id> or model:<provider>/<id>, kind?, until, at }");
    }
    if (entry.kind === undefined || entry.kind === null) return { key: entry.key, until: 0, at: entry.at };
    if (!KINDS.includes(entry.kind as FailureKind)) throw invalid(`kind is one of ${KINDS.join(", ")}`);
    return { key: entry.key, kind: entry.kind as FailureKind, until: entry.until, at: entry.at };
  });
}

/** The owner's side: registers the sync's handler, over `db` (its table made at the first sync). */
export function answerSync(inbox: ActorInbox, db: () => SqlDatabase, now: () => number): void {
  let made: Promise<unknown> | undefined;
  const table = () => {
    made ??= db()
      .run(`CREATE TABLE IF NOT EXISTS ${TABLE} (name TEXT PRIMARY KEY, kind TEXT, until_ms BIGINT NOT NULL, at_ms BIGINT NOT NULL)`)
      .catch((error: unknown) => {
        made = undefined;
        throw error;
      });
    return made;
  };
  inbox.answer(SYNC, async (key, message) => {
    if (key !== COOLDOWNS_KEY) throw invalid(`${key} does not hold the cooldowns (${COOLDOWNS_KEY} does)`);
    const entries = entriesOf(message);
    await table();
    const sql = db();
    if (entries.length > 0) {
      await sql.transaction(async (tx) => {
        for (const entry of entries) {
          const [row] = await tx.query(`SELECT at_ms FROM ${TABLE} WHERE name = ?`, [entry.key]);
          if (row !== undefined && Number(row.at_ms) >= entry.at) continue;
          const values = [entry.kind ?? null, entry.until, entry.at];
          if (row === undefined) await tx.run(`INSERT INTO ${TABLE} (kind, until_ms, at_ms, name) VALUES (?, ?, ?, ?)`, [...values, entry.key]);
          else await tx.run(`UPDATE ${TABLE} SET kind = ?, until_ms = ?, at_ms = ? WHERE name = ?`, [...values, entry.key]);
        }
        const old = now() - KEEP_MS;
        await tx.run(`DELETE FROM ${TABLE} WHERE until_ms < ? AND at_ms < ?`, [old, old]);
      });
    }
    const rows = await sql.query(`SELECT name, kind, until_ms, at_ms FROM ${TABLE}`);
    return {
      entries: rows.map((row) => ({ key: String(row.name), ...(row.kind !== null && { kind: String(row.kind) }), until: Number(row.until_ms), at: Number(row.at_ms) })),
    };
  });
}

export interface SharingOptions {
  /** `undefined` without `actor.mailbox`: nothing is shared, the copy is all there is. */
  mailbox(): ActorMailbox | undefined;
  cooldowns(): Cooldowns;
  now(): number;
  /** How old the copy may be before a request reads it again (in the background). */
  refreshMs: number;
  /** How long an App's first requests wait for the start's sync. */
  firstWaitMs: number;
  /** The copy changed: the health report may have. */
  changed(): void;
  /** A sync failed (the first of a streak), or worked again. Never a credential. */
  log(level: "warn" | "info", message: string, fields?: Record<string, unknown>): void;
}

export interface Sharing {
  /** For `createCooldowns`: what the copy learnt, reported now. */
  learnt(entries: readonly CooldownEntry[]): void;
  /** For `failoverProvider`: the start's sync (bounded), and a refresh of a stale copy (not waited for). */
  ready(): Promise<void>;
  /** Reads the owner's cooldowns now, with `ctx` (the App's background context) for every call. */
  start(ctx: AppContext): void;
  stop(): void;
}

export function shareCooldowns(options: SharingOptions): Sharing {
  /** The newest entry of each key the owner has not taken yet. */
  const pending = new Map<string, CooldownEntry>();
  let ctx: AppContext | undefined;
  let last: number | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let failing = false;
  let first: Promise<void> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;

  const once = async (): Promise<void> => {
    const mailbox = options.mailbox();
    if (mailbox === undefined || ctx === undefined) return;
    const sent = [...pending.values()];
    last = options.now();
    try {
      const bounded = ctx.derive((inner) => withAbortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS), inner));
      const answer = await mailbox.call(COOLDOWNS_KEY, SYNC, { entries: sent as unknown as JsonValue[] }, bounded);
      for (const entry of sent) if (pending.get(entry.key) === entry) pending.delete(entry.key);
      const changed = options.cooldowns().merge(entriesOf(answer));
      if (failing) options.log("info", "provider-failover: the shared cooldowns are reachable again");
      failing = false;
      if (changed) options.changed();
    } catch (error) {
      if (!failing) {
        options.log("warn", "provider-failover: the shared cooldowns could not be synced; going on with this App's own", {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof ActorCallError && { code: error.code }),
        });
      }
      failing = true;
    }
  };
  /** One sync at a time; asked meanwhile, one more after it (with what was learnt since). */
  const sync = (): Promise<void> => {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await once();
      } while (again && ctx !== undefined);
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    learnt(entries) {
      if (options.mailbox() === undefined) return;
      for (const entry of entries) pending.set(entry.key, entry);
      void sync();
    },
    async ready() {
      if (first !== undefined) await first;
      if (ctx !== undefined && options.mailbox() !== undefined && (last === undefined || options.now() - last >= options.refreshMs)) void sync();
    },
    start(context) {
      ctx = context;
      if (options.mailbox() === undefined) return;
      const waited = new Promise<void>((resolve) => (firstTimer = setTimeout(resolve, options.firstWaitMs)));
      const synced = sync();
      first = Promise.race([synced, waited]).finally(() => {
        clearTimeout(firstTimer);
        first = undefined;
      });
    },
    stop() {
      clearTimeout(firstTimer);
      ctx = undefined;
      first = undefined;
    },
  };
}
