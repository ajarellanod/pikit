# sessions-sql

Each conversation's Pi session in the app's SQL database, so the same project keeps its sessions on a
server (SQLite) and in a Cloudflare Durable Object (its SQL) alike.

```sh
pikit add storage-sqlite      # on a server: the database it keeps its sessions in
pikit add sessions-sql
```

- **Provides:** `sessions.store`.
- **Requires:** `storage.sql`.
- **Targets:** `server` and `cloudflare` (it imports nothing platform-specific).
- **Installs to:** `src/pikit/sessions-sql/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

It replaces `sessions-jsonl`: install one or the other. Sessions already in JSONL files are not
copied into the database.

## Transitional

This component bridges a gap until Pi's durable runtime (`pi-durable`) carries pikit's runs. Then
sessions are that runtime's own storage, and this component is removed (SPEC P1: when Pi ships what
pikit built, pikit deletes its own). Until then it gets fixes, not features: see
`features/pi-durable-migration.md` for what replaces it and when. It also carries two small helpers
copied from Pi (usage sums and the branch a fork keeps), which must follow Pi's upgrades.

## What it does

The store is `@pikit/pi-adapter/sql`'s: Pi's own session over a `Storage` whose every commit is one
`storage.sql` transaction. A session holds a conversation's transcript, its inbox of queued messages,
its open runs and its values, as with `sessions-jsonl`. This component creates or upgrades the tables
at start, and closes the sessions still open at stop.

- **Nothing is kept in memory.** Every read and commit goes to the database, so a restart, a crash or
  a Durable Object's eviction loses only what was never committed, as Pi expects.
- **`find(id)` is one query**, so the runtime opens a conversation's session without listing them.
- **One process per session.** A session is open once per process, as Pi's repositories enforce: one
  server over its database, or the Durable Object that owns the conversation. Two processes opening
  the same session are not detected; run one server replica over one database.
- **A fork is one transaction** copying rows in SQL, following Pi's fork rules.

## The tables

Every table is prefixed `sessions_sql_`; `sessions_sql_meta.schema_version` says which version of the
schema the database is at, and each start brings it up to date, one transaction per step. A database
written by a newer version is refused (the app does not start).

| Table | One row per |
|---|---|
| `sessions_sql_sessions` | session: `id`, `created_at`, `cwd`, `parent_session_id`, its next sequence number and its totals (`message_count`, `usage_json`) |
| `sessions_sql_entries` | entry of the tree: `id`, `parent_id`, `seq`, `type`, `custom_type`, `timestamp_ms`, and the entry as JSON |
| `sessions_sql_usage` | usage row (tokens and cost) |
| `sessions_sql_values` | value Pi keeps by address (`namespace`, `address_key`): branch tips, lane state, the name, labels, open runs |
| `sessions_sql_lists` | element of a list (`namespace`, `address_key`, `seq`) |
| `sessions_sql_chunks` | part of a record too large for one row (see below) |

```sh
sqlite3 .pikit/pikit.db "SELECT id, datetime(created_at / 1000, 'unixepoch'), message_count FROM sessions_sql_sessions ORDER BY created_at DESC LIMIT 10"
```

## Durable Object limits

A Durable Object's SQL refuses a row over 2 MB, a statement over 100 KB or with more than 100 bound
parameters, and `LIKE`/`GLOB` patterns over about 50 bytes. The store stays within them:

- a record (an entry carrying an image, a queued message) is stored inline up to 256 Ki UTF-16 units
  (at most 768 KB), and in parts of that size in `sessions_sql_chunks` beyond it, so there is no
  limit on one entry's size but the object's memory;
- ids are bound in batches of 90, every statement is a constant, and a key prefix is a range.

Its tests hold every statement to these limits.

## Config

```ts
"sessions-sql": {
  cwd: "/srv/agent", // optional: the working directory recorded in each new session
}
```

Pi extensions read `cwd` as `ctx.cwd`; without it, a session records none, and they see `/`.
(`sessions-jsonl` records the server's working directory.)

## Tests

`sessions-sql.test.ts` is copied with the component and runs in your project, on a SQLite file that
refuses every statement a Durable Object would. It covers:
- Pi's own session suites over the store this component provides: `createSessionRepoConformance`,
  the fork cases Pi runs for its own repositories (`createSessionRepoStreamingForkConformance`), and
  `createStorageConformance`. Every case passes;
- the lifecycle conformance suite;
- a session outliving the process, the tables, and a database from a newer version refused.

`runtime-pi`'s tests run the `agent.runtime` conformance on these sessions too, including a worker
killed mid-run whose run the next one resumes.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
