/**
 * Who wrote a message of another channel's conversation, when it is not that conversation's person:
 * the muted line above its bubble (`ConversationView`'s `from`). Read from the request its entry
 * names (`ApiTranscriptEntry.requestId`, `sender`), never from its text:
 *
 * - an operator's follow-up from here (its request id starts with `dashboard:`, as `isDashboardRequest`
 *   says): "You, from the dashboard", or the operator's id when another operator sent it;
 * - a scheduled message (scheduler-admit's `scheduler:<job>:<tick>`): "Scheduled";
 * - anything else (the conversation's own person): no line.
 *
 * The dashboard's own conversations get none: every message there is an operator's.
 */

// Relative, not `@/`: scripts/dashboard.test.ts imports this module from outside the dashboard.
import type { ApiTranscriptEntry } from "../../lib/admin-api.ts";

/** The request ids of the dashboard's messages start with it (`@pikit/contracts`' `DASHBOARD_REQUEST_PREFIX`). */
const DASHBOARD_REQUEST = "dashboard:";
/** The request ids of scheduled messages start with it (scheduler-admit's `SCHEDULER_CHANNEL`). */
const SCHEDULED_REQUEST = "scheduler:";

/** The line above the message `entry` holds, for the signed-in `operator`; `undefined` for none. */
export function fromLine(entry: Pick<ApiTranscriptEntry, "requestId" | "sender">, operator: string | undefined): string | undefined {
  const { requestId, sender } = entry;
  if (requestId?.startsWith(DASHBOARD_REQUEST) === true) {
    const other = sender !== undefined && operator !== undefined && sender.id !== operator;
    return other ? `${sender.id}, from the dashboard` : "You, from the dashboard";
  }
  if (requestId?.startsWith(SCHEDULED_REQUEST) === true) return "Scheduled";
  return undefined;
}
