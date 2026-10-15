/**
 * The operator's policy (`visibility.ts`) on transcript entries and live events, value by value: what
 * shows, and what never does (under the defaults: no thinking, no tool's arguments, output or result;
 * under any: no system prompt, no usage, no provider's error).
 */

import { expect, test } from "bun:test";
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

const stream: ChatEvent[] = [
  {
    type: "snapshot",
    run: { inputs: [3] },
    generation: { attempt: 1, message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }], usage: { cost: 1 }, timestamp: 7 } },
    tools: [{ callId: "t0", name: "fetch", status: "running", output: "secret output", taskId: 4 }],
    usage: { cost: 9 },
    inbox: [],
  },
  {
    type: "message_update",
    usage: { cost: 1 },
    changes: [
      { type: "thinking_delta", contentIndex: 0, delta: " more private" },
      { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
      { type: "text_delta", contentIndex: 1, delta: "Hel" },
      { type: "toolcall_start", contentIndex: 2, block: { type: "toolCall", id: "t1", name: "websearch", arguments: { q: "secret" } } },
      { type: "toolcall_delta", contentIndex: 2, path: ["q"], delta: "secret" },
      { type: "text_start", contentIndex: 3, block: { type: "text", text: "" } },
      { type: "text_delta", contentIndex: 3, delta: "lo" },
    ],
  },
  { type: "tool_execution_start", toolCallId: "t1", toolName: "websearch", args: { q: "secret" } },
  { type: "tool_execution_update", toolCallId: "t1", toolName: "websearch", output: { append: "secret output" } },
  { type: "tool_execution_end", toolCallId: "t1", toolName: "websearch" },
  { type: "message_end", entry: { id: "web:1#abc", kind: "message", model: [{ ...assistant, timestamp: 7 }] } },
  { type: "usage_changed", usage: { cost: 2 } },
  { type: "agent_changed", agent: { systemPrompt: "secret" } },
  { type: "run_end" },
];

test("live, defaults: the partial's hidden thinking left out and the blocks after it renumbered; tools by name; message_end's entry as the transcript's; no usage, no unknown event", () => {
  expect(live(DEFAULTS, stream)).toEqual([
    { type: "snapshot", run: {}, generation: { message: { role: "assistant", content: [], timestamp: 7 } }, tools: [{ callId: "t0", name: "fetch", status: "running" }] },
    {
      type: "message_update",
      changes: [
        { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
        { type: "text_delta", contentIndex: 0, delta: "Hel" },
        { type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "t1", name: "websearch", arguments: {} } },
        { type: "text_start", contentIndex: 2, block: { type: "text", text: "" } },
        { type: "text_delta", contentIndex: 2, delta: "lo" },
      ],
    },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "websearch" },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "websearch" },
    { type: "message_end", entry: { id: "web:1#abc", kind: "message", model: [projectMessage({ ...assistant, timestamp: 7 }, DEFAULTS)] } },
    { type: "run_end" },
  ]);
  expect(JSON.stringify(live(DEFAULTS, stream))).not.toMatch(SECRET);
});

test("live, thinking on and tools full: the thinking streams at its own index; arguments and outputs pass", () => {
  const shown = live({ thinking: true, tools: "full", context: true }, stream);
  expect(shown[0]).toMatchObject({ generation: { message: { content: [{ type: "thinking", thinking: "private" }] } }, tools: [{ callId: "t0", output: "secret output" }] });
  expect(shown[1]?.changes).toEqual([
    { type: "thinking_delta", contentIndex: 0, delta: " more private" },
    { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 1, delta: "Hel" },
    { type: "toolcall_start", contentIndex: 2, block: { type: "toolCall", id: "t1", name: "websearch", arguments: { q: "secret" } } },
    { type: "toolcall_delta", path: ["q"], delta: "secret", contentIndex: 2 },
    { type: "text_start", contentIndex: 3, block: { type: "text", text: "" } },
    { type: "text_delta", contentIndex: 3, delta: "lo" },
  ]);
  expect(shown.map((event) => event.type)).toEqual(["snapshot", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "message_end", "run_end"]);
  expect(shown[2]).toEqual({ type: "tool_execution_start", toolCallId: "t1", toolName: "websearch", args: { q: "secret" } });
  expect(JSON.stringify(shown)).not.toMatch(/usage|cost|systemPrompt/);
});

test("live, tools none: no tool event, no tool block, no tool in a snapshot", () => {
  const shown = live({ ...DEFAULTS, tools: "none" }, stream);
  expect(shown.map((event) => event.type)).toEqual(["snapshot", "message_update", "message_end", "run_end"]);
  expect(shown[0]).toMatchObject({ tools: [] });
  expect(JSON.stringify(shown)).not.toMatch(/websearch|toolCall|fetch/);
});

test("live: an entry with nothing shown is announced without it (the view reads the transcript again); entry_appended's entry cut the same way", () => {
  const none: ChatVisibility = { ...DEFAULTS, tools: "none" };
  expect(live(none, [{ type: "message_end", entry: { id: "r#1", kind: "message", model: [result] } }])).toEqual([{ type: "message_end" }]);
  expect(live(none, [{ type: "entry_appended", entry: { id: "r#1", kind: "message", model: [result] } }])).toEqual([{ type: "entry_appended" }]);
  expect(live(DEFAULTS, [{ type: "entry_appended", entry: { id: "web:1", kind: "message", model: [user] } }])).toEqual([{ type: "entry_appended", entry: { id: "web:1", kind: "message", model: [user] } }]);
  expect(live(DEFAULTS, [{ type: "entry_appended" }])).toEqual([{ type: "entry_appended" }]);
});
