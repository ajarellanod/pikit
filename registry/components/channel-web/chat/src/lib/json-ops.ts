/**
 * Changes to a JSON value, as a conversation's live events send them (`live`'s ops): `applyOps` and
 * `JsonOp`, copied as they are from @pikit/contracts' `src/json-ops.ts` (`JsonValue` from its
 * `src/json.ts`), since a UI project cannot import the kit's packages. Change them there first.
 *
 * - `["r", value]`: the whole value replaced (the only op on the root).
 * - `["s", path, value]`: the member at `path` set: added or replaced (an array's index: replaced).
 * - `["d", path]`: the object member at `path` removed.
 * - `["a", path, text]`: `text` appended to the string at `path`.
 * - `["t", path, count]`: the string at `path` loses its first `count` characters.
 * - `["p", path, start, deleteCount, items]`: the array at `path` (the root's, with `[]`) spliced.
 *
 * `applyOps` copies only the containers on a changed path (what it does not change stays the same
 * object, for a view that compares by identity) and never mutates its input.
 */

/** A JSON value, read-only at every depth. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Keys and indexes from the root of a JSON value. */
export type JsonPath = readonly (string | number)[];
type NonEmptyPath = readonly [string | number, ...(string | number)[]];

/** One change to a JSON value (see the module's comment). */
export type JsonOp =
  | readonly ["r", JsonValue]
  | readonly ["s", NonEmptyPath, JsonValue]
  | readonly ["d", NonEmptyPath]
  | readonly ["a", NonEmptyPath, string]
  | readonly ["t", NonEmptyPath, number]
  | readonly ["p", JsonPath, number, number, readonly JsonValue[]];

type Container = { readonly [key: string]: JsonValue } | readonly JsonValue[];

/** `value` with `ops` applied in order. Throws on an op whose path does not lead where it says. */
export function applyOps(value: JsonValue, ops: readonly JsonOp[]): JsonValue {
  let current = value;
  for (const op of ops) current = applyOp(current, op);
  return current;
}

function applyOp(value: JsonValue, op: JsonOp): JsonValue {
  switch (op[0]) {
    case "r":
      return op[1];
    case "s":
      return update(value, op[1], 0, () => op[2], true);
    case "d":
      return remove(value, op[1], 0);
    case "a":
      return update(value, op[1], 0, (text) => stringAt(text, op[1]) + op[2], false);
    case "t":
      return update(value, op[1], 0, (text) => stringAt(text, op[1]).slice(op[2]), false);
    case "p": {
      const [, path, start, deleteCount, items] = op;
      const splice = (array: JsonValue | undefined): JsonValue => {
        if (!Array.isArray(array)) throw new Error(`json-ops: no array at ${JSON.stringify(path)}`);
        const next = [...array];
        next.splice(start, deleteCount, ...items);
        return next;
      };
      return path.length === 0 ? splice(value) : update(value, path as NonEmptyPath, 0, splice, false);
    }
  }
}

function stringAt(value: JsonValue | undefined, path: JsonPath): string {
  if (typeof value !== "string") throw new Error(`json-ops: no string at ${JSON.stringify(path)}`);
  return value;
}

/** `value` with the member at `path` replaced by `change(old)`; `create` lets the last key be new. */
function update(value: JsonValue, path: NonEmptyPath, depth: number, change: (old: JsonValue | undefined) => JsonValue, create: boolean): JsonValue {
  const container = containerAt(value, path, depth);
  const segment = path[depth] as string | number;
  const last = depth === path.length - 1;
  const old = memberOf(container, segment);
  if (old === undefined && !(last && create)) throw new Error(`json-ops: nothing at ${JSON.stringify(path.slice(0, depth + 1))}`);
  const next = last ? change(old) : update(old as JsonValue, path, depth + 1, change, create);
  return withMember(container, segment, next, path);
}

function remove(value: JsonValue, path: NonEmptyPath, depth: number): JsonValue {
  const container = containerAt(value, path, depth);
  const segment = path[depth] as string | number;
  if (depth === path.length - 1) {
    if (Array.isArray(container) || typeof segment !== "string") throw new Error(`json-ops: "d" removes an object's member, not ${JSON.stringify(path)}`);
    const { [segment]: _removed, ...rest } = container as { readonly [key: string]: JsonValue };
    return rest;
  }
  const old = memberOf(container, segment);
  if (old === undefined) throw new Error(`json-ops: nothing at ${JSON.stringify(path.slice(0, depth + 1))}`);
  return withMember(container, segment, remove(old, path, depth + 1), path);
}

function containerAt(value: JsonValue, path: JsonPath, depth: number): Container {
  if (typeof value !== "object" || value === null) throw new Error(`json-ops: no object or array at ${JSON.stringify(path.slice(0, depth))}`);
  return value;
}

function memberOf(container: Container, segment: string | number): JsonValue | undefined {
  if (Array.isArray(container)) return typeof segment === "number" ? container[segment] : undefined;
  return typeof segment === "string" && Object.hasOwn(container, segment) ? (container as { readonly [key: string]: JsonValue })[segment] : undefined;
}

function withMember(container: Container, segment: string | number, member: JsonValue, path: JsonPath): JsonValue {
  if (Array.isArray(container)) {
    if (typeof segment !== "number" || segment < 0 || segment >= container.length) throw new Error(`json-ops: no index ${String(segment)} at ${JSON.stringify(path)}`);
    const next = [...container];
    next[segment] = member;
    return next;
  }
  if (typeof segment !== "string") throw new Error(`json-ops: an object's member is named by a string, at ${JSON.stringify(path)}`);
  // A plain property even for `__proto__`: never the prototype.
  const next: Record<string, JsonValue> = { ...(container as { readonly [key: string]: JsonValue }) };
  Object.defineProperty(next, segment, { value: member, enumerable: true, writable: true, configurable: true });
  return next;
}
