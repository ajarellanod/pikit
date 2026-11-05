/**
 * extension-tracing's tests. They are copied with the component and keep running in your project.
 *
 * A component never imports another's files (SPEC P4), so these check what the component provides,
 * its config, the ids, OTLP's JSON and what captured content goes through. The extension in a real
 * App, through runtime-pi with a faux model and a fake collector, is `app.test.ts` beside `files/` in
 * the registry.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import type {} from "@pikit/pi-adapter";
import tracing, { createExtensionTracing, errorTypeOf, HARNESS_RESULTS, TRACING } from "./index.ts";
import { capText, contentAttribute, encodeSpans, messageOf, newInput, REDACTED, redactText, runSpanIdOf, toolSpanIdOf, traceIdOf } from "./otlp.ts";

const config = { "extension-tracing": { endpoint: "http://collector.test/v1/traces" } };

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [tracing], config, logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "extension-tracing")).toMatchObject({
    provides: ["agent.extension"],
    requires: [],
    optional: ["secrets", "health"],
  });
  expect(app.describe().capabilities["agent.extension"]?.keys).toEqual({ [TRACING]: "extension-tracing" });
});

test("config: an endpoint is required and is a URL; a secret is named, never given", async () => {
  expect(() => defineApp({ components: [tracing], logger: silentLogger })).toThrow(/endpoint/);
  for (const endpoint of ["collector", "file:///tmp/traces", "https://user:password@collector.test/v1/traces"]) {
    const app = await defineApp({ components: [tracing], config: { "extension-tracing": { endpoint } }, logger: silentLogger }).create();
    const failure = await app.start().then(() => undefined, (error: unknown) => error);
    expect(((failure as Error).cause as Error).message).toMatch(/endpoint must be an HTTP or HTTPS URL/);
  }
  const secretValue = { "extension-tracing": { endpoint: "https://x.test", basicAuth: { username: "pk-lf-123", password: "sk-lf-456" } } };
  expect(() => defineApp({ components: [tracing], config: secretValue, logger: silentLogger })).toThrow(/basicAuth/);
});

test("a config that names secrets refuses to start without a secrets provider", async () => {
  const named = { "extension-tracing": { endpoint: "https://x.test", basicAuth: { username: "LANGFUSE_PUBLIC_KEY", password: "LANGFUSE_SECRET_KEY" } } };
  const app = await defineApp({ components: [createExtensionTracing()], config: named, logger: silentLogger }).create();
  const failure = await app.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(((failure as Error).cause as Error).message).toMatch(/LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY\) and no secrets provider/);

  const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async () => "value" }) });
  const ok = await defineApp({ components: [secrets, createExtensionTracing()], config: named, logger: silentLogger }).create();
  await ok.start();
  await ok.stop();
});

test("ids: a run's trace and span ids are derived from its conversation and first request, a tool call's from its call id", async () => {
  const trace = await traceIdOf("c1", "r1");
  expect(trace).toMatch(/^[0-9a-f]{32}$/);
  expect(await traceIdOf("c1", "r1")).toBe(trace);
  expect(await traceIdOf("c1", "r2")).not.toBe(trace);
  expect(await traceIdOf("c2", "r1")).not.toBe(trace);
  expect(await runSpanIdOf("c1", "r1")).toMatch(/^[0-9a-f]{16}$/);
  expect(await toolSpanIdOf("c1", "call-1")).toBe(await toolSpanIdOf("c1", "call-1"));
  expect(await toolSpanIdOf("c1", "call-1")).not.toBe(await toolSpanIdOf("c1", "call-2"));
});

test("OTLP JSON: hex ids, nanosecond times as strings, typed attributes, an error status, undefined attributes left out", () => {
  const body = encodeSpans(
    [
      {
        traceId: "0".repeat(31) + "1",
        spanId: "0".repeat(15) + "2",
        parentSpanId: "0".repeat(15) + "3",
        name: "chat faux",
        kind: "client",
        start: 1_000,
        end: 1_500,
        attributes: { s: "x", i: 3, d: 0.5, b: true, a: ["stop"], u: undefined },
        error: "error",
      },
    ],
    "pikit",
    "0.0.1",
  ) as { resourceSpans: { resource: unknown; scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
  expect(body.resourceSpans[0]?.resource).toEqual({ attributes: [{ key: "service.name", value: { stringValue: "pikit" } }] });
  expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toEqual({
    traceId: "0".repeat(31) + "1",
    spanId: "0".repeat(15) + "2",
    parentSpanId: "0".repeat(15) + "3",
    name: "chat faux",
    kind: 3,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "1500000000",
    attributes: [
      { key: "s", value: { stringValue: "x" } },
      { key: "i", value: { intValue: "3" } },
      { key: "d", value: { doubleValue: 0.5 } },
      { key: "b", value: { boolValue: true } },
      { key: "a", value: { arrayValue: { values: [{ stringValue: "stop" }] } } },
    ],
    status: { code: 2, message: "error" },
  });
});

test("redaction: the named secrets' values, Bearer credentials and known credential shapes; prose stays", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
  const text = `db password hunter2-db-pass, header Authorization: Bearer abcdefgh12345678, key sk-ant-${"a".repeat(30)}, token ghp_${"b".repeat(36)}, slack xoxb-1234567890-abc, jwt ${jwt} done.`;
  const redacted = redactText(text, ["hunter2-db-pass"]);
  expect(redacted).toBe(`db password ${REDACTED}, header Authorization: Bearer ${REDACTED}, key ${REDACTED}, token ${REDACTED}, slack ${REDACTED}, jwt ${REDACTED} done.`);
  // In a JSON value, each string is redacted before it is serialized.
  expect(contentAttribute({ command: `curl -H "x: ${"hunter2-db-pass"}"`, n: 1 }, ["hunter2-db-pass"])).toBe(`{"command":"curl -H \\"x: ${REDACTED}\\"","n":1}`);
});

test("an attribute of content is capped at 4 KB, cut on a character", () => {
  expect(capText("short")).toBe("short");
  const cut = capText("é".repeat(5_000));
  expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(4_096);
  expect(cut.endsWith("é…")).toBe(true);
  expect(new TextEncoder().encode(contentAttribute("x".repeat(10_000), [])).length).toBeLessThanOrEqual(4_096);
});

test("messages: images dropped, tool calls and results kept; a request's new input is what follows the last answer", () => {
  expect(messageOf({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })).toEqual({ role: "user", parts: [{ type: "text", content: "look" }] });
  expect(messageOf({ role: "system", content: "x" })).toBeUndefined();
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ran" }] },
  ];
  expect(newInput(messages)).toEqual([{ role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "ran" }] }]);
  expect(messageOf(messages[1])).toEqual({ role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "bash", arguments: { command: "ls" } }] });
});

test("a tool span's error type: pi-durable's code for a result it wrote, tool_error for the tool's own, none for a success", () => {
  expect(errorTypeOf({})).toBeUndefined();
  expect(errorTypeOf({ isError: true })).toBe("tool_error");
  expect(errorTypeOf({ isError: true, diagnostics: [{ code: "tool_error" }] })).toBe("tool_error");
  for (const code of HARNESS_RESULTS) expect(errorTypeOf({ isError: true, diagnostics: [{ code: "truncated" }, { code }] })).toBe(code);
  // A hook that turned it into a success keeps the code: the tool still did not run.
  expect(errorTypeOf({ diagnostics: [{ code: "blocked" }] })).toBe("blocked");
});
