/**
 * Test support for `wakeups.ts`, runner-independent (Bun and the workerd lane): a pi-durable `Harness`
 * over `storage.sql` on an injected clock, answering with pi-ai 1.0's faux provider (the `pi-ai-v1`
 * alias, temporary: see README.md), and readers of what a run left.
 */

import { AssistantEntry, createRegistry, Harness, type HarnessSettings, LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
import type { SqlDatabase } from "@pikit/contracts";
import { createModels } from "pi-ai-v1/models";
import { type FauxProviderHandle, type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "pi-ai-v1/providers/faux";
import { openDurableStorage } from "./sql.ts";
import { context, MODEL } from "./testing.ts";

export { context, fauxAssistantMessage, fauxProvider, MODEL };
export type { FauxProviderHandle, FauxResponseStep };

/** A model error pi-ai classifies as transient: pi-durable's generation retries it after a backoff. */
export const serviceUnavailable = (): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });

export interface ClockedHarnessOptions {
  /** The Harness's clock (`HarnessOptions.now`). */
  now: () => number;
  /**
   * The responses of a new faux provider, or the provider of an earlier Harness: its deferred
   * responses live in its memory, as a real provider's live on its servers.
   */
  faux: FauxResponseStep[] | FauxProviderHandle;
  settings?: HarnessSettings;
}

/** A Harness over `db` on `options.now`, scheduling paused until `resume()` (or a call that asks for progress). */
export async function openClockedHarness(db: SqlDatabase, options: ClockedHarnessOptions): Promise<{ harness: Harness; faux: FauxProviderHandle }> {
  let faux: FauxProviderHandle;
  if (Array.isArray(options.faux)) {
    faux = fauxProvider();
    faux.setResponses(options.faux);
  } else {
    faux = options.faux;
  }
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = options.settings === undefined ? {} : { settings: options.settings };
  const harness = await Harness.open(await openDurableStorage(db), { models, registry: createRegistry(), now: options.now, ...settings }, context);
  return { harness, faux };
}

/** Submits an input to the root conversation (created with the faux model when absent); does not wait. */
export async function submitInput(harness: Harness, content: string): Promise<SubmissionId> {
  const root = await harness.root(context, { agent: { model: MODEL } });
  return (await root.submit({ type: "input", content }, context)).id;
}

/** A submission's status, and its answer's text once answered. Asks for no progress. */
export async function answerOf(harness: Harness, id: SubmissionId): Promise<{ status: string; answer?: string }> {
  const submission = await harness.submission(id, context);
  if (submission === undefined) throw new Error(`wakeups testing: no submission ${id}`);
  const record = await submission.status(context);
  if (record.status !== "done" || record.type !== "input") return { status: record.status };
  const root = await harness.root(context);
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, record.answer), context);
  const message = entry?.model?.[0];
  const answer = message?.role === "assistant" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : undefined;
  return { status: record.status, ...(answer !== undefined && { answer }) };
}

/** The due times the root's `pi.live` shows (its presentation mirror of the checkpoints). */
export async function liveDueTimes(harness: Harness): Promise<{ retryAt?: number; pollAt?: number }> {
  const root = await harness.root(context);
  const live = await harness.snapshot(LiveDoc, root.id, context);
  const retryAt = live?.generation?.retry?.at;
  const pollAt = live?.generation?.deferred?.pollAt;
  return { ...(retryAt !== undefined && { retryAt }), ...(pollAt !== undefined && { pollAt }) };
}
