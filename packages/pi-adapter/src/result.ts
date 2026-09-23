/**
 * A run's terminal record (what Pi's `run_end` announces) as the core's `AgentResult`.
 */

import type { AgentLane, AgentMessage, Context, OperationResultRecord } from "@earendil-works/pi-agent-core";
import type { AgentResult, ConversationRef } from "@pikit/core";

export async function toResult(
  lane: AgentLane,
  conversation: ConversationRef,
  record: OperationResultRecord,
  ctx: Context,
): Promise<AgentResult> {
  const messages = await runMessages(lane, record, ctx);
  const base = { conversation, requestId: record.operationId, messages };
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
 * The entries the run added: its branch from `tipId` back to `fromTipId`, excluded. Pi walks a branch
 * from `start` towards the root only `newestFirst` (`oldestFirst` starts at the root), and includes
 * the `stopAtId` entry; checked on 0.87.1.
 */
async function runMessages(lane: AgentLane, record: OperationResultRecord, ctx: Context): Promise<AgentMessage[]> {
  if (record.tipId === null || record.tipId === record.fromTipId) return [];
  const entries = await lane.findEntries(
    { start: record.tipId, ...(record.fromTipId !== null && { stopAtId: record.fromTipId }), order: "newestFirst" },
    ctx,
  );
  return entries
    .reverse()
    .flatMap((entry) => (entry.type === "message" && entry.id !== record.fromTipId ? [entry.message] : []));
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
