/**
 * `answerKey`: the one formula for a run's answer key, shared by the channel that enqueues
 * the answer and whoever waits for its delivery.
 */

import { expect, test } from "bun:test";
import { answerKey } from "./outbound.ts";

test("a run's answer key is its session and the request that started the run", () => {
  expect(answerKey({ sessionId: "s1" }, "telegram:42:7")).toBe("s1:telegram:42:7");
});

test("the same run gives the same key, and another session another key", () => {
  const conversation = { key: "telegram:42", agent: "main", sessionId: "s1" };
  expect(answerKey(conversation, "r1")).toBe(answerKey({ sessionId: "s1" }, "r1"));
  expect(answerKey({ sessionId: "s2" }, "r1")).not.toBe(answerKey(conversation, "r1"));
});
