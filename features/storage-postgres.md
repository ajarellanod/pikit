# Postgres storage

**Public appeal:** —

**Specified:** partly (SPEC §4.5 names Postgres behind `storage.sql`; SPEC §7.5 lists
`sessions-postgres`; SPEC §15, scenario 4)

**Needed by:** ROADMAP M3 names the SQLite → Postgres swap as its proof (scenario 4). A second
provider also helps `storage.sql` and `sessions.store` become `stable` (S12), which M4's Durable
Object providers may give as well.

## What it gives
Conversations, sessions and every component's tables in Postgres, for a managed database or
[several replicas](replicas.md).

## How it fits pikit
- `storage-postgres` provides `storage.sql` (`SqlDatabase`, async so that Postgres fits, SPEC §16)
  and passes its suite; every component's tables keep their prefixes.
- `sessions-postgres` provides `sessions.store` and passes Pi's `createSessionRepoConformance` and
  `createStorageConformance` (SPEC §7.5).
- The swap is selection or removal (`capabilities: { storage.sql: storage-postgres }`), with the
  router, channels and agents untouched (S3, scenario 4).
- Server only: a Worker has Durable Object SQL instead.

## Pi first
Pi's session stores are Pi's contract, and `pi-durable` publishes memory, SQLite and JSONL storage
backends. Before writing `sessions-postgres`, check whether the move to `pi-durable`'s storage
contract (SPEC §6.4) makes a Postgres backend of that contract the thing to write, and upstream.

## Open questions
- Scenario 4 says `remove sessions-sqlite`, but the built store is `sessions-jsonl`: which one does
  the proof swap?
- `sessions-postgres` on its own tables, or on `storage.sql`.
