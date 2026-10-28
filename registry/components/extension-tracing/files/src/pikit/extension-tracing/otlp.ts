/**
 * Spans, their ids, OTLP/HTTP JSON and what captured content goes through (redaction, the 4 KB cap).
 * Plain code over `fetch`'s world (Web Crypto, `TextEncoder`): no OpenTelemetry SDK, which pulls Node
 * modules and weighs on a Worker's bundle. Neutral: it runs on every target.
 */

import { credentialSettingProblem } from "@pikit/contracts";

/** What a redacted value becomes. */
export const REDACTED = "[redacted]";

export type AttributeValue = string | number | boolean | readonly string[];

/** A span's attributes; an `undefined` one is left out. */
export type Attributes = Record<string, AttributeValue | undefined>;

/** One finished span, its times in epoch ms. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** `client` for a model request (a call to another service), `internal` otherwise. */
  kind: "internal" | "client";
  start: number;
  end: number;
  attributes: Attributes;
  /** Set when the span is an error: the status message (an error's code, never its text unless content is captured). */
  error?: string;
}

/** What an attribute of captured content holds at most, in UTF-8 bytes. */
export const MAX_ATTRIBUTE_BYTES = 4_096;

/** The first `bytes` bytes of SHA-256(`text`), in hex. */
async function digestHex(text: string, bytes: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return hex(digest.subarray(0, bytes));
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A run's trace id: derived from its conversation and the request that started it, so the instance
 * that resumes the run after a restart or an eviction continues the same trace.
 */
export const traceIdOf = (conversationId: string, requestId: string): Promise<string> => digestHex(`pikit.trace\n${conversationId}\n${requestId}`, 16);

/** The span id of a run's `invoke_agent` span: derived as its trace id is, so spans sent before an eviction keep their parent. */
export const runSpanIdOf = (conversationId: string, requestId: string): Promise<string> => digestHex(`pikit.run\n${conversationId}\n${requestId}`, 8);

/** The span id of a tool call's span: derived from its call id, so a nested call finds its parent's, and a call ended by another instance keeps its id. */
export const toolSpanIdOf = (conversationId: string, callId: string): Promise<string> => digestHex(`pikit.tool\n${conversationId}\n${callId}`, 8);

/** A random span id (a model request's: an evicted request is sent again, as a new span). */
export const randomSpanId = (): string => hex(crypto.getRandomValues(new Uint8Array(8)));

/** Epoch ms as OTLP's nanoseconds, a decimal string. */
const nanos = (ms: number): string => (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();

function attributeValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { arrayValue: { values: value.map((each) => ({ stringValue: each })) } };
}

function attributes(from: Attributes): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(from).flatMap(([key, value]) => {
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) return [];
    return [{ key, value: attributeValue(value) }];
  });
}

/** OTLP/HTTP JSON (`ExportTraceServiceRequest`) of `spans`, under one resource `service.name`. */
export function encodeSpans(spans: readonly Span[], serviceName: string, scopeVersion: string): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ "service.name": serviceName }) },
        scopeSpans: [
          {
            scope: { name: "pikit.extension-tracing", version: scopeVersion },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId !== undefined && { parentSpanId: span.parentSpanId }),
              name: span.name,
              // SPAN_KIND_INTERNAL = 1, SPAN_KIND_CLIENT = 3.
              kind: span.kind === "client" ? 3 : 1,
              startTimeUnixNano: nanos(span.start),
              endTimeUnixNano: nanos(Math.max(span.start, span.end)),
              attributes: attributes(span.attributes),
              // STATUS_CODE_ERROR = 2; an unset status is left out.
              ...(span.error !== undefined && { status: { code: 2, message: span.error } }),
            })),
          },
        ],
      },
    ],
  };
}

/** A word of text, for the credential check: what sits between spaces, quotes and brackets. */
const WORD = /[^\s"'`<>()[\]{},;]+/g;
/** An `Authorization` value in text: the scheme stays, the credential goes. */
const AUTHORIZATION = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * `text` with the values of `secrets` removed, an authorization header's credential (`Bearer …`) and
 * every word shaped like a known credential (`sk-…`, `ghp_…`, `xox…-`, a JWT, a bot token: the check
 * contracts' `credentialSettingProblem` makes, as memory-summaries' `redact`) replaced by `[redacted]`.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  out = out.replace(AUTHORIZATION, (_match, scheme: string, space: string) => `${scheme}${space}${REDACTED}`);
  return out.replace(WORD, (word) => (credentialSettingProblem(word) === undefined ? word : REDACTED));
}

/** `value` with every string redacted (`redactText`), at any depth: a copy. */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((each) => redactValue(each, secrets));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, redactValue(each, secrets)]));
  return value;
}

/** `text` cut to `MAX_ATTRIBUTE_BYTES` UTF-8 bytes, ending in `…` when cut. */
export function capText(text: string, maxBytes = MAX_ATTRIBUTE_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // `…` is 3 bytes; a character cut in the middle decodes as U+FFFD, dropped.
  const kept = new TextDecoder().decode(bytes.subarray(0, maxBytes - 3)).replace(/\uFFFD+$/, "");
  return `${kept}…`;
}

/** A captured value as an attribute: redacted, then serialized (a string as is), then capped. */
export function contentAttribute(value: unknown, secrets: readonly string[]): string {
  const redacted = redactValue(value, secrets);
  return capText(typeof redacted === "string" ? redacted : JSON.stringify(redacted) ?? "");
}

type Part = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A message's parts as OpenTelemetry's GenAI conventions write them; images and anything unknown are dropped. */
function partsOf(content: unknown): Part[] {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): Part[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", content: part.text }];
    if (part.type === "thinking" && typeof part.thinking === "string") return [{ type: "reasoning", content: part.thinking }];
    if (part.type === "toolCall") return [{ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments }];
    return [];
  });
}

/** A model message (pi-ai's `user`, `assistant`, `toolResult`) as a GenAI message; `undefined` for a system one. */
export function messageOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role === "toolResult") {
    const text = partsOf(message.content).flatMap((part) => (part.type === "text" ? [String(part.content)] : [])).join("\n");
    return { role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: text }] };
  }
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  return { role: message.role, parts: partsOf(message.content) };
}

/** What a model request brings that the previous one did not: its messages after the last assistant message (a prompt, tool results). */
export function newInput(messages: readonly unknown[]): Record<string, unknown>[] {
  const last = messages.findLastIndex((message) => isRecord(message) && message.role === "assistant");
  return messages.slice(last + 1).flatMap((message): Record<string, unknown>[] => {
    const converted = messageOf(message);
    return converted === undefined ? [] : [converted];
  });
}

/** A tool result's text, images dropped. */
export function resultText(output: unknown): string {
  return partsOf(output)
    .flatMap((part) => (part.type === "text" ? [String(part.content)] : []))
    .join("\n");
}
