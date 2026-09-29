/**
 * JSON, as the contracts carry it: what `storage.kv` keeps, what `actor.mailbox` sends, what
 * `agent.state` holds. One definition, so that two contracts never disagree on what JSON is.
 */

/** A JSON value, read-only at every depth. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Whether `value` is a plain JSON object whose values are all JSON, at every depth: what `agent.state`
 * holds and what a patch may contain. A plain object has `Object.prototype` or `null` as prototype (a
 * class instance, a `Date`, a `Map` is not one); a number must be finite (`NaN` and `Infinity` are not
 * JSON); `undefined`, a function, a symbol or a bigint anywhere makes it not JSON.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(value).every(isJson);
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonObject(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
