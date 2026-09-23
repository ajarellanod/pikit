/**
 * The admission bridge (SPEC §6.4, gaps 1–4). `pi-agent-core` 0.87.1 has no submissions: no
 * request id on queued messages, no atomic "run if idle, otherwise queue", no duplicate check, and
 * `abort()` drops queued messages without a trace. Pi's durable runtime (`pi-durable`) has all of
 * them. Until the adapter moves there, these helpers rebuild that behaviour from records Pi
 * already writes, and this file is deleted on the move.
 *
 * - Every inbound message is a Pi `custom` message carrying its request id, so the id is committed
 *   with the message, first in the inbox and then in the transcript (gap 3).
 * - A request is a duplicate if its id is in the inbox, in the transcript, or among the ids an
 *   abort withdrew (gaps 1 and 4).
 * - An abort's withdrawn messages are recorded as one custom entry, as Pi's durable runtime records
 *   them `unanswered` (gap 4).
 */

import {
  type AgentLane,
  type AgentMessage,
  type Context,
  createCustomMessage,
  type Entry,
  laneState,
  pendingEntry,
  type Session,
} from "@earendil-works/pi-agent-core";

/** A pikit conversation drives one Pi lane; Pi's other lanes are its own transcript scopes. */
export const LANE = "main";

/** `customType` of an inbound message. Pi's default conversion gives it to the model as user input. */
export const INBOUND = "pikit.inbound";

/** `customType` of the entry that records the requests an abort withdrew from the inbox. */
export const WITHDRAWN = "pikit.withdrawn";

/**
 * How far back the transcript is scanned for a request id. Platforms redeliver within minutes or
 * hours; a scan of the whole branch would grow with the conversation. Compaction keeps old entries
 * on the branch, so it does not shorten the window.
 */
export const DEDUP_WINDOW = 1000;

export function inboundMessage(requestId: string, text: string): AgentMessage {
  return createCustomMessage(INBOUND, text, true, { requestId }, Date.now());
}

export function requestIdOf(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== INBOUND) return undefined;
  const details = message.details as { requestId?: unknown } | undefined;
  return typeof details?.requestId === "string" ? details.requestId : undefined;
}

function withdrawnIds(data: unknown): string[] {
  const ids = (data as { requestIds?: unknown } | undefined)?.requestIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function entryHolds(entry: Entry, requestId: string): boolean {
  if (entry.type === "message") return requestIdOf(entry.message) === requestId;
  return entry.type === "custom" && entry.customType === WITHDRAWN && withdrawnIds(entry.data).includes(requestId);
}

/**
 * Whether the conversation already has `requestId`. The inbox is read from Pi's lane records
 * (`laneState`, `pendingEntry`), which follow Pi's storage layout: one more reason to pin Pi.
 */
export async function hasRequest(session: Session, lane: AgentLane, requestId: string, ctx: Context): Promise<boolean> {
  const state = await session.getValue(laneState(LANE), ctx);
  for (const item of state?.value.inbox ?? []) {
    const pending = (await session.getValue(pendingEntry(item.entryId), ctx))?.value;
    if (pending?.type === "message" && requestIdOf(pending.payload) === requestId) return true;
    if (pending?.type === "custom" && pending.customType === WITHDRAWN && withdrawnIds(pending.payload).includes(requestId)) {
      return true;
    }
  }
  const scans = [
    lane.findEntries({ type: "message", order: "newestFirst", limit: DEDUP_WINDOW }, ctx),
    lane.findEntries({ type: "custom", customType: WITHDRAWN, order: "newestFirst", limit: DEDUP_WINDOW }, ctx),
  ];
  for (const entries of await Promise.all(scans)) {
    if (entries.some((entry) => entryHolds(entry, requestId))) return true;
  }
  return false;
}

/**
 * Record the requests an abort took out of the inbox. Pi returns them only in memory; without this
 * entry a redelivery would run as new. A crash between Pi's abort and this write loses the record,
 * not a message: the message was already withdrawn.
 */
export async function recordWithdrawn(lane: AgentLane, messages: readonly AgentMessage[], ctx: Context): Promise<void> {
  const requestIds = messages.map(requestIdOf).filter((id): id is string => id !== undefined);
  if (requestIds.length === 0) return;
  await lane.appendCustomEntry(WITHDRAWN, { requestIds }, ctx);
}
