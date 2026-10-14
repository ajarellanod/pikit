/**
 * better-auth's database over pikit's `storage.sql` (features/channel-web.md, "Accounts: better-auth").
 *
 * - **The adapter** (`sqlAdapter`): `createAdapterFactory` over `SqlDatabase`'s `query` / `run`, in
 *   the SQL subset SQLite and Postgres share (`?` parameters, `RETURNING`, no `AUTOINCREMENT`, no
 *   `LIKE`: a Durable Object fails it on long patterns, so text matching is `substr` / `replace`).
 *   Dates are ISO text (`supportsDates: false`; ISO strings of one format order as the dates do),
 *   booleans 0/1, JSON and arrays text. Identifiers are double-quoted, so better-auth's camelCase
 *   field names are the columns' names on both databases.
 * - **No transactions** (`transaction: false`): `storage.sql`'s transaction runs statements only, and
 *   better-auth would run password hashing and our email callback inside its own. Its multi-step
 *   writes run one statement at a time; each one stands alone (a user, then their account), so a
 *   crash between two leaves a user who can sign in again or be removed.
 * - **The tables** (`migrate`): `channel_web_user`, `channel_web_session`, `channel_web_account`,
 *   `channel_web_verification`, made with `CREATE TABLE IF NOT EXISTS` at first use. `MODEL_NAMES`
 *   maps better-auth's models onto them. The user has three fields of ours: `banned`, `invitedAt`
 *   and `lastSeenAt` (`local.ts`).
 */

import type { SqlDatabase, SqlRow, SqlValue } from "@pikit/contracts";
import { type CleanedWhere, createAdapterFactory } from "better-auth/adapters";

export const USER_TABLE = "channel_web_user";
export const SESSION_TABLE = "channel_web_session";
export const ACCOUNT_TABLE = "channel_web_account";
export const VERIFICATION_TABLE = "channel_web_verification";

/** better-auth's `user.modelName` and the others: its models on our tables. */
export const MODEL_NAMES = {
  user: { modelName: USER_TABLE },
  session: { modelName: SESSION_TABLE },
  account: { modelName: ACCOUNT_TABLE },
  verification: { modelName: VERIFICATION_TABLE },
} as const;

/**
 * Makes the tables and their indexes, if they are not there. Idempotent: called at first use.
 * Columns are better-auth's fields (`get-tables.ts` at 1.7.7) and ours (`banned`, `invitedAt`, `lastSeenAt`).
 */
export async function migrate(sql: Pick<SqlDatabase, "run">): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${USER_TABLE} (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "emailVerified" INTEGER NOT NULL,
      "image" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "banned" INTEGER, "invitedAt" TEXT, "lastSeenAt" TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS channel_web_user_email ON ${USER_TABLE} ("email")`,
    `CREATE INDEX IF NOT EXISTS channel_web_user_created ON ${USER_TABLE} ("createdAt", "id")`,
    `CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
      "id" TEXT PRIMARY KEY, "expiresAt" TEXT NOT NULL, "token" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS channel_web_session_token ON ${SESSION_TABLE} ("token")`,
    `CREATE INDEX IF NOT EXISTS channel_web_session_user ON ${SESSION_TABLE} ("userId")`,
    `CREATE TABLE IF NOT EXISTS ${ACCOUNT_TABLE} (
      "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL,
      "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" TEXT,
      "refreshTokenExpiresAt" TEXT, "scope" TEXT, "password" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS channel_web_account_user ON ${ACCOUNT_TABLE} ("userId")`,
    `CREATE INDEX IF NOT EXISTS channel_web_account_provider ON ${ACCOUNT_TABLE} ("providerId", "accountId")`,
    `CREATE TABLE IF NOT EXISTS ${VERIFICATION_TABLE} (
      "id" TEXT PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL, "expiresAt" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS channel_web_verification_identifier ON ${VERIFICATION_TABLE} ("identifier")`,
  ];
  for (const statement of statements) await sql.run(statement);
}

/** A double-quoted identifier (SQLite and Postgres alike). */
export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A value as `storage.sql` binds it: what the factory left as a boolean, a date or an object too. */
function bind(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" || typeof value === "number" || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

const TEXT = "CAST(? AS TEXT)";

/** One clause as SQL, its parameters appended to `params`. */
function clause(where: CleanedWhere, params: SqlValue[]): string {
  const column = quote(where.field);
  const { operator, value } = where;
  const strings = typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
  const insensitive = where.mode === "insensitive" && strings;
  const lhs = insensitive ? `LOWER(${column})` : column;
  const operand = (v: unknown): SqlValue => (insensitive && typeof v === "string" ? v.toLowerCase() : bind(v));

  switch (operator) {
    case "in":
    case "not_in": {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) return operator === "in" ? "1 = 0" : "1 = 1";
      for (const v of values) params.push(operand(v));
      return `${lhs} ${operator === "in" ? "IN" : "NOT IN"} (${values.map(() => "?").join(", ")})`;
    }
    case "contains": {
      const text = String(operand(value) ?? "");
      if (text === "") return `${column} IS NOT NULL`;
      params.push(text);
      return `length(replace(${lhs}, ${TEXT}, '')) < length(${lhs})`;
    }
    case "starts_with":
      params.push(operand(value), operand(value));
      return `substr(${lhs}, 1, length(${TEXT})) = ${TEXT}`;
    case "ends_with":
      params.push(operand(value), operand(value), operand(value));
      return `(length(${lhs}) >= length(${TEXT}) AND substr(${lhs}, length(${lhs}) - length(${TEXT}) + 1) = ${TEXT})`;
    case "ne":
      if (value === null) return `${column} IS NOT NULL`;
      params.push(operand(value));
      return `${lhs} <> ?`;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (value === null) return "1 = 0";
      params.push(bind(value));
      const sign = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[operator];
      return `${column} ${sign} ?`;
    }
    case "eq":
      if (value === null) return `${column} IS NULL`;
      params.push(operand(value));
      return `${lhs} = ?`;
    default:
      throw new Error(`channel-web: the accounts' database has no operator ${String(operator)}`);
  }
}

/**
 * A `WHERE` clause (with its keyword) or `""`. As better-auth's SQL adapter: every `AND` clause, and
 * the `OR` clauses as one group, `a AND b AND (c OR d)`.
 */
export function whereSql(where: readonly CleanedWhere[] | undefined, params: SqlValue[]): string {
  if (where === undefined || where.length === 0) return "";
  const and: string[] = [];
  const or: string[] = [];
  for (const w of where) (w.connector === "OR" ? or : and).push(clause(w, params));
  if (or.length > 0) and.push(`(${or.join(" OR ")})`);
  return ` WHERE ${and.join(" AND ")}`;
}

export type SqlAdapterOptions = {
  /** The database, ready (its tables made): called before each statement. */
  database: () => SqlDatabase | Promise<SqlDatabase>;
};

/** better-auth's `database` option: our tables over `storage.sql`. */
export function sqlAdapter(options: SqlAdapterOptions) {
  return createAdapterFactory({
    config: {
      adapterId: "pikit-storage-sql",
      adapterName: "pikit storage.sql",
      usePlural: false,
      supportsDates: false,
      supportsBooleans: false,
      supportsJSON: false,
      supportsArrays: false,
      supportsNumericIds: false,
      transaction: false,
    },
    adapter: ({ getFieldName }) => {
      const query = async (statement: string, params: SqlValue[]): Promise<SqlRow[]> =>
        (await options.database()).query(statement, params);
      const run = async (statement: string, params: SqlValue[]): Promise<number> =>
        (await options.database()).run(statement, params).then((r) => r.changes);
      const columns = (modelKey: string, select: string[] | undefined): string =>
        select === undefined || select.length === 0 ? "*" : select.map((field) => quote(getFieldName({ model: modelKey, field }))).join(", ");
      const assignments = (values: Record<string, unknown>, params: SqlValue[]): string[] =>
        Object.entries(values)
          .filter(([, v]) => v !== undefined)
          .map(([column, v]) => {
            params.push(bind(v));
            return `${quote(column)} = ?`;
          });

      return {
        async create({ model, data }) {
          const entries = Object.entries(data).filter(([, v]) => v !== undefined);
          const params = entries.map(([, v]) => bind(v));
          const [row] = await query(
            `INSERT INTO ${quote(model)} (${entries.map(([k]) => quote(k)).join(", ")}) VALUES (${entries.map(() => "?").join(", ")}) RETURNING *`,
            params,
          );
          return row as never;
        },
        async findOne({ model, modelKey = model, where, select, join }) {
          const params: SqlValue[] = [];
          const [row] = await query(
            `SELECT ${join === undefined ? columns(modelKey, select) : "*"} FROM ${quote(model)}${whereSql(where, params)} LIMIT 1`,
            params,
          );
          return (row ?? null) as never;
        },
        async findMany({ model, modelKey = model, where, limit, select, sortBy, offset, join }) {
          const params: SqlValue[] = [];
          let statement = `SELECT ${join === undefined ? columns(modelKey, select) : "*"} FROM ${quote(model)}${whereSql(where, params)}`;
          if (sortBy !== undefined) {
            statement += ` ORDER BY ${quote(getFieldName({ model: modelKey, field: sortBy.field }))} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
          }
          statement += " LIMIT ?";
          params.push(limit);
          if (offset !== undefined && offset > 0) {
            statement += " OFFSET ?";
            params.push(offset);
          }
          return (await query(statement, params)) as never;
        },
        async count({ model, where }) {
          const params: SqlValue[] = [];
          const [row] = await query(`SELECT COUNT(*) AS "count" FROM ${quote(model)}${whereSql(where, params)}`, params);
          return Number(row?.count ?? 0);
        },
        async update({ model, where, update }) {
          if (where.length === 0) return null;
          const params: SqlValue[] = [];
          const set = assignments(update as Record<string, unknown>, params);
          const condition = whereSql(where, params);
          const [row] =
            set.length === 0
              ? await query(`SELECT * FROM ${quote(model)}${condition} LIMIT 1`, params)
              : await query(`UPDATE ${quote(model)} SET ${set.join(", ")}${condition} RETURNING *`, params);
          return (row ?? null) as never;
        },
        async updateMany({ model, where, update }) {
          const params: SqlValue[] = [];
          const set = assignments(update, params);
          if (set.length === 0) return 0;
          return run(`UPDATE ${quote(model)} SET ${set.join(", ")}${whereSql(where, params)}`, params);
        },
        async delete({ model, where }) {
          if (where.length === 0) return;
          const params: SqlValue[] = [];
          await run(`DELETE FROM ${quote(model)}${whereSql(where, params)}`, params);
        },
        async deleteMany({ model, where }) {
          const params: SqlValue[] = [];
          return run(`DELETE FROM ${quote(model)}${whereSql(where, params)}`, params);
        },
        async consumeOne({ model, where }) {
          // One statement: of two concurrent consumers, one deletes the row, the other none.
          const params: SqlValue[] = [];
          const [row] = await query(
            `DELETE FROM ${quote(model)} WHERE "id" = (SELECT "id" FROM ${quote(model)}${whereSql(where, params)} LIMIT 1) RETURNING *`,
            params,
          );
          return (row ?? null) as never;
        },
        async incrementOne({ model, where, increment, set }) {
          const params: SqlValue[] = [];
          const changes = Object.entries(increment).map(([column, delta]) => {
            params.push(delta);
            return `${quote(column)} = COALESCE(${quote(column)}, 0) + ?`;
          });
          changes.push(...assignments(set ?? {}, params));
          if (changes.length === 0) return null;
          // The guard is checked again in the statement that writes, so it holds when it writes.
          const guard = whereSql(where, params);
          const select = whereSql(where, params);
          const [row] = await query(
            `UPDATE ${quote(model)} SET ${changes.join(", ")}${guard}${guard === "" ? " WHERE" : " AND"} "id" = (SELECT "id" FROM ${quote(model)}${select} LIMIT 1) RETURNING *`,
            params,
          );
          return (row ?? null) as never;
        },
      };
    },
  });
}
