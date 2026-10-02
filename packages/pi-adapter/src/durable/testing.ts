/**
 * A pi-durable `Harness` smoke over `storage.sql`, in phases a runner calls with a database over the
 * same data each time: a fresh app over the same file (Bun), or the same Durable Object after an
 * eviction (workerd). Runner-independent: a failed check throws. Spike: see README.md.
 *
 * The model is pi-ai 1.0's faux provider, imported through the `pi-ai-v1` alias, a dependency that
 * is temporary until the adapter itself moves to pi-ai 1.0.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryId,
  Harness,
  type Registry,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { SqlDatabase } from "@pikit/contracts";
import { createModels } from "pi-ai-v1/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "pi-ai-v1/providers/faux";
import { Type } from "pi-ai-v1";
import { openDurableStorage } from "./sql.ts";

// Re-exported so a lane (workerd) runs pi-durable's suite without importing Pi itself.
export { registerStorageConformance } from "@earendil-works/pi-durable/testing";
export { fauxAssistantMessage };
/** The Chord context every call here passes: never cancelled. */
export const context = BACKGROUND_CONTEXT;
/** The faux provider's model, as a conversation's agent names it. */
export const MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** What the first phase leaves for the next one to find. */
export interface AnsweredRun {
  rootId: ConversationId;
  submissionId: SubmissionId;
  entries: { id: EntryId; kind: string }[];
}

/** A Harness over `db`, answering with `responses`; `close` closes it (never the database). */
export async function openHarness(db: SqlDatabase, responses: FauxResponseStep[], registry: Registry = createRegistry()): Promise<Harness> {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return Harness.open(await openDurableStorage(db), { models, registry }, context);
}

/**
 * A run with a tool call: its arguments validated against a TypeBox schema (pi-ai's
 * `validateToolArguments`, which compiles the schema), the tool run as its own task, its result in
 * the transcript, then the final answer.
 */
export async function answerWithTool(db: SqlDatabase): Promise<void> {
  const calls: string[] = [];
  const echo = defineTool({
    name: "echo",
    description: "Echo the text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => {
      calls.push(args.text);
      return { content: [{ type: "text", text: args.text }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "echo", tools: [echo] }));
  const harness = await openHarness(db, [fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }), fauxAssistantMessage("Echoed.")], registry);
  try {
    const root = await harness.root(context, { agent: { model: MODEL } });
    const settled = await (await root.submit({ type: "input", content: "Echo hi" }, context)).wait(context);
    check(settled.status === "done" && settled.type === "input", `the input to be answered, got ${JSON.stringify(settled)}`);
    same(calls, ["hi"], "the tool's calls");
    same(await answerText(harness, settled.answer), "Echoed.", "the answer after the tool");
    const kinds = (await transcript(harness)).map((e) => e.kind);
    check(kinds.includes("pi.tool-result"), `a tool result in the transcript, got ${JSON.stringify(kinds)}`);
  } finally {
    await harness.close(context);
  }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`pi-durable smoke: ${message}`);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

async function transcript(harness: Harness): Promise<{ id: EntryId; kind: string }[]> {
  const root = await harness.root(context);
  const page = await root.entries({}, 100, undefined, context);
  return [...page.items].reverse().map((entry) => ({ id: entry.id, kind: entry.kind }));
}

async function answerText(harness: Harness, answerId: EntryId): Promise<string> {
  const root = await harness.root(context);
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, answerId), context);
  const message = entry?.model?.[0];
  check(message?.role === "assistant", "the answer to be an assistant message");
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Phase 1: root, an input answered, the same `requestId` finding the same submission; then close. */
export async function answerOnce(db: SqlDatabase): Promise<AnsweredRun> {
  const harness = await openHarness(db, [fauxAssistantMessage("Paris.")]);
  try {
    const root = await harness.root(context, { agent: { model: MODEL } });
    const submission = await root.submit({ type: "input", content: "Capital of France?", requestId: "smoke-1" }, context);
    const settled = await submission.wait(context);
    check(settled.status === "done" && settled.type === "input", `the input to be answered, got ${JSON.stringify(settled)}`);
    same(await answerText(harness, settled.answer), "Paris.", "the answer");
    const again = await root.submit({ type: "input", content: "Capital of France?", requestId: "smoke-1" }, context);
    same(again.id, submission.id, "the resubmitted requestId's submission");
    const entries = await transcript(harness);
    check(entries.some((e) => e.kind === "pi.user") && entries.some((e) => e.kind === "pi.assistant"), `a user and an assistant entry, got ${JSON.stringify(entries)}`);
    return { rootId: root.id, submissionId: submission.id, entries };
  } finally {
    await harness.close(context);
  }
}

/** Phase 2, over the same data: the same root, transcript and settled submission. */
export async function checkReopened(db: SqlDatabase, run: AnsweredRun): Promise<void> {
  const harness = await openHarness(db, []);
  try {
    const root = await harness.root(context);
    same(root.id, run.rootId, "the root after reopen");
    same(await transcript(harness), run.entries, "the transcript after reopen");
    const submission = await harness.submission(run.submissionId, context);
    check(submission !== undefined, "the submission to be found after reopen");
    same((await submission.status(context)).status, "done", "the submission's status after reopen");
    const again = await root.submit({ type: "input", content: "Capital of France?", requestId: "smoke-1" }, context);
    same(again.id, run.submissionId, "the requestId's submission after reopen");
    same((await harness.inspect(context)).tasks.length, 0, "live tasks after reopen");
  } finally {
    await harness.close(context);
  }
}

/**
 * Phase 1 of an interruption: an input whose model call never answers, and the Harness closed while
 * it waits (the generation's signal aborts it). The submission is left placed, its generation pending.
 */
export async function interruptGeneration(db: SqlDatabase): Promise<{ submissionId: SubmissionId }> {
  let started!: () => void;
  const generating = new Promise<void>((resolve) => (started = resolve));
  const hang: FauxResponseStep = async (_transcript, options) => {
    started();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("never seen");
  };
  const harness = await openHarness(db, [hang]);
  let submissionId: SubmissionId;
  try {
    const root = await harness.root(context, { agent: { model: MODEL } });
    const submission = await root.submit({ type: "input", content: "Count to three", requestId: "smoke-interrupted" }, context);
    submissionId = submission.id;
    await generating;
  } finally {
    await harness.close(context);
  }
  return { submissionId };
}

/** What a reopened Harness reports before it resumes: the interrupted generation, still live. */
export async function pendingWork(db: SqlDatabase): Promise<{ tasks: { kind: string; status: string; inspection: string }[]; submissions: string[] }> {
  const harness = await openHarness(db, []);
  try {
    const inspection = await harness.inspect(context);
    return {
      tasks: inspection.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status, inspection: t.state.kind })),
      submissions: inspection.submissions.map((s) => s.status),
    };
  } finally {
    await harness.close(context);
  }
}

/** Phase 2 of an interruption: a reopened Harness resumes the run and answers the same submission. */
export async function resumeInterrupted(db: SqlDatabase, run: { submissionId: SubmissionId }): Promise<void> {
  const harness = await openHarness(db, [fauxAssistantMessage("One, two, three.")]);
  try {
    harness.resume();
    const submission = await harness.submission(run.submissionId, context);
    check(submission !== undefined, "the interrupted submission to be found after reopen");
    const settled = await submission.wait(context);
    check(settled.status === "done" && settled.type === "input", `the interrupted input to be answered after resume, got ${JSON.stringify(settled)}`);
    same(await answerText(harness, settled.answer), "One, two, three.", "the resumed answer");
  } finally {
    await harness.close(context);
  }
}
