# Proposal for pi-durable: a table prefix for `SqliteStorage`

Status: draft for upstream (`@earendil-works/pi-durable`, against 1.0.0). From pikit, whose
components share one SQL database per app (a SQLite file on a server, a Durable Object's SQLite on
Cloudflare).

## Problem

`SqliteStorage` creates fixed, unprefixed tables: `durable_schema`, `durable_metadata`, `record_ids`,
`conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`.
`SqliteStorage.open(db)` takes no options.

An app that shares its database with anything else (its own tables, other libraries) must avoid
those names, several of them generic (`conversations`, `submissions`, `tasks`, `documents`). And one
database can hold only one pi-durable Session: two Harnesses (two agents kept apart, a test fixture
beside the real one) need two databases. On a Durable Object there is exactly one SQLite database,
so that is not a choice.

## Evidence

The table names are in pi-durable's `storage/sqlite/migrations.js`; `SqliteStorage.open(db:
SqliteDatabase)` in `storage/sqlite/storage.d.ts`. pikit's `storage.sql` contract asks every
component to prefix its tables; pikit's facade documents the exception
(`packages/pi-adapter/src/README.md`, "Limits and open questions").

## pikit's workaround

None in code: a documented exception. No pikit component uses those names today, and a pikit app
holds one pi-durable Session per `storage.sql` (one Harness per server, one per Durable Object). A
user's own table named `tasks` or `documents` would collide.

## Proposal

```ts
class SqliteStorage {
  static open(db: SqliteDatabase, options?: { readonly tablePrefix?: string }): Promise<SqliteStorage>;
}
```

- `tablePrefix` (default `""`, today's names) is prepended to every table and index name, migrations
  included; it must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- The schema version table is per prefix, so two Sessions with different prefixes migrate
  independently in one database.
- Opening an existing database with a different prefix than it was created with finds no tables and
  creates new ones; renaming is the app's migration, not pi-durable's.

A later major could default to a prefix (`pi_`), with a migration that renames the 1.0 tables.

## Compatibility

Additive with the default `""`. The storage conformance suite would run once with a prefix.
