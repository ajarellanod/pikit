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
 * Live (`createEventProjector`, one per stream): the dashboard's event shapes, each cut the same way.
 * A hidden block of the answer being written is left out, and the changes after it are renumbered
 * (`contentIndex`), so the partial a view folds is the transcript's message as it will be stored. Tool
 * events go with `names` without their arguments and output (`tool_execution_update` not at all), with
 * `none` not at all. An event of a type not named here is dropped.
 */

import type { ChatEvent, ChatVisibility } from "./api.ts";

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

/** A live event's entry (`{ id, kind, model }`, pi-durable's form) as users see it, or `undefined`. */
function liveEntryOf(value: unknown, visibility: ChatVisibility): Fields | undefined {
  const entry = fieldsOf(value);
  if (entry.id === undefined) return undefined;
  const model = projectMessages(Array.isArray(entry.model) ? entry.model : [], visibility);
  return model.length === 0 ? undefined : { id: entry.id, kind: entry.kind, model };
}

/**
 * The projection of one stream's live events: stateful, as it renumbers the blocks of the answer being
 * written (its original block types kept, `types`). `undefined`: the event is dropped.
 */
export function createEventProjector(visibility: ChatVisibility): (event: ChatEvent) => ChatEvent | undefined {
  /** The original types of the partial's blocks, by their index in the runtime's message. */
  let types: unknown[] = [];
  const typesOf = (message: Fields): unknown[] => (Array.isArray(message.content) ? message.content.map((block) => fieldsOf(block).type) : []);
  /** Where block `index` is in the message shown: the blocks shown before it. */
  const shownIndex = (index: number): number => types.slice(0, index).filter((type) => shows(type, visibility)).length;
  const partialOf = (value: unknown): Fields | undefined => {
    const message = fieldsOf(value);
    if (message.role !== "assistant") return undefined;
    types = typesOf(message);
    return assistantOf(message, visibility, true);
  };
  const toolsShown = visibility.tools !== "none";

  return (event) => {
    switch (event.type) {
      case "snapshot": {
        types = [];
        const generation = fieldsOf(event.generation);
        const partial = generation.message === undefined ? undefined : partialOf(generation.message);
        const tools = toolsShown && Array.isArray(event.tools) ? event.tools.map(fieldsOf) : [];
        return {
          type: "snapshot",
          ...(event.run !== undefined && event.run !== null && { run: {} }),
          ...(partial !== undefined && { generation: { message: partial } }),
          tools: tools.map((tool) => ({ ...pick(tool, ["callId", "name", "status"]), ...(visibility.tools === "full" && typeof tool.output === "string" && { output: tool.output }) })),
        };
      }
      case "run_start":
      case "run_end":
        types = [];
        return { type: event.type };
      case "message_start": {
        const partial = partialOf(event.message);
        return partial === undefined ? undefined : { type: "message_start", message: partial };
      }
      case "message_update": {
        const changes = (Array.isArray(event.changes) ? event.changes.map(fieldsOf) : []).flatMap((change): Fields[] => {
          if (change.type === "message") {
            const partial = partialOf(change.message);
            return partial === undefined ? [] : [{ type: "message", message: partial }];
          }
          if (typeof change.contentIndex !== "number") return [];
          const index = change.contentIndex;
          if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") {
            types[index] = fieldsOf(change.block).type;
            const block = blockOf(change.block, visibility);
            return block === undefined ? [] : [{ type: change.type, contentIndex: shownIndex(index), block }];
          }
          if ((change.type === "text_delta" || change.type === "thinking_delta") && shows(types[index], visibility) && typeof change.delta === "string") {
            return [{ type: change.type, contentIndex: shownIndex(index), delta: change.delta }];
          }
          // A tool call's arguments as written: with `full` only (the views fold them from the block).
          if (change.type === "toolcall_delta" && visibility.tools === "full" && types[index] === "toolCall") {
            return [{ ...pick(change, ["type", "path", "delta"]), contentIndex: shownIndex(index) }];
          }
          return [];
        });
        return changes.length === 0 ? undefined : { type: "message_update", changes };
      }
      case "message_end": {
        types = [];
        const entry = liveEntryOf(event.entry, visibility);
        return { type: "message_end", ...(entry !== undefined && { entry }) };
      }
      case "tool_execution_start":
      case "tool_execution_end": {
        if (!toolsShown) return undefined;
        const call = pick(event, ["toolCallId", "toolName"]);
        if (visibility.tools === "full" && event.type === "tool_execution_start" && event.args !== undefined) return { type: event.type, ...call, args: event.args };
        return { type: event.type, ...call };
      }
      case "tool_execution_update":
        return visibility.tools === "full" ? { type: event.type, ...pick(event, ["toolCallId", "toolName", "output"]) } : undefined;
      case "entry_appended": {
        const entry = event.entry === undefined ? undefined : liveEntryOf(event.entry, visibility);
        return { type: "entry_appended", ...(entry !== undefined && { entry }) };
      }
      default:
        return undefined;
    }
  };
}
