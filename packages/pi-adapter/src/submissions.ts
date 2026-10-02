/**
 * What the runtime keeps to provide `agent.submissions` from pi-durable (README.md, "Submissions"):
 * pi-durable holds every submission and its settlement; the runtime adds only what pi-durable has no
 * field for, and the grouping of settled inputs into runs.
 *
 * - **`AdmissionsDoc`**: the requests admitted and not yet in the answers log, per conversation, with
 *   when they were admitted (`pending`'s `oldestAdmittedAt`). A request enters it in the commit before
 *   its submission, and leaves it once its run is logged. It bounds what a reconciliation examines (a
 *   run is logged at most once, even after the log pruned it) and lists, at start, the conversations
 *   that may hold a settlement a crash left unlogged.
 * - **Runs**: the inputs one commit settles are grouped exactly (`runsOf`); inputs found settled later
 *   are grouped by `storedRunsOf` (exact for answered runs, a heuristic for unanswered ones).
 * - **Run keys** (`runKey`): an answered run is named by its answer entry, which every input it took
 *   shares; any other by its first input's submission id. Both groupings give the same key for an
 *   answered run, so a run logged live is never logged again by a reconciliation.
 */

import type { Context as ChordContext } from "@earendil-works/chord";
import { type Conversation, type ConversationId, defineDoc, type Storage } from "@earendil-works/pi-durable";
import type { SettledInput } from "./result.ts";

/** Requests admitted and not yet logged: `conversations[conversationId][requestId]` is when it was admitted (epoch ms). */
export const AdmissionsDoc = defineDoc<{ conversations: { [conversationId: string]: { [requestId: string]: number } } }>({
  kind: "pikit.admissions",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
});

/** The reason pi-durable records for inputs the runtime gave up on; `detail` is why. */
export const ABANDONED = "abandoned";

/** The key a run is logged under. `records`: one run's inputs, oldest first. */
export function runKey(records: readonly SettledInput[]): string {
  const first = records[0] as SettledInput;
  return first.status === "done" ? `${first.conversationId}:a${first.answer}` : `${first.conversationId}:s${first.id}`;
}

/** Whether a run is announced (`agent.settled` / `agent.failed`): all but inputs an abort withdrew while queued (no run took them). */
export function announced(records: readonly SettledInput[]): boolean {
  const first = records[0] as SettledInput;
  return !(first.status === "unanswered" && first.entry === undefined && first.reason === "aborted");
}

/**
 * The inputs one commit settled in a conversation, by run: the inputs a run took settle together in
 * the commit that ends it (one run per conversation and commit); inputs abandoned together (one
 * `abandon`, one commit) are one; each input an abort withdrew while queued is one of its own. Oldest first.
 */
export function runsOf(records: readonly SettledInput[]): SettledInput[][] {
  const sorted = [...records].sort((a, b) => a.id - b.id);
  const placed = sorted.filter((record) => record.entry !== undefined);
  const withdrawn = sorted.filter((record) => record.entry === undefined);
  const abandoned = withdrawn.filter((record) => record.status === "unanswered" && record.reason === ABANDONED);
  const runs = [placed, abandoned, ...withdrawn.filter((record) => !abandoned.includes(record)).map((record) => [record])];
  return runs.filter((run) => run.length > 0).sort((a, b) => (a[0] as SettledInput).id - (b[0] as SettledInput).id);
}

/**
 * Settled inputs found later (a reconciliation), by run, in the order they were most likely committed.
 *
 * - Answered inputs by their answer: exact, inputs a run answered share it.
 * - Unanswered inputs whose `pi.user` entries follow each other with nothing else between (placed
 *   together by one boundary) and that ended the same way: a heuristic. Two runs that both failed
 *   the same way with nothing between their inputs are taken for one, whose channel tells the user
 *   once instead of twice; telling them apart needs pi-durable to record a run's inputs with its end.
 * - Inputs abandoned for the same reason, together; each other withdrawn input alone.
 *
 * Ordered by the commit of each run's last entry (an answered run's answer), which `storage.entry`
 * gives; runs with no entry (withdrawn) come after, by submission id.
 */
export async function storedRunsOf(
  conversation: Conversation,
  storage: Storage,
  records: readonly SettledInput[],
  ctx: ChordContext,
): Promise<SettledInput[][]> {
  const runs: SettledInput[][] = [];
  const sorted = [...records].sort((a, b) => (a.entry ?? Number.MAX_SAFE_INTEGER) - (b.entry ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  for (const record of sorted) {
    const previous = runs.at(-1);
    const last = previous?.at(-1);
    if (previous !== undefined && last !== undefined && (await sameRun(conversation, last, record, ctx))) previous.push(record);
    else runs.push([record]);
  }
  const seqOf = new Map<SettledInput[], number>();
  for (const run of runs) {
    const first = run[0] as SettledInput;
    const entry = first.status === "done" ? first.answer : run.at(-1)?.entry;
    seqOf.set(run, entry === undefined ? Number.MAX_SAFE_INTEGER : ((await storage.entry(entry, ctx))?.commitSeq ?? Number.MAX_SAFE_INTEGER));
  }
  return runs.sort((a, b) => (seqOf.get(a) as number) - (seqOf.get(b) as number) || (a[0] as SettledInput).id - (b[0] as SettledInput).id);
}

async function sameRun(conversation: Conversation, earlier: SettledInput, later: SettledInput, ctx: ChordContext): Promise<boolean> {
  if (earlier.status !== later.status) return false;
  if (earlier.status === "done" && later.status === "done") return earlier.answer === later.answer;
  if (earlier.reason !== later.reason || JSON.stringify(earlier.detail) !== JSON.stringify(later.detail)) return false;
  if (earlier.entry === undefined || later.entry === undefined) return earlier.entry === later.entry && earlier.reason === ABANDONED;
  const between = await conversation.entries({ minEntryId: earlier.entry, maxEntryId: later.entry }, 100, undefined, ctx);
  return between.next === undefined && between.items.every((entry) => entry.kind === "pi.user");
}

/** The conversation id of a `ConversationRef`, or `undefined` if it is not one of pi-durable's (a positive integer, as a string). */
export function durableId(conversationId: string): ConversationId | undefined {
  const id = Number(conversationId);
  return Number.isSafeInteger(id) && id > 0 && String(id) === conversationId ? (id as ConversationId) : undefined;
}
