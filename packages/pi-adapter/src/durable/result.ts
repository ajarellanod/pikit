/**
 * A settled pi-durable input submission as the core's `AgentResult`.
 *
 * The runtime admits every message as a follow-up and pi-durable places queued follow-ups one at a
 * time, so a run takes exactly one input: one settled submission is one run, `requestIds` is
 * `[requestId]`. Its transcript is the entries from the input's `pi.user` entry to its answer (`done`),
 * or, unanswered, to the entry before the next `pi.user` (the next run's input).
 */

import type { Context } from "@earendil-works/chord";
import type { Conversation, EntryId, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import type { AgentResult, ConversationRef, RunSettlement } from "@pikit/contracts";

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

export async function toResult(conversation: Conversation, ref: ConversationRef, record: SettledInput, ctx: Context): Promise<AgentResult> {
  const requestId = record.requestId ?? String(record.id);
  const entries = await runEntries(conversation, record, ctx);
  const messages = entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role !== "system");
  const base = {
    conversation: ref,
    requestId,
    requestIds: [requestId],
    // The contracts still type messages and usage as Pi 0.99's (`AgentPayloads` in ../types.ts); the
    // switch-over moves them to pi-ai 1.0's.
    messages: messages as unknown as AgentResult["messages"],
    usage: runUsage(messages) as unknown as NonNullable<AgentResult["usage"]>,
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
  const { conversation, requestId, requestIds, kind, text, error } = result;
  return {
    conversation: { key: conversation.key, agent: conversation.agent, sessionId: conversation.sessionId },
    requestId,
    requestIds,
    kind,
    ...(text !== undefined && { text }),
    ...(error !== undefined && { error: { code: error.code, message: error.message } }),
  };
}

/** The run's entries, oldest first; none for an input that was never placed (withdrawn while queued). */
async function runEntries(conversation: Conversation, record: SettledInput, ctx: Context): Promise<EntryRecord[]> {
  const from = record.entry;
  if (from === undefined) return [];
  const to = record.status === "done" ? record.answer : undefined;
  const newestFirst: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries({ minEntryId: from, ...(to !== undefined && { maxEntryId: to }) }, PAGE, cursor, ctx);
    newestFirst.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const entries = newestFirst.reverse();
  if (to !== undefined) return entries;
  // Unanswered: the run ended at its last entry before the next input.
  const next = entries.findIndex((entry, index) => index > 0 && entry.kind === "pi.user");
  return next === -1 ? entries : entries.slice(0, next);
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
