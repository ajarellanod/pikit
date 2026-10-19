# storage-sqlite

The app's SQL database in one SQLite file. It provides portable `storage.sql` and SQLite-specific
`storage.sqlite` over the same database. Components create their own tables, prefixed with their
name (`outbound_durable_pieces`), which `pikit registry validate` checks. The runtime and outbox need
`storage.sqlite`; other record stores only need `storage.sql`.

```sh
pikit add storage-sqlite
```

It uses `node:sqlite`, which Bun and Node >= 22 both ship: no native module to install.

## What it does

- **One file**, `.pikit/pikit.db` by default. In Docker, `.pikit/` is the volume, so the database
  survives `down`, `up` and new images.
- **One connection, one statement at a time.** A transaction is never interleaved with anything, and
  a statement outside it never sees half of it. A transaction runs statements only (the contract):
  no network call inside one.
- **WAL mode**, so you can read the file from a shell (`sqlite3 .pikit/pikit.db`) while the app runs,
  and a `busy_timeout` for the moment another process holds a lock.
- **It refuses to start** when the path cannot be created or the file is not a SQLite database.
- **Stopping** waits for the statement in flight, within the stop deadline, then closes the file.

## Config

```ts
"storage-sqlite": {
  path: ".pikit/pikit.db",   // relative to the working directory
  busyTimeoutMs: 5000,       // how long a statement waits for another process's lock
}
```

## Removing it

`pikit remove storage-sqlite` refuses while a component requires `storage.sql` or `storage.sqlite`. The file stays: it is
your data, and deleting it is yours to do.

## Tests

Copied with the component, they run in your project: both SQL conformance suites (values, bound
parameters, transactions, isolation, persistence, generated ids, non-reused sequence ids, upserts
and `RETURNING`), the lifecycle suite, and the start failures.
