/**
 * The fields of each log line, built from an event's payload. Only identifiers, kinds, counts,
 * durations, tokens and costs: never a message's text, a prompt, an answer or an error message
 * (SPEC §13). Every field is a plain value, so any logger (console, JSON lines) prints it as is.
 *
 * Each function picks the fields it names from the payload, rather than copying the payload and
 * removing what is private, so a field added to an event later is not logged until it is added here.
 */

import type { Admission, AgentResult, ConversationRef, ConversationReset } from "@pikit/core";

export type Fields = Record<string, string | number | boolean | string[]>;

/** Who a line is about: the conversation key, its agent and its Pi session. */
export function conversationFields(conversation: ConversationRef): Fields {
  return { conversation: conversation.key, agent: conversation.agent, session: conversation.sessionId };
}

export function admissionFields(conversation: ConversationRef, admission: Admission): Fields {
  return { ...conversationFields(conversation), requestId: admission.requestId, admission: admission.kind };
}

/**
 * How a run ended. `requestIds` lists every request the run answered (its starter first). The
 * error's code is logged, not its message: a provider's error message may quote the request.
 */
export function resultFields(result: AgentResult, durationMs: number | undefined): Fields {
  return {
    ...conversationFields(result.conversation),
    requestId: result.requestId,
    requestIds: [...result.requestIds],
    run: result.kind,
    messages: result.messages.length,
    ...(durationMs !== undefined && { durationMs }),
    ...usageFields(result.usage),
    ...(result.error !== undefined && { errorCode: result.error.code }),
  };
}

export function resetFields(reset: ConversationReset): Fields {
  return {
    ...conversationFields(reset.conversation),
    previousSession: reset.previousSessionId,
    session: reset.newSessionId,
  };
}

/**
 * Tokens and cost, read from the runtime's `Usage`. The core keeps `Usage` opaque (SPEC §6.1): with
 * `runtime-pi` it is pi-ai's, whose `cost.total` is priced by pi-ai. Each field is read only when it
 * is a number, so a runtime with another shape, or none, logs fewer fields instead of failing.
 */
export function usageFields(usage: unknown): Fields {
  if (typeof usage !== "object" || usage === null) return {};
  const fields: Fields = {};
  const record = usage as Record<string, unknown>;
  const take = (field: string, from: unknown) => {
    if (typeof from === "number" && Number.isFinite(from)) fields[field] = from;
  };
  take("inputTokens", record.input);
  take("outputTokens", record.output);
  take("cacheReadTokens", record.cacheRead);
  take("cacheWriteTokens", record.cacheWrite);
  take("totalTokens", record.totalTokens);
  const cost = record.cost;
  if (typeof cost === "object" && cost !== null) take("cost", (cost as Record<string, unknown>).total);
  return fields;
}
