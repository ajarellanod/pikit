import { expect, test } from "bun:test";
import { createEventBus } from "./events.ts";

interface Events {
  "test.ping": { n: number };
}

test("listeners run sequentially in registration order and receive ctx", async () => {
  const errors: string[] = [];
  const bus = createEventBus<Events, { tag: string }>((_, event) => errors.push(event));
  const seen: string[] = [];

  bus.on("test.ping", async ({ n }, ctx) => {
    await new Promise((r) => setTimeout(r, 5)); // slower first listener must still finish first
    seen.push(`a${n}:${ctx.tag}`);
  });
  bus.on("test.ping", ({ n }) => {
    seen.push(`b${n}`);
  });

  await bus.emit("test.ping", { n: 1 }, { tag: "x" });

  expect(seen).toEqual(["a1:x", "b1"]);
  expect(errors).toEqual([]);
});

test("a throwing listener is reported and does not stop the others", async () => {
  const reported: { error: unknown; event: string }[] = [];
  const bus = createEventBus<Events, undefined>((error, event) => reported.push({ error, event }));
  const seen: string[] = [];

  bus.on("test.ping", () => {
    throw new Error("boom");
  });
  bus.on("test.ping", () => {
    seen.push("after");
  });

  await bus.emit("test.ping", { n: 1 }, undefined);

  expect(seen).toEqual(["after"]);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.event).toBe("test.ping");
  expect((reported[0]?.error as Error).message).toBe("boom");
});
