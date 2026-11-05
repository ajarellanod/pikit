/**
 * The operator's policy (`visibility.ts`) on transcript entries and live events, value by value: what
 * shows, and what never does (under the defaults: no thinking, no tool's arguments, output or result;
 * under any: no system prompt, no usage, no provider's error).
 */

import { expect, test } from "bun:test";
import { applyOps, diffOps, type JsonOp, type JsonValue } from "@pikit/contracts";
import type { ChatEvent, ChatVisibility } from "./api.ts";
import { FAILED_ANSWER, createEventProjector, projectEntry, projectMessage } from "./visibility.ts";

const DEFAULTS: ChatVisibility = { thinking: false, tools: "names", context: true };
const SECRET = /secret|private|signature|usage|cost|provider-error|internal/;

const assistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private reasoning", thinkingSignature: "signature-1" },
    { type: "text", text: "Looking it up.", textSignature: "signature-2" },
    { type: "toolCall", id: "call-1", name: "websearch", arguments: { query: "secret query" }, thoughtSignature: "signature-3" },
  ],
  api: "internal-api",
  provider: "internal-provider",
  model: "internal/model",
  usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.4 } },
  stopReason: "toolUse",
  timestamp: 1000,
};
const result = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "websearch",
  content: [{ type: "text", text: "1. A secret result\n   https://example.com" }],
  details: { internal: "secret details" },
  isError: false,
  timestamp: 1001,
};
const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider-error: 401 invalid key sk-secret", timestamp: 1002 };
const system = { role: "system", content: "secret system prompt" };
const user = { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", url: "/chat/api/conversations/x/messages/web%3A1/images/0", mimeType: "image/png" }], timestamp: 999 };
const entry = (id: string, message: unknown) => ({ id, kind: "message" as const, messages: [message] });

test("defaults (thinking off, tools names): an answer's text and its tool calls' names; no thinking, no arguments, no result, no usage, no provider's words", () => {
  expect(projectMessage(assistant, DEFAULTS)).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "Looking it up." },
      { type: "toolCall", id: "call-1", name: "websearch", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp: 1000,
  });
  expect(projectMessage(result, DEFAULTS)).toEqual({ role: "toolResult", toolCallId: "call-1", toolName: "websearch", isError: false, timestamp: 1001, content: [] });
  expect(projectMessage(failed, DEFAULTS)).toEqual({ role: "assistant", content: [], stopReason: "error", errorMessage: FAILED_ANSWER, timestamp: 1002 });
  expect(projectMessage(system, DEFAULTS)).toBeUndefined();
  expect(projectMessage({ role: "custom", content: "secret" }, DEFAULTS)).toBeUndefined();
  // The user's own message passes as the channel made it (images by URL).
  expect(projectMessage(user, DEFAULTS)).toBe(user);
  const shown = [assistant, result, failed, system].map((message) => projectEntry(entry("e", message), DEFAULTS));
  expect(JSON.stringify(shown)).not.toMatch(SECRET);
  expect(shown[3]).toBeUndefined();
});

test("thinking on: the thinking blocks, never their signatures", () => {
  const shown = projectMessage(assistant, { ...DEFAULTS, thinking: true }) as { content: unknown[] };
  expect(shown.content[0]).toEqual({ type: "thinking", thinking: "private reasoning" });
  expect(JSON.stringify(shown)).not.toContain("signature");
});

test("tools none: no tool call, no tool result; a message of tool calls only is dropped", () => {
  const none: ChatVisibility = { ...DEFAULTS, tools: "none" };
  expect(projectMessage(assistant, none)).toEqual({ role: "assistant", content: [{ type: "text", text: "Looking it up." }], stopReason: "toolUse", timestamp: 1000 });
  expect(projectMessage(result, none)).toBeUndefined();
  const callsOnly = { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "toolUse", timestamp: 5 };
  expect(projectEntry(entry("e", callsOnly), none)).toBeUndefined();
  // Stopped with nothing written: still shown (the page says it was stopped).
  expect(projectMessage({ role: "assistant", content: [], stopReason: "aborted", timestamp: 6 }, none)).toEqual({ role: "assistant", content: [], stopReason: "aborted", timestamp: 6 });
});

test("tools full: arguments and results' content (what the Context panel reads), never a result's details", () => {
  const full: ChatVisibility = { ...DEFAULTS, tools: "full" };
  expect((projectMessage(assistant, full) as { content: unknown[] }).content[1]).toEqual({ type: "toolCall", id: "call-1", name: "websearch", arguments: { query: "secret query" } });
  expect(projectMessage(result, full)).toEqual({ role: "toolResult", toolCallId: "call-1", toolName: "websearch", isError: false, timestamp: 1001, content: result.content });
  expect(JSON.stringify(projectMessage(result, full))).not.toContain("details");
});

/** `events` through one stream's projector, dropped ones left out. */
const live = (visibility: ChatVisibility, events: ChatEvent[]): ChatEvent[] => {
  const project = createEventProjector(visibility);
  return events.flatMap((event) => project(event) ?? []);
};

/** The value the `live` events of `events` make, as a view folds them. */
const folded = (events: ChatEvent[]): unknown => events.reduce<JsonValue>((value, event) => (event.type === "live" ? applyOps(value, event.ops as readonly JsonOp[]) : value), null);

/** The live values of a run of the user's, as `live.ts` sends them (the runtime's answer and tools as they are): each a `live` event of the ops from the one before. */
const going = (partial: unknown, tools: unknown[], more: Record<string, unknown> = {}) => ({ busy: true, partial, tools, ...more });
const values = [
  going({ role: "assistant", content: [{ type: "thinking", thinking: "private" }], usage: { cost: 1 }, timestamp: 7 }, [{ callId: "t0", name: "fetch", status: "running", output: "secret output", taskId: 4 }]),
  going(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private, more private", thinkingSignature: "signature-1" },
        { type: "text", text: "Hel" },
        { type: "toolCall", id: "t1", name: "websearch", arguments: { q: "secret" } },
        { type: "text", text: "lo" },
      ],
      usage: { cost: 2 },
      timestamp: 7,
    },
    [{ callId: "t0", name: "fetch", status: "done", output: "secret output, more" }, { callId: "t1", name: "websearch", status: "running" }],
  ),
  { busy: false, tools: [], failure: { reason: "model_error", detail: "provider-error: 401 sk-secret" } },
];
const stream: ChatEvent[] = values.map((value, i) => ({ type: "live", ops: i === 0 ? [["r", value]] : diffOps(values[i - 1] as JsonValue, value as JsonValue) }));

test("live, defaults: the first value whole, then only the ops between what users see; the partial without its hidden thinking (the blocks after it where they will be stored); tools by name; a failure by its word; no usage", () => {
  const shown = live(DEFAULTS, stream);
  expect(shown[0]).toEqual({ type: "live", ops: [["r", { busy: true, partial: { role: "assistant", content: [], timestamp: 7 }, tools: [{ callId: "t0", name: "fetch", status: "running" }] }]] });
  expect(folded(shown.slice(0, 2))).toEqual({
    busy: true,
    partial: { role: "assistant", content: [{ type: "text", text: "Hel" }, { type: "toolCall", id: "t1", name: "websearch", arguments: {} }, { type: "text", text: "lo" }], timestamp: 7 },
    tools: [{ callId: "t0", name: "fetch", status: "done" }, { callId: "t1", name: "websearch", status: "running" }],
  });
  expect(folded(shown)).toEqual({ busy: false, tools: [], failure: { reason: "model_error" } });
  expect(JSON.stringify(shown)).not.toMatch(SECRET);
});

test("live, thinking on and tools full: the thinking at its own index, without its signature; arguments and outputs pass; a text streamed costs its new text", () => {
  const shown = live({ thinking: true, tools: "full", context: true }, stream);
  expect(folded(shown.slice(0, 2))).toEqual({
    busy: true,
    partial: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private, more private" }, { type: "text", text: "Hel" }, { type: "toolCall", id: "t1", name: "websearch", arguments: { q: "secret" } }, { type: "text", text: "lo" }],
      timestamp: 7,
    },
    tools: [{ callId: "t0", name: "fetch", status: "done", output: "secret output, more" }, { callId: "t1", name: "websearch", status: "running" }],
  });
  expect(shown[1]?.type === "live" && shown[1].ops).toContainEqual(["a", ["partial", "content", 0, "thinking"], ", more private"]);
  expect(JSON.stringify(shown)).not.toMatch(/usage|cost|signature|provider-error/);
});

test("live, tools none: no tool, no tool block; a change only to what is hidden sends nothing", () => {
  const shown = live({ ...DEFAULTS, tools: "none" }, stream);
  expect(folded(shown.slice(0, 2))).toEqual({ busy: true, partial: { role: "assistant", content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }], timestamp: 7 }, tools: [] });
  expect(JSON.stringify(shown)).not.toMatch(/websearch|toolCall|fetch/);
  const hidden = live(DEFAULTS, [stream[0] as ChatEvent, { type: "live", ops: [["a", ["partial", "content", 0, "thinking"], " more private"], ["s", ["partial", "usage"], { cost: 3 }]] }]);
  expect(hidden).toHaveLength(1);
});

test("live: entries cut as the transcript's (one with nothing shown dropped); transcript hints pass; an unknown event never; ops that do not apply throw", () => {
  const none: ChatVisibility = { ...DEFAULTS, tools: "none" };
  expect(live(none, [{ type: "entries", entries: [entry("r#1", result)] }])).toEqual([]);
  expect(live(none, [{ type: "entries", entries: [entry("r#1", result), entry("r#2", assistant)] }])).toEqual([{ type: "entries", entries: [entry("r#2", projectMessage(assistant, none))] }]);
  expect(live(DEFAULTS, [{ type: "entries", entries: [entry("web:1", user)] }])).toEqual([{ type: "entries", entries: [entry("web:1", user)] }]);
  expect(live(DEFAULTS, [{ type: "transcript" }])).toEqual([{ type: "transcript" }]);
  expect(live(DEFAULTS, [{ type: "usage" } as unknown as ChatEvent, { type: "agent_changed", agent: { systemPrompt: "secret" } } as unknown as ChatEvent])).toEqual([]);
  expect(() => live(DEFAULTS, [{ type: "live", ops: [["a", ["partial"], "x"]] }])).toThrow("json-ops");
});
