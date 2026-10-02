# Postgres storage

**Public appeal:** —

**Specified:** partly (the former SPEC §4.5 named Postgres behind `storage.sql`, its §7.5 listed
`sessions-postgres`, and its §15 made the swap scenario 4)

**Needed by:** nothing required now; the former roadmap's M3 named the SQLite → Postgres swap as
its proof (scenario 4). A second provider also helps `storage.sql` become
`stable` (two independent providers, `packages/cli/src/registry/capabilities.ts`), which the
Cloudflare provider (`storage-do`) may give as well. (`sessions.store` and its providers are
removed with the [move to pi-durable](pi-durable-migration.md).)

## What it gives
Conversations, sessions and every component's tables in Postgres, for a managed database or
[several replicas](replicas.md).

## How it fits pikit
- `storage-postgres` provides `storage.sql` (`SqlDatabase`, async so that Postgres fits, C5)
  and passes its suite; every component's tables keep their prefixes. The suite uses only SQL both
  engines accept (`BIGINT`, `BYTEA`, `storage.ts`); the provider rewrites `?` to `$n` and returns
  `int8` values (`COUNT(*)` too) as numbers. Each SQLite-dialect consumer (`submissions-sql`,
  `outbound-durable`) ports its own store file, as its header says.
- The runtime's state is pi-durable's storage, which pikit runs over `storage.sql` through its SQLite
  core. A Postgres `storage.sql` cannot host that core as it is: conversations in Postgres need a
  Postgres backend of pi-durable's `Storage`, passing pi-durable's storage conformance (below).
- The swap is selection or removal (`capabilities: { storage.sql: storage-postgres }`), with the
  router, channels and agents untouched (P3).
- Server only: a Worker has Durable Object SQL instead.

## Pi first
Conversation storage is Pi's contract: `pi-durable` publishes memory, SQLite and JSONL storage
backends and a storage conformance suite. A Postgres backend of that contract is the thing to write,
and upstream, rather than a pikit store.

## Open questions
- The former scenario 4 says `remove sessions-sqlite`; with sessions gone, the proof swaps
  `storage-sqlite`, and needs pi-durable on Postgres first.
- pi-durable's Postgres backend on its own connection, or on `storage.sql` (whose tables would then
  need the prefix pi-durable lacks, `docs/upstream/pi-durable-table-prefix.md`).
