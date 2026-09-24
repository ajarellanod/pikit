/**
 * A JSON-lines `Logger` (SPEC §4.5 `logger`) for a container: one JSON object per line, so
 * `docker compose logs` and `pikit logs` can be filtered by level or field (`jq`, a log shipper).
 *
 *   {"time":"2026-01-01T00:00:00.000Z","level":"info","msg":"pikit: started","components":15}
 *
 * - `debug` and `info` go to stdout, `warn` and `error` to stderr; Docker keeps both.
 * - A field is data, never interpolated into the message. An `Error` keeps its name, message,
 *   stack and cause, which `JSON.stringify` alone would drop.
 * - A field whose name looks like a secret (`token`, `accessToken`, `authorization`, `apiKey`,
 *   `password`…) is written as `"[redacted]"`, at any depth (SPEC §13: logs redact by name). Names
 *   are compared word by word, so counts such as `totalTokens` or `tokenCount` stay readable. This
 *   is a net, not a guarantee: never put a secret's value in a message or under an innocent name.
 * - Logging never throws. A field that cannot be serialized (a cycle, a `BigInt`, a throwing
 *   getter) is replaced, and the line is still written: a log call must not fail the code that
 *   made it.
 */

import type { Logger } from "@pikit/core";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A word anywhere in the name makes it a secret's name: `clientSecret`, `cookieJar`, `credentials`. */
const SECRET_WORDS = new Set(["secret", "secrets", "password", "passwd", "authorization", "cookie", "cookies", "credential", "credentials"]);

/**
 * Whether a field's name looks like a secret's. Compared word by word (camelCase, snake_case,
 * kebab-case), not as a substring: `token`, `accessToken` and `PIKIT_HTTP_TOKEN` end in the word
 * `token` and are secrets; `totalTokens` and `tokenCount` are counts. `apiKey` and `privateKey` are
 * secrets; a bare `key` (a conversation key) is not.
 */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  const last = words.at(-1);
  const before = words.at(-2);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  if (last === "token" || last === "apikey") return true;
  return last === "key" && (before === "api" || before === "private");
}

/** Keys every line has; a field with the same name is written as `field.<name>` instead. */
const RESERVED = new Set(["time", "level", "msg"]);

/** Deeper values are cut: a log line is not a dump. */
const MAX_DEPTH = 8;

export interface JsonLoggerOptions {
  /** Lines below this level are dropped. Default: `"info"`. */
  level?: LogLevel;
  /** Where a finished line goes. Default: `console.log` (debug, info) or `console.error` (warn, error). */
  write?(line: string, level: LogLevel): void;
  /** The time of a line. Default: now. */
  now?(): Date;
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? "info"];
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[level] < threshold) return;
    let line: string;
    try {
      line = format(now().toISOString(), level, message, fields);
    } catch (error) {
      // Only reachable if the clock or the message itself is broken; still write something.
      line = JSON.stringify({ time: safeTime(), level, msg: String(message), logError: describeFailure(error) });
    }
    try {
      write(line, level);
    } catch {
      // A closed stdout must not crash the caller; there is nowhere left to report it.
    }
  };

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

function format(time: string, level: LogLevel, message: string, fields: Record<string, unknown> | undefined): string {
  const record: Record<string, unknown> = { time, level, msg: String(message) };
  if (fields !== undefined && fields !== null && typeof fields === "object") {
    for (const key of Object.keys(fields)) record[RESERVED.has(key) ? `field.${key}` : key] = safeRead(fields, key);
  }
  // `sanitize` redacts by name, so a secret field is redacted here too.
  return JSON.stringify(sanitize(record, 0, new WeakSet()));
}

/** A JSON-safe copy: cycles, errors, bigints, functions and symbols made readable, secrets redacted. */
function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return undefined;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value !== "object") return String(value);

  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  seen.add(value);
  try {
    if (value instanceof Error) return sanitizeError(value, depth, seen);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof URL) return value.href;
    // A body or a buffer would become one key per byte.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[${value.byteLength} bytes]`;
    if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen) ?? null);
    if (value instanceof Map) return sanitizeEntries([...value.entries()].map(([k, v]) => [String(k), v]), depth, seen);
    if (value instanceof Set) return [...value].map((item) => sanitize(item, depth + 1, seen) ?? null);
    return sanitizeEntries(
      Object.keys(value).map((key) => [key, safeRead(value, key)]),
      depth,
      seen,
    );
  } catch (error) {
    // A proxy that refuses to list its keys, an iterator that throws: one field is lost, not the line.
    return `[unreadable: ${describeFailure(error)}]`;
  } finally {
    // A value seen twice side by side is not a cycle; only an ancestor is.
    seen.delete(value);
  }
}

function sanitizeEntries(entries: [string, unknown][], depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) out[key] = isSecretName(key) ? "[redacted]" : sanitize(item, depth + 1, seen);
  return out;
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: safeRead(error, "name"),
    message: safeRead(error, "message"),
    stack: safeRead(error, "stack"),
  };
  // An AggregateError (a stop that failed in several components) lists every failure.
  if (error instanceof AggregateError) out.errors = sanitize(safeRead(error, "errors"), depth + 1, seen);
  if ("cause" in error) out.cause = sanitize(safeRead(error, "cause"), depth + 1, seen);
  // Own fields such as `code` (`EADDRINUSE`) say what went wrong.
  for (const [key, item] of Object.entries(sanitizeEntries(Object.keys(error).map((k) => [k, safeRead(error, k)]), depth, seen))) {
    out[key] ??= item;
  }
  return out;
}

/** A getter that throws becomes a note instead of an exception. */
function safeRead(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch (error) {
    return `[unreadable: ${describeFailure(error)}]`;
  }
}

function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown";
  }
}

function safeTime(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}
