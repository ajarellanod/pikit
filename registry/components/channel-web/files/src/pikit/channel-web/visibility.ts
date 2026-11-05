/**
 * What users see of a conversation: the operator's policy (`ChatVisibility`, api.ts; the config's
 * `visibility`, a live setting), applied in one place to the transcript's entries and to the live
 * events, when they are read (`routes.ts`): a change of policy applies to history too.
 *
 * A whitelist: only the fields named here pass, so nothing the runtime adds later leaks.
 *
 * - **A user's message** passes as it is (the channel's own: its text, its images by URL).
 * - **An assistant message**: `role`, `content`, `timestamp`, `stopReason`, and an `errorMessage` said
 *   plainly (never the provider's words). Its `text` blocks always; `thinking` blocks only with
 *   `thinking` (never their signatures); `toolCall` blocks with `names` without their arguments, with
 *   `full` whole, with `none` none. Any other block, and `usage`, `model`, `provider`, never. A message
 *   left with nothing to show (no content, no error, not stopped) is dropped.
 * - **A tool's result**: with `full` its `toolCallId`, `toolName`, `content`, `isError`, `timestamp`; with
 *   `names` the same with no content; with `none` dropped. Never its `details`.
 * - **Any other message** (a system prompt, a role the runtime adds): dropped.
 *
 * Live (`createEventProjector`, one per stream): the live value (`ChatLive`) is projected whole at each
 * change (`projectLive`), and what goes out is the ops between one projection and the next (`diffOps`),
 * so nothing hidden can pass in an op. The answer being written is cut as an assistant message is (kept
 * even when nothing is left: a partial), so the partial a view holds is the transcript's message as it
 * will be stored. Its tools go with `names` as their call id, name and status, with `full` their output
 * too, with `none` not at all. Why a run failed goes as the runtime's word for it, never its text.
 * `entries` are cut as the transcript's (an entry left with nothing is dropped). An event of a type not
 * named here is dropped.
 */

import { applyOps, diffOps, type JsonOp, type JsonValue } from "@pikit/contracts";
import type { ChatEvent, ChatLive, ChatLiveTool, ChatVisibility } from "./api.ts";

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {});

/** What an assistant's failed answer says: never the provider's own error text. */
export const FAILED_ANSWER = "The assistant could not finish this answer.";

/** Whether a block of type `type` of an assistant message is shown. */
function shows(type: unknown, visibility: ChatVisibility): boolean {
  if (type === "text") return true;
  if (type === "thinking") return visibility.thinking;
  if (type === "toolCall") return visibility.tools !== "none";
  return false;
}

/** A block of an assistant message as shown, or `undefined` (hidden). */
function blockOf(value: unknown, visibility: ChatVisibility): Fields | undefined {
  const block = fieldsOf(value);
  if (!shows(block.type, visibility)) return undefined;
  if (block.type === "text") return { type: "text", text: typeof block.text === "string" ? block.text : "" };
  if (block.type === "thinking") return { type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "" };
  return { type: "toolCall", id: block.id, name: block.name, arguments: visibility.tools === "full" ? (block.arguments ?? {}) : {} };
}

const pick = (from: Fields, keys: readonly string[]): Fields => Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

/** An assistant message as shown: its blocks cut (`keepEmpty`: kept even when nothing is left, a partial). */
function assistantOf(message: Fields, visibility: ChatVisibility, keepEmpty: boolean): Fields | undefined {
  const content = Array.isArray(message.content) ? message.content.flatMap((block) => blockOf(block, visibility) ?? []) : [];
  const failed = typeof message.errorMessage === "string" && message.errorMessage !== "";
  if (!keepEmpty && content.length === 0 && !failed && message.stopReason !== "aborted") return undefined;
  return { role: "assistant", content, ...pick(message, ["timestamp", "stopReason"]), ...(failed && { errorMessage: FAILED_ANSWER }) };
}

/** One pi-ai message as users see it, or `undefined`: dropped. */
export function projectMessage(value: unknown, visibility: ChatVisibility): unknown {
  const message = fieldsOf(value);
  if (message.role === "user") return value;
  if (message.role === "assistant") return assistantOf(message, visibility, false);
  if (message.role === "toolResult") {
    if (visibility.tools === "none") return undefined;
    return { role: "toolResult", ...pick(message, ["toolCallId", "toolName", "isError", "timestamp"]), content: visibility.tools === "full" && Array.isArray(message.content) ? message.content : [] };
  }
  return undefined;
}

/** The messages of an entry as users see them: dropped ones left out. */
export const projectMessages = (messages: readonly unknown[], visibility: ChatVisibility): unknown[] =>
  messages.flatMap((message) => {
    const shown = projectMessage(message, visibility);
    return shown === undefined ? [] : [shown];
  });

/** A transcript entry as users see it, or `undefined` when none of its messages is shown. */
export function projectEntry<E extends { messages: unknown[] }>(entry: E, visibility: ChatVisibility): E | undefined {
  const messages = projectMessages(entry.messages, visibility);
  return messages.length === 0 ? undefined : { ...entry, messages };
}

/** A call of the tool round as users see it, or `undefined` (none at all with `tools: "none"`). */
function toolOf(value: unknown, visibility: ChatVisibility): ChatLiveTool | undefined {
  const tool = fieldsOf(value);
  if (visibility.tools === "none" || typeof tool.callId !== "string" || typeof tool.name !== "string") return undefined;
  const status = tool.status === "pending" || tool.status === "done" ? tool.status : "running";
  return { callId: tool.callId, name: tool.name, status, ...(visibility.tools === "full" && typeof tool.output === "string" && { output: tool.output }) };
}

/** A conversation's live value (`ChatLive`, as `live.ts` makes it) as users see it. */
export function projectLive(value: unknown, visibility: ChatVisibility): ChatLive {
  const live = fieldsOf(value);
  const partial = fieldsOf(live.partial);
  const shown = partial.role === "assistant" ? assistantOf(partial, visibility, true) : undefined;
  const reason = fieldsOf(live.failure).reason;
  return {
    busy: live.busy === true,
    ...(shown !== undefined && { partial: shown }),
    tools: Array.isArray(live.tools) ? live.tools.flatMap((tool) => toolOf(tool, visibility) ?? []) : [],
    ...(typeof reason === "string" && { failure: { reason } }),
  };
}

/**
 * The projection of one stream's events: stateful, as it holds the live value as it came (`raw`) and
 * as it was last shown (`shown`). `undefined`: the event is dropped (nothing users see changed).
 * Throws on `live` ops that do not apply to the value before them: the stream ends, the view reconnects.
 */
export function createEventProjector(visibility: ChatVisibility): (event: ChatEvent) => ChatEvent | undefined {
  let raw: JsonValue = null;
  let shown: ChatLive | undefined;
  return (event) => {
    switch (event.type) {
      case "live": {
        raw = applyOps(raw, event.ops as readonly JsonOp[]);
        const next = projectLive(raw, visibility);
        const ops = shown === undefined ? [["r", next as unknown as JsonValue] as const] : diffOps(shown as unknown as JsonValue, next as unknown as JsonValue);
        shown = next;
        return ops.length === 0 ? undefined : { type: "live", ops };
      }
      case "entries": {
        const entries = (Array.isArray(event.entries) ? event.entries : []).flatMap((entry) => projectEntry(entry, visibility) ?? []);
        return entries.length === 0 ? undefined : { type: "entries", entries };
      }
      case "transcript":
        return { type: "transcript" };
      default:
        return undefined;
    }
  };
}
