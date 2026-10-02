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
 *   are grouped exactly too (`storedRunsOf`): an answered run by its answer entry, any other placed
 *   run by the commit that placed its inputs (pi-durable places a run's inputs in the one commit that
 *   starts it, and `endRun` settles exactly those).
 * - **Run keys** (`runKey`): an answered run is named by its answer entry, which every input it took
 *   shares; any other by its first input's submission id. Both groupings give a run the same inputs
 *   (every input of a run enters and leaves `AdmissionsDoc` with the others), in submission id order,
 *   hence the same first input and key: a run logged live is never logged again by a reconciliation.
 * - **Steers** (`whenBusy: "steer"`): pi-durable places one at a tool boundary, in a later commit,
 *   and adds it to the run going. Live (`runsOf`, by the settling commit) and answered (by the answer)
 *   runs stay exact. A failed run that took a steer, found settled by a reconciliation, is grouped by
 *   placing commit, so its steer is logged as a run of its own (one more failure notice). The exact
 *   fix: mark steers' request ids in `AdmissionsDoc` at admission and assign each to the run whose
 *   `pi.live.run.inputs` it joined; or pi-durable's run identity on submissions
 *   (docs/upstream/README.md, proposal 13).
 */

import type { Context as ChordContext } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Storage } from "@earendil-works/pi-durable";
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
 * Settled inputs found later (a reconciliation), by run, in the order the runs were committed. Each
 * run has the same inputs as `runsOf` gives it live, so `runKey` names it the same way.
 *
 * - Answered inputs by their answer: inputs a run answered share it.
 * - Other placed inputs by the commit of their `pi.user` entry (`storage.entry`'s `commitSeq`): a
 *   run's inputs are placed by one boundary in the commit that starts the run, and `endRun` settles
 *   exactly those, so inputs of two runs never share it, even adjacent ones that failed the same way.
 *   A failed run that took a steer is the exception: its steer was placed in a later commit and is
 *   grouped apart (see the module comment).
 * - Inputs abandoned with the same detail, together (`abandon` settles its inputs in one commit);
 *   each other withdrawn input alone.
 *
 * Ordered by the commit of each run's last entry: an answered run's answer, another placed run's
 * inputs (a run is placed after the one before it ended); runs with no entry (withdrawn) come after,
 * by submission id. Inputs within a run are in submission id order, as `runsOf` gives them.
 */
export async function storedRunsOf(storage: Storage, records: readonly SettledInput[], ctx: ChordContext): Promise<SettledInput[][]> {
  const runs = new Map<string, { seq: number; inputs: SettledInput[] }>();
  for (const record of [...records].sort((a, b) => a.id - b.id)) {
    const last = record.status === "done" ? record.answer : record.entry;
    const seq = last === undefined ? undefined : (await storage.entry(last, ctx))?.commitSeq;
    const key =
      record.status === "done"
        ? `a${record.answer}`
        : seq !== undefined
          ? `c${seq}`
          : record.entry === undefined && record.reason === ABANDONED
            ? `x${JSON.stringify(record.detail ?? null)}`
            : `s${record.id}`;
    const run = runs.get(key) ?? { seq: seq ?? Number.MAX_SAFE_INTEGER, inputs: [] };
    run.inputs.push(record);
    runs.set(key, run);
  }
  return [...runs.values()].sort((a, b) => a.seq - b.seq || (a.inputs[0] as SettledInput).id - (b.inputs[0] as SettledInput).id).map((run) => run.inputs);
}

/** The conversation id of a `ConversationRef`, or `undefined` if it is not one of pi-durable's (a positive integer, as a string). */
export function durableId(conversationId: string): ConversationId | undefined {
  const id = Number(conversationId);
  return Number.isSafeInteger(id) && id > 0 && String(id) === conversationId ? (id as ConversationId) : undefined;
}
