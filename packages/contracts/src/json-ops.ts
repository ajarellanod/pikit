/**
 * Changes to a JSON value, as `agent.observe`'s `watch` sends them (`ObservedEvent`'s `live`): a value
 * is sent once whole (`["r", value]`), then as the operations that turn it into each next one, so a
 * streamed answer costs its new text, not the whole answer again.
 *
 * The vocabulary is Chord's delta ops (pi-durable's), the subset a JSON value needs, so a runtime that
 * has them can pass them on; `diffOps` makes them from two values for one that does not. A path is the
 * keys (objects) and indexes (arrays) from the root.
 *
 * - `["r", value]`: the whole value replaced (the only op on the root).
 * - `["s", path, value]`: the member at `path` set: added or replaced (an array's index: replaced).
 * - `["d", path]`: the object member at `path` removed.
 * - `["a", path, text]`: `text` appended to the string at `path`.
 * - `["t", path, count]`: the string at `path` loses its first `count` characters.
 * - `["p", path, start, deleteCount, items]`: the array at `path` (the root's, with `[]`) spliced.
 *
 * Both functions are pure: `applyOps` copies only the containers on a changed path (what it does not
 * change stays the same object, for a view that compares by identity) and never mutates its input.
 */

import type { JsonValue } from "./json.ts";

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

/**
 * The ops that turn `before` into `after` (`applyOps(before, diffOps(before, after))` equals `after`);
 * none when they are equal. Strings that grew at the end are appends, strings that lost their start
 * and grew are a trim and an append (a bounded output), arrays that grew or shrank at the end are
 * splices; anything else is set whole.
 */
export function diffOps(before: JsonValue, after: JsonValue): JsonOp[] {
  if (before === after) return [];
  const ops: JsonOp[] = [];
  if (!diffInto(before, after, [], ops)) return [["r", after]];
  return ops;
}

/** Appends the ops at `path` to `ops`; `false` when only a replacement of `path` itself tells it. */
function diffInto(before: JsonValue, after: JsonValue, path: (string | number)[], ops: JsonOp[]): boolean {
  if (before === after) return true;
  if (typeof before === "string" && typeof after === "string" && path.length > 0) return diffString(before, after, path as unknown as NonEmptyPath, ops);
  if (Array.isArray(before) && Array.isArray(after)) {
    const common = Math.min(before.length, after.length);
    for (let index = 0; index < common; index++) {
      const at = [...path, index];
      if (!diffInto(before[index] as JsonValue, after[index] as JsonValue, at, ops)) ops.push(["s", at as unknown as NonEmptyPath, after[index] as JsonValue]);
    }
    if (after.length !== before.length) ops.push(["p", [...path], common, before.length - common, after.slice(common)]);
    return true;
  }
  if (isObject(before) && isObject(after)) {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) ops.push(["d", [...path, key] as unknown as NonEmptyPath]);
    for (const [key, value] of Object.entries(after)) {
      const at = [...path, key];
      if (!Object.hasOwn(before, key)) ops.push(["s", at as unknown as NonEmptyPath, value]);
      else if (!diffInto(before[key] as JsonValue, value, at, ops)) ops.push(["s", at as unknown as NonEmptyPath, value]);
    }
    return true;
  }
  return false;
}

function diffString(before: string, after: string, path: NonEmptyPath, ops: JsonOp[]): boolean {
  if (after.startsWith(before)) {
    ops.push(["a", path, after.slice(before.length)]);
    return true;
  }
  // A bounded output: its start dropped, text appended. Look for where the kept part starts.
  const probe = after.slice(0, Math.min(after.length, 32));
  if (probe.length === 0) return false;
  for (let start = before.indexOf(probe, 1); start !== -1; start = before.indexOf(probe, start + 1)) {
    const kept = before.length - start;
    if (kept <= after.length && after.startsWith(before.slice(start))) {
      ops.push(["t", path, start]);
      if (kept < after.length) ops.push(["a", path, after.slice(kept)]);
      return true;
    }
  }
  return false;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
