# Key-value storage (`storage.kv`)

**Public appeal:** —

**Status:** built. Contract `experimental` (one provider in the registry; `stable` needs two).

**Needed by:** `channel-telegram` (its answers' cursor). Any component that keeps a few values across
restarts: a reader's cursor, a token, a setting.

## What it gives
A component keeps small JSON values by key, in a namespace of its own, without creating a table and
writing SQL for each one. What needs queries, or several records changed together, stays in the
component's own tables in `storage.sql`.

## The contract
In `@pikit/contracts` (`packages/contracts/src/storage.ts`):

```ts
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface KeyValueStorage {
  /** The namespace `name`: a component opens the one named after it. */
  namespace(name: string): KeyValueStore;
}

interface KeyValueStore {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  /** Writes only when `key` has no value; `true` when it wrote. */
  setIfAbsent(key: string, value: JsonValue): Promise<boolean>;
  delete(key: string): Promise<void>;
}

// AppCapabilities["storage.kv"]: KeyValueStorage (single)
```

- **A namespace per component**, named after it, as SQL tables are prefixed with its name. Two
  namespaces never see each other's keys, whatever their names contain.
- **Values are JSON**; a value read back is a copy. `null` is a value, a missing key is `undefined`,
  and a value that is not JSON (`undefined`, a function) is refused.
- **Each call is atomic on its own**, across processes too: of concurrent `setIfAbsent` calls for a
  missing key, exactly one writes. No transaction across calls or keys.
- Keys are any string. No NUL character, in keys or namespaces: Postgres refuses it in `TEXT`.

## How it fits pikit
- **Contract and suite first.** `createKeyValueConformance` (`@pikit/contracts/testing`, 8 cases:
  every kind of JSON value, copies, namespaces, keys with SQL pattern characters, `setIfAbsent`
  races, refused values, data that survives a restart). `createMemoryKeyValueStorage` is a memory
  storage for tests, checked by the same suite.
- **`storage-kv-sql`** provides it on `storage.sql`: one table, `storage_kv_sql_entries`
  (`namespace`, `entry_key`, `json`), created at start; one statement per call, no cache;
  `setIfAbsent` is `INSERT … ON CONFLICT DO NOTHING`. Targets `server` and `durable`.
- **Offered.** The catalogue marks `storage.kv` `offer`: `pikit add channel-telegram` brings
  `storage-kv-sql` (and `storage-sqlite` when nothing provides `storage.sql`), and so does
  `pikit add conversations-kv`, which requires it.
- **`channel-telegram`** keeps its answers' cursor at the key `answers-cursor` of its namespace. It
  reads answers from the feed only with `agent.submissions` and `storage.kv`; without either, from
  events, with a warning (absence, not flags).

## Pi first
Pi's durable documents are scoped to a session, a conversation or a task. This is a component's own
state, across conversations, which Pi does not keep. When Pi ships something that covers it, the
provider moves onto it and the contract stays.

## Where it is
- Contract: `packages/contracts/src/storage.ts`; catalogue: `packages/cli/src/registry/capabilities.ts`.
- Suite and memory storage: `packages/contracts/src/testing/storage-kv.ts` (+ `.test.ts`).
- Provider: `registry/components/storage-kv-sql/` (README, conformance, lifecycle, two processes
  over one database).
- Consumers: `registry/components/channel-telegram/` (`answers.ts`, `index.ts`) and
  `registry/components/conversations-kv/` (the conversation registry).

## Open questions
- **Upgrading `channel-telegram`.** Its old table, `channel_telegram_cursors`, is not read: a project
  that upgrades starts its cursor at the feed's end, as on a first install, so an answer that ended
  during that one deploy is not sent. Acceptable while nothing is published (`0.0.0`); a migration
  is needed if that changes first.
- **A second provider** (Durable Object storage on Cloudflare, or Postgres through
  `storage-postgres`) is what makes the contract `stable`.
- **Listing keys** (`scan(prefix)`) and expiry are left out until a consumer needs them.
