/**
 * The settled pi-durable input submissions of one run as the core's `AgentResult`.
 *
 * The runtime admits every message as a follow-up, and pi-durable places the follow-ups queued while a
 * run goes all at once, as the inputs of the next run: they settle together, and are one result whose
 * `requestId` is the first and whose `requestIds` lists them all, in order. Its transcript is the
 * entries from the first input's entry to the answer (`done`), or, unanswered, to the entry before the
 * next input entry (`pi.user` or `pikit.input`) that is not one of its inputs (the next run's). A run
 * a tool ended (`control.terminate`) is answered by the assistant entry that called its tools, so its
 * transcript also has the results of those calls, written after it.
 *
 * Its parts (`AgentResult.parts`, `runParts`) are those its inputs carry (`AgentRequest.parts`, in
 * their `pikit.input` entries), in the order the run took them, then those its successful tool results
 * carry (`withParts`, `parts.ts`), in the order the results were written. Both are read from the
 * transcript, so a run's parts are the same whoever builds its result (live, or a reconciliation).
 */

import type { Context } from "@earendil-works/chord";
import type { Conversation, Cursor, EntryId, EntryQuery, EntryRecord, Page, SubmissionRecord } from "@earendil-works/pi-durable";
import type { AgentResult, ConversationRef, MessagePart, RunSettlement } from "@pikit/contracts";
import { partsOfInput, partsOfToolResult } from "./parts.ts";
import { INPUT_KIND, isInputKind } from "./submissions.ts";

/** A pi-ai 1.0 message, as pi-durable entries carry them. */
export type DurableMessage = NonNullable<EntryRecord["model"]>[number];
/** pi-ai 1.0's `Usage`. */
export type DurableUsage = Extract<DurableMessage, { role: "assistant" }>["usage"];

/** A settled input submission. */
export type SettledInput = Extract<SubmissionRecord, { type: "input"; status: "done" | "unanswered" }>;

export function isSettledInput(record: SubmissionRecord): record is SettledInput {
  return record.type === "input" && (record.status === "done" || record.status === "unanswered");
}

const PAGE = 100;

/** Reads a conversation's entries a page at a time: a `Conversation`'s (`entriesOf`), or a commit's (`tx.scanEntries`). */
export type EntryScan = (query: Omit<EntryQuery, "conversationId">, limit: number, cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>;

/** `conversation`'s entries, as an `EntryScan`. */
export const entriesOf =
  (conversation: Conversation, ctx: Context): EntryScan =>
  (query, limit, cursor) =>
    conversation.entries(query, limit, cursor, ctx);

/** `records`: the inputs one run took, oldest first (or one input withdrawn while queued). */
export async function toResult(conversation: Conversation, ref: ConversationRef, records: readonly SettledInput[], ctx: Context): Promise<AgentResult> {
  const [record] = records;
  if (record === undefined) throw new Error("toResult: a run takes at least one input");
  const requestIds = records.map((input) => input.requestId ?? String(input.id));
  const entries = await runEntries(entriesOf(conversation, ctx), records);
  const messages = entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role !== "system");
  const parts = partsOfEntries(entries, records);
  const base = {
    conversation: ref,
    requestId: requestIds[0] as string,
    requestIds,
    ...(parts.length > 0 && { parts }),
    messages: messages as AgentResult["messages"],
    usage: runUsage(messages),
  };
  if (record.status === "done") {
    const text = answerText(entries, record.answer);
    return { ...base, kind: "completed", ...(text !== undefined && { text }) };
  }
  if (record.reason === "aborted") return { ...base, kind: "aborted" };
  const message = typeof record.detail === "string" ? record.detail : `the run ended unanswered (${record.reason})`;
  return { ...base, kind: "failed", error: { code: record.reason, message } };
}

/** What `agent.submissions` keeps of a result: everything but the transcript and the usage. */
export function settlementOf(result: AgentResult): RunSettlement {
  const { conversation, requestId, requestIds, kind, text, parts, error } = result;
  return {
    conversation: { key: conversation.key, agent: conversation.agent, conversationId: conversation.conversationId },
    requestId,
    requestIds,
    kind,
    ...(text !== undefined && { text }),
    ...(parts !== undefined && parts.length > 0 && { parts }),
    ...(error !== undefined && { error: { code: error.code, message: error.message } }),
  };
}

/** The parts of a run (`records`: its inputs, oldest first), read through `scan`: its inputs', then its tools'. */
export async function runParts(scan: EntryScan, records: readonly SettledInput[]): Promise<MessagePart[]> {
  return partsOfEntries(await runEntries(scan, records), records);
}

/** The parts in a run's `entries`: those of its input entries, in order, then those of its tool results. */
function partsOfEntries(entries: readonly EntryRecord[], records: readonly SettledInput[]): MessagePart[] {
  const inputs = new Set(records.flatMap((record) => (record.entry === undefined ? [] : [record.entry])));
  const given = entries.flatMap((entry) => (inputs.has(entry.id) && entry.kind === INPUT_KIND ? partsOfInput(entry.data) : []));
  const tools = entries.flatMap((entry) => entry.model ?? []).flatMap(partsOfToolResult);
  return [...given, ...tools];
}

/** The run's entries, oldest first; none for an input that was never placed (withdrawn while queued). */
async function runEntries(scan: EntryScan, records: readonly SettledInput[]): Promise<EntryRecord[]> {
  const inputs = new Set(records.flatMap((record) => (record.entry === undefined ? [] : [record.entry])));
  if (inputs.size === 0) return [];
  const from = Math.min(...inputs) as EntryId;
  const record = records[0] as SettledInput;
  const to = record.status === "done" ? record.answer : undefined;
  const newestFirst: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan({ minEntryId: from, ...(to !== undefined && { maxEntryId: to }) }, PAGE, cursor);
    newestFirst.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const entries = newestFirst.reverse();
  if (to !== undefined) return [...entries, ...(await finalToolResults(scan, entries, to))];
  // Unanswered: the run ended at its last entry before the next run's input.
  const next = entries.findIndex((entry) => isInputKind(entry.kind) && !inputs.has(entry.id));
  return next === -1 ? entries : entries.slice(0, next);
}

/**
 * The results of the tool calls the answer made, when a tool ended the run (`control.terminate`): they
 * are written after the answer. None for an answer that called no tool (a run the model ended).
 */
async function finalToolResults(scan: EntryScan, entries: readonly EntryRecord[], answer: EntryId): Promise<EntryRecord[]> {
  const message = entries.find((entry) => entry.id === answer)?.model?.find((m) => m.role === "assistant");
  const calls = new Set(message?.role === "assistant" ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])) : []);
  const found: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  while (calls.size > 0) {
    const page = await scan({ minEntryId: (answer + 1) as EntryId, order: "ascending" }, PAGE, cursor);
    for (const entry of page.items) {
      // The next run's input: the round's results are all before it.
      if (isInputKind(entry.kind)) return found;
      const results = (entry.model ?? []).filter((m) => m.role === "toolResult" && calls.delete(m.toolCallId));
      if (results.length > 0) found.push(entry);
      if (calls.size === 0) break;
    }
    cursor = page.next;
    if (cursor === undefined) break;
  }
  return found;
}

function answerText(entries: readonly EntryRecord[], answer: EntryId): string | undefined {
  const message = entries.find((entry) => entry.id === answer)?.model?.find((m) => m.role === "assistant");
  if (message?.role !== "assistant") return undefined;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * What the run cost: the usage of its model responses (failed attempts included) and of its tool
 * results that report one. These are the amounts pi-durable adds to the conversation's `pi.usage`;
 * a compaction's summarization is counted there and has no entry of the run.
 */
export function runUsage(messages: readonly DurableMessage[]): DurableUsage {
  let total: DurableUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const message of messages) {
    const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
    if (usage !== undefined) total = addUsage(total, usage);
  }
  return total;
}

/** pi-durable's `addUsage`: the optional counters appear once either side reports them. */
function addUsage(left: DurableUsage, right: DurableUsage): DurableUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...((left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) && {
      cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
    }),
    ...((left.reasoning !== undefined || right.reasoning !== undefined) && { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}
