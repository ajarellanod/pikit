# Postgres storage

**Public appeal:** —

**Specified:** partly (the former SPEC §4.5 named Postgres behind `storage.sql`, its §7.5 listed
`sessions-postgres`, and its §15 made the swap scenario 4)

**Needed by:** nothing required now; the former roadmap's M3 named the SQLite → Postgres swap as
its proof (scenario 4). A second provider also helps `storage.sql` and `sessions.store` become
`stable` (two independent providers, `packages/cli/src/registry/capabilities.ts`), which the
Cloudflare providers (`storage-do`, `sessions-sql`) may give as well.

## What it gives
Conversations, sessions and every component's tables in Postgres, for a managed database or
[several replicas](replicas.md).

## How it fits pikit
- `storage-postgres` provides `storage.sql` (`SqlDatabase`, async so that Postgres fits, C5)
  and passes its suite; every component's tables keep their prefixes. The suite uses only SQL both
  engines accept (`BIGINT`, `BYTEA`, `storage.ts`); the provider rewrites `?` to `$n` and returns
  `int8` values (`COUNT(*)` too) as numbers. Each SQLite-dialect consumer (`submissions-sql`,
  `outbound-durable`) ports its own store file, as its header says.
- `sessions-postgres` provides `sessions.store` and passes Pi's `createSessionRepoConformance` and
  `createStorageConformance`.
- The swap is selection or removal (`capabilities: { storage.sql: storage-postgres }`), with the
  router, channels and agents untouched (P3).
- Server only: a Worker has Durable Object SQL instead.

## Pi first
Pi's session stores are Pi's contract, and `pi-durable` publishes memory, SQLite and JSONL storage
backends. Before writing `sessions-postgres`, check whether the move to `pi-durable`'s storage
contract ([pi-durable migration](pi-durable-migration.md)) makes a Postgres backend of that contract
the thing to write, and upstream.

## Open questions
- The former scenario 4 says `remove sessions-sqlite`, but the built store is `sessions-jsonl`:
  which one does the proof swap?
- `sessions-postgres` on its own tables, or on `storage.sql`.
