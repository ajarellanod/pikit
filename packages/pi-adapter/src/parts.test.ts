/**
 * Parts from a tool to the user: `withParts` on a tool's result, collected by the runtime into
 * `AgentResult.parts`, kept in `agent.submissions`' `answers`, and delivered by `startAnswerDelivery`
 * (folded into the text where the transport does not draw them). The kind is the test's own, as a
 * component declares its own (`AppMessageParts`).
 */

import { afterEach, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { type AnswerDelivery, type ChannelTransport, type MessagePart, type OutboundPiece, startAnswerDelivery } from "@pikit/contracts";
import { createMemoryKeyValueStorage } from "@pikit/contracts/testing";
import type { DurableTool } from "./agent.ts";
import { PARTS_DETAIL, partsOfToolResult, withParts } from "./parts.ts";
import type { DurableMessage } from "./result.ts";
import { databaseFile, openWorker, scriptedAgent } from "./test-support.ts";

/** A part of a kind only this test knows. */
const part = (type: string, fallback: string, fields: Record<string, unknown> = {}): MessagePart => ({ type, fallback, ...fields }) as unknown as MessagePart;
const CARD = part("test-card", "A card: pick yes or no", { options: ["yes", "no"] });

/** The tool `card`: gives `CARD` to its run's answer, and ends the run when `terminate` (as `ask_user` does). */
function cardTool(terminate = false): DurableTool {
  return defineTool({
    name: "card",
    description: "Gives the answer a card.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => withParts({ output: [{ type: "text", text: "Card given." }], ...(terminate && { control: { terminate: true as const } }) }, [CARD]),
  }) as unknown as DurableTool;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function worker(tool: DurableTool) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const w = await openWorker(file.path, { agents: [scriptedAgent(["card"])], tools: { card: tool } });
  cleanup.push(w.close);
  return w;
}

/** Delivers the worker's answers to a transport that records its pieces and draws `draws`. */
async function deliver(w: Awaited<ReturnType<typeof worker>>, draws?: readonly string[]) {
  const sent: OutboundPiece[] = [];
  const transport: ChannelTransport = {
    idempotent: true,
    ...(draws !== undefined && { draws }),
    split: (text) => [text],
    send: async (piece) => (sent.push(piece), { platformMessageId: String(sent.length) }),
  };
  const delivery: AnswerDelivery = await startAnswerDelivery(w.ctx, {
    name: "channel-test",
    answers: w.runtime.submissions.answers,
    store: createMemoryKeyValueStorage().namespace("channel-test"),
    transports: new Map([["chat", transport]]),
    route: () => "chat",
    text: (answer) => (answer.kind === "completed" && (answer.text ?? "") !== "" ? answer.text : undefined),
    policy: { retryMs: [20], blockedAfter: 3, window: 50, piecesPerRun: 20, sendTimeoutMs: 1_000 },
  });
  cleanup.push(() => delivery.stop());
  return sent;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test("withParts: the parts in the result's details, next to its own; a part without a kind or a fallback, or details that are no object, refused", () => {
  expect<unknown>(withParts({ details: { lines: 3 } }, [CARD]).details).toEqual({ lines: 3, [PARTS_DETAIL]: [CARD] });
  expect<unknown>(withParts({}, [CARD]).details).toEqual({ [PARTS_DETAIL]: [CARD] });
  // As JSON keeps it: an undefined field goes.
  expect(withParts({}, [part("test-card", "x", { note: undefined })]).details).toEqual({ [PARTS_DETAIL]: [{ type: "test-card", fallback: "x" }] });
  expect(() => withParts({}, [{ type: "test-card" } as unknown as MessagePart])).toThrow(/no fallback/);
  expect(() => withParts({}, [{ type: "", fallback: "x" } as unknown as MessagePart])).toThrow(/no type/);
  expect(() => withParts({ details: ["a list"] }, [CARD])).toThrow(/JSON object/);
});

test("partsOfToolResult: a successful tool result's parts, in order; none from an error result, another message, or what is no part", () => {
  const result = (details: unknown, isError = false) =>
    ({ role: "toolResult", toolCallId: "c1", toolName: "card", content: [], details, isError, timestamp: 0 }) as unknown as DurableMessage;
  const other = part("test-note", "A note");
  expect(partsOfToolResult(result({ [PARTS_DETAIL]: [CARD, { type: "broken" }, other] }))).toEqual([CARD, other]);
  expect(partsOfToolResult(result({ [PARTS_DETAIL]: [CARD] }, true))).toEqual([]);
  expect(partsOfToolResult(result(undefined))).toEqual([]);
  expect(partsOfToolResult({ role: "user", content: "hi", timestamp: 0 } as unknown as DurableMessage)).toEqual([]);
});

test("a tool's parts reach the run's result, the answers feed and get, and the user, folded into the text by a transport that does not draw them", async () => {
  const w = await worker(cardTool());
  const conversation = await w.conversation();
  const sent = await deliver(w);
  await w.dispatch("r1", "call: card {}", conversation);
  const result = await w.result("r1");

  expect(result).toMatchObject({ kind: "completed", text: "answer: call: card {}", parts: [CARD] });
  const [logged] = (await w.runtime.submissions.answers.read(undefined, 10)).items;
  expect(logged?.fact.parts).toEqual([CARD]);
  const status = await w.runtime.submissions.get(conversation, "r1", w.ctx);
  expect(status?.kind === "settled" ? status.run.parts : status).toEqual([CARD]);

  await until(() => sent.length > 0, "the answer delivered");
  expect(sent.map(({ text, parts }) => ({ text, parts }))).toEqual([{ text: "answer: call: card {}\n\nA card: pick yes or no", parts: undefined }]);
});

test("a tool that ends its run (terminate) gives the answer its parts and no text: delivered as the part to a transport that draws it", async () => {
  const w = await worker(cardTool(true));
  const conversation = await w.conversation();
  const sent = await deliver(w, ["test-card"]);
  await w.dispatch("r1", "call: card {}", conversation);
  const result = await w.result("r1");

  expect(result.kind).toBe("completed");
  expect(result.text ?? "").toBe("");
  expect(result.parts).toEqual([CARD]);
  // The round's result is in the run's transcript, after the answer that called the tool.
  expect(result.messages.map((message) => (message as { role: string }).role)).toEqual(["user", "assistant", "toolResult"]);

  await until(() => sent.length > 0, "the part delivered");
  expect(sent.map(({ text, parts }) => ({ text, parts }))).toEqual([{ text: "", parts: [CARD] }]);
});
