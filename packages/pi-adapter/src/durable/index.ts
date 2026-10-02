// Public surface of @pikit/pi-adapter/durable: pi-durable 1.0 on `storage.sql` (spike, see README.md).
// Neutral: it runs on a server (storage-sqlite) and in a Cloudflare Durable Object (storage-do) alike.

export { openDurableStorage, type SqliteDatabase, SqliteStorage, splitSqlStatements, sqliteDatabaseFrom } from "./sql.ts";
