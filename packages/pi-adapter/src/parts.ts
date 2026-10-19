/**
 * How a pi-durable tool gives parts to its run's answer (`AgentResult.parts`, @pikit/contracts'
 * parts.ts): its result carries them in its `details` (pi-durable's channel for UIs, kept on the
 * `toolResult` message in the transcript), under `pikit.parts`. A tool writes them with `withParts`,
 * the one way to; the runtime reads them back with `partsOfToolResult` when it builds a run's result
 * (`result.ts`), from every successful tool result of the run, in order.
 *
 *   execute: async (args) => withParts({ output: [{ type: "text", text: "Asked." }], control: { terminate: true } }, [question])
 *
 * A message's own parts (`AgentRequest.parts`) are kept with it, in its input entry (`pikit.input`,
 * `{ parts }` in its data, next to its sender), and come before the tools' in its run's result
 * (`partsOfInput`).
 *
 * A part is checked where it is written (a kind, a fallback, JSON: `checkedParts`): a tool that gives a
 * malformed one fails its call, so the model and the operator see why, and a message with one is
 * refused. Reading skips what is not a part.
 */

import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { isJsonObject, type MessagePart, partProblem } from "@pikit/contracts";
import type { DurableMessage } from "./result.ts";

/** The key of a tool result's `details` that carries its parts. */
export const PARTS_DETAIL = "pikit.parts";

/**
 * `result` carrying `parts` (in order) for its run's answer, in its `details` under `pikit.parts`, next
 * to the details it has (which must then be a JSON object), each part as JSON keeps it. Throws a
 * `TypeError` when a part has no kind (`type`, non-empty text) or no `fallback` (text), or is not JSON. A result without `details` replaces
 * the running ones the tool reported (`api.details`), as pi-durable's own results do.
 */
export function withParts<R extends ToolExecutionResult>(result: R, parts: readonly MessagePart[]): Omit<R, "details"> & { details: { readonly [key: string]: JsonValue } } {
  const checked = checkedParts(parts, "withParts");
  const details = result.details;
  if (details !== undefined && !isJsonObject(details)) throw new TypeError("withParts: the result's details must be a JSON object to carry parts");
  const carried: { readonly [key: string]: JsonValue } = { ...(details as { readonly [key: string]: JsonValue } | undefined), [PARTS_DETAIL]: checked as unknown as JsonValue };
  const { details: _replaced, ...rest } = result;
  return { ...rest, details: carried };
}

/**
 * `parts` as JSON keeps them (an `undefined` field goes), each checked (`partProblem`): what the
 * transcript stores. Throws a `TypeError` that starts with `who` when one is not JSON or is no part.
 */
export function checkedParts(parts: readonly unknown[], who: string): MessagePart[] {
  if (!Array.isArray(parts)) throw new TypeError(`${who}: parts are a list of parts`);
  return parts.map((part, index) => {
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(part) ?? "null");
    } catch (error) {
      throw new TypeError(`${who}: part ${index} is not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const problem = partProblem(copy);
    if (problem !== undefined) throw new TypeError(`${who}: part ${index} ${problem}`);
    return copy as MessagePart;
  });
}

/** The parts an input entry carries (`{ parts }` in its data: `AgentRequest.parts`), in order; what is no part is skipped. */
export function partsOfInput(data: unknown): MessagePart[] {
  const parts = isJsonObject(data) ? data.parts : undefined;
  return Array.isArray(parts) ? parts.filter((part): part is MessagePart => partProblem(part) === undefined) : [];
}

/** The parts a tool result gives (`withParts`), in order; none for an error result or any other message. */
export function partsOfToolResult(message: DurableMessage): MessagePart[] {
  if (message.role !== "toolResult" || message.isError) return [];
  const details: unknown = message.details;
  const parts = isJsonObject(details) ? details[PARTS_DETAIL] : undefined;
  return Array.isArray(parts) ? parts.filter((part): part is MessagePart => partProblem(part) === undefined) : [];
}
