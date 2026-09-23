import { expect, test } from "bun:test";
import {
  BACKGROUND_CONTEXT,
  type Context,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
} from "./context.ts";

test("values are looked up through parents; a child shadows without changing the parent", () => {
  const TENANT = createContextKey<string>("tenant");
  const ACTOR = createContextKey<string>("actor");
  const parent = withContextValue(TENANT, "acme", BACKGROUND_CONTEXT);
  const child = withContextValue(ACTOR, "u1", withContextValue(TENANT, "globex", parent));

  expect(child.value(TENANT)).toBe("globex");
  expect(child.value(ACTOR)).toBe("u1");
  expect(parent.value(TENANT)).toBe("acme");
  expect(parent.value(ACTOR)).toBeUndefined();
  // Keys are identities, not names.
  expect(child.value(createContextKey<string>("tenant"))).toBeUndefined();
});

test("cancellation flows from parent to child, never from child to parent", () => {
  const outer = new AbortController();
  const parent = withAbortSignal(outer.signal, BACKGROUND_CONTEXT);
  const { context: child, cancel } = withCancel(parent);

  cancel("done");
  expect(child.abortSignal?.aborted).toBe(true);
  expect(parent.abortSignal?.aborted).toBe(false);

  const sibling = withCancel(parent).context;
  outer.abort();
  expect(sibling.abortSignal?.aborted).toBe(true);
  expect(BACKGROUND_CONTEXT.abortSignal).toBeUndefined();
});

test("a foreign context of the same shape keeps its cancellation when derived", () => {
  // Stands in for a Chord context: only the shape is shared, not the implementation.
  const controller = new AbortController();
  const foreign: Context = {
    abortSignal: controller.signal,
    value: () => undefined,
    toString: () => "foreign",
  };
  const derived = withContextValue(createContextKey<number>("n"), 1, foreign);

  expect(derived.abortSignal).toBe(controller.signal);
  expect(String(derived)).toBe("foreign.WithValue(n)");
});
