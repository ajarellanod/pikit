/**
 * A run's terminal record (what Pi's `run_end` announces) as the core's `AgentResult`.
 */

import type { AgentLane, AgentMessage, Context, Entry, OperationResultRecord } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentResult, ConversationRef } from "@pikit/core";
import { requestIdOf } from "./inbound.ts";

export async function toResult(
  lane: AgentLane,
  conversation: ConversationRef,
  record: OperationResultRecord,
  ctx: Context,
): Promise<AgentResult> {
  const entries = await runEntries(lane, record, ctx);
  const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const base = {
    conversation,
    requestId: record.operationId,
    requestIds: requestsOf(record.operationId, messages),
    messages,
    usage: runUsage(entries),
  };
  if (record.status === "completed") {
    const text = finalText(messages);
    return { ...base, kind: "completed", ...(text !== undefined && { text }) };
  }
  if (record.status === "aborted") return { ...base, kind: "aborted" };
  // `declined` belongs to compactions and navigations; a run that reports it did not answer.
  const error = record.error ?? { code: record.status, message: `run ended as ${record.status}` };
  return { ...base, kind: "failed", error: { code: error.code, message: error.message } };
}

/**
 * The entries the run added, oldest first: its branch from `tipId` back to `fromTipId`, excluded. Pi
 * walks a branch from `start` towards the root only `newestFirst` (`oldestFirst` starts at the root),
 * and includes the `stopAtId` entry; checked on 0.87.1.
 */
async function runEntries(lane: AgentLane, record: OperationResultRecord, ctx: Context): Promise<Entry[]> {
  if (record.tipId === null || record.tipId === record.fromTipId) return [];
  const entries = await lane.findEntries(
    { start: record.tipId, ...(record.fromTipId !== null && { stopAtId: record.fromTipId }), order: "newestFirst" },
    ctx,
  );
  return entries.reverse().filter((entry) => entry.id !== record.fromTipId);
}

/**
 * What the run cost: the sum of the usage Pi recorded on the run's own entries, in Pi's numbers
 * (pi-ai prices each response; nothing is priced here). That is every model response, failed
 * attempts before a retry included, every tool result that reports usage, and a compaction or branch
 * summary made inside the run. They are the rows of Pi's usage ledger that point to an entry.
 *
 * Pi 0.87.1 does not tie its other ledger rows to an operation (a hook's own model request, an
 * extension's `recordUsage` without an entry), so a run cannot claim them; the session's totals
 * (`getStats`) still count them. Pi's durable runtime keeps a completed attempt's usage on its entry
 * (SPEC §6.4), so this reading survives the move. A run that called no model reports zero.
 */
export function runUsage(entries: readonly Entry[]): Usage {
  let total = ZERO;
  for (const entry of entries) {
    const usage = entry.type === "message" ? messageUsage(entry.message) : "usage" in entry ? entry.usage : undefined;
    if (usage !== undefined) total = addUsage(total, usage);
  }
  return total;
}

function messageUsage(message: AgentMessage): Usage | undefined {
  return (message.role === "assistant" || message.role === "toolResult") ? message.usage : undefined;
}

const ZERO: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Pi's own `addUsage` (`harness/utils/usage.js`, which 0.87.1 does not export): the optional fields
 * appear only when one side reports them, so "not reported" stays distinct from zero.
 */
function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...((left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined) && {
      cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
    }),
    ...((left.reasoning !== undefined || right.reasoning !== undefined) && {
      reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    }),
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

/**
 * The requests the run took: the inbound messages among its own entries, in transcript order. The
 * starter is always first; it is in the run's entries unless the run began before them.
 */
function requestsOf(starter: string, messages: readonly AgentMessage[]): string[] {
  const taken = messages.map(requestIdOf).filter((id): id is string => id !== undefined && id !== starter);
  return [starter, ...new Set(taken)];
}

/** The last assistant message that answers rather than calls tools. */
function finalText(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || message.stopReason === "toolUse") continue;
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  }
  return undefined;
}
