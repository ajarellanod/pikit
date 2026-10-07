/**
 * The `agent.submissions` conformance fixture (`createSubmissionsConformance`) on the durable runtime:
 * the runtime-pi provider (`createDurableRuntime`) over pi-durable, whatever keeps its records (the
 * caller's `storage.sql`: a SQLite file on a server, storage-do in workerd). Neutral: it touches no disk.
 *
 * The suite writes as a runtime would (`SubmissionsRecorder`); the real runtime records only from
 * pi-durable's own commits. So each write is done the way the world makes the runtime do it:
 *
 * - `admitted`: the message is dispatched (`agent.runtime.dispatch`). A conversation with no run going
 *   starts one; one with a run going queues it, for the next run to take with the others.
 * - `settled`: the requests of the run not admitted yet are dispatched, then the run going in its
 *   conversation ends as the settlement says: the model answers its `text`, or fails with its error's
 *   message (pi-durable's reason, `model_error`, is the code), or the run is aborted. Which requests it
 *   took is the runtime's to decide, not the suite's: the suite settles runs as the runtime groups
 *   them. A run already settled is redelivered instead (its first request dispatched again): what
 *   "settled again" is for the real runtime, which reconciles and appends nothing.
 * - `abandoned`: the runtime's own `abandon`, which gives up on the requests still queued.
 *
 * The suite's conversations (`conversationId` `conversation-1`) are pi-durable's (`1`, `2`…) in the
 * runtime: the fixture creates one for each, on first use, and translates the ids both ways. The
 * model (`gate/model`) holds each call until the fixture says how the run ends.
 */

import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import {
  type AgentSubmissions,
  type ConversationRef,
  defineAgent,
  type FeedPage,
  type PendingConversation,
  type RunSettlement,
  type SubmissionStatus,
} from "@pikit/contracts";
import type { RecordingSubmissions, SubmissionsFixture } from "@pikit/contracts/testing";
import { modelsFrom } from "../models.ts";
import { createDurableRuntime, type DurableRuntime } from "../runtime.ts";

/** Where the fixture keeps what outlives a runtime: components providing `storage.sql` over the same records each time. */
export interface SubmissionsFixtureRecords {
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  dispose?(): Promise<void>;
}

/** The suite's agent. */
const AGENT = "support";
/** How long the fixture waits for the runtime (a model call, a settlement logged). */
const TIMEOUT_MS = 5_000;
/** The model calls one provider answers. */
const CALLS = 1_000;

type Ending = { text: string } | { error: string };

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`submissions fixture: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * The model: each call waits until the fixture ends the run of its conversation (named by the first
 * word of the newest user message, the conversation's key) or the call is aborted.
 */
function gateModel() {
  /** Per conversation key, the call waiting for its run's ending. */
  const waiting = new Map<string, (ending: Ending) => void>();
  const faux = fauxProvider({ provider: "gate", models: [{ id: "model" }] });
  const step: FauxResponseFactory = (context, options) => {
      const newest = [...context.messages].reverse().find((message) => message.role === "user");
      const text = typeof newest?.content === "string" ? newest.content : (newest?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      const key = text.split(" ")[0] ?? "";
      return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
        const signal = options?.signal;
        const end = (ending: Ending) => {
          waiting.delete(key);
          resolve("text" in ending ? fauxAssistantMessage(ending.text) : fauxAssistantMessage("", { stopReason: "error", errorMessage: ending.error }));
        };
        // Aborted: what it answers is dropped (pi-durable sees the abort). A call may begin aborted: a
        // closing Harness starts the next queued run with its signal already aborted.
        if (signal?.aborted) return end({ text: "" });
        signal?.addEventListener("abort", () => end({ text: "" }), { once: true });
        waiting.set(key, end);
      });
  };
  faux.setResponses(Array.from({ length: CALLS }, () => step));
  return {
    provider: faux.provider,
    /** Waits for a call of `key`'s run, and ends it. */
    async end(key: string, ending: Ending): Promise<void> {
      const call = await until(`a model call in ${key}`, async () => waiting.get(key));
      call(ending);
    },
    /** Waits for a call of `key`'s run. */
    called: (key: string) => until(`a model call in ${key}`, async () => (waiting.has(key) ? true : undefined)),
    reset: () => waiting.clear(),
  };
}

export function createPiSubmissionsFixture(records: SubmissionsFixtureRecords): SubmissionsFixture {
  const model = gateModel();
  const agent = defineAgent({ name: AGENT, model: "gate/model" });
  let runtime: DurableRuntime | undefined;
  let app: App | undefined;

  const underTest = defineComponent({
    name: "runtime-under-test",
    setup(pikit) {
      const sql = pikit.use("storage.sql");
      let mine: DurableRuntime | undefined;
      return {
        start(ctx) {
          mine = createDurableRuntime({
            db: sql.get(),
            agent: (name) => (name === AGENT ? agent : undefined),
            models: modelsFrom([model.provider]),
            events: ctx.derive(() => BACKGROUND_CONTEXT),
          });
          runtime = mine;
        },
        async stop(ctx) {
          await mine?.close(ctx);
          if (runtime === mine) runtime = undefined;
        },
      };
    },
  });

  const open = async (): Promise<void> => {
    app = await defineApp({
      components: [...records.components, underTest],
      ...(records.config !== undefined && { config: records.config }),
      logger: silentLogger,
    }).create();
    await app.start();
  };
  const close = async (): Promise<void> => {
    await app?.stop();
    app = undefined;
    model.reset();
  };
  const opening = open();
  const use = async (): Promise<DurableRuntime> => {
    await opening;
    if (runtime === undefined) throw new Error("submissions fixture: the runtime is not running");
    return runtime;
  };

  /** The runtime's conversation of each of the suite's, by the suite's `conversationId`; and back, by key. */
  const real = new Map<string, Promise<ConversationRef>>();
  const suiteIds = new Map<string, string>();
  const toReal = (conversation: Pick<ConversationRef, "conversationId"> & Partial<ConversationRef>, ctx: AppContext): Promise<ConversationRef> => {
    let ref = real.get(conversation.conversationId);
    if (ref === undefined) {
      const key = conversation.key ?? `test:${conversation.conversationId}`;
      ref = use().then(async (r) => ({ key, agent: conversation.agent ?? AGENT, conversationId: await r.createConversation(ctx) }));
      real.set(conversation.conversationId, ref);
      suiteIds.set(key, conversation.conversationId);
    }
    return ref;
  };
  const toSuite = (ref: ConversationRef): ConversationRef => ({ key: ref.key, agent: ref.agent, conversationId: suiteIds.get(ref.key) ?? ref.conversationId });
  const run = (settlement: RunSettlement): RunSettlement => ({ ...settlement, conversation: toSuite(settlement.conversation) });
  const page = (read: FeedPage<RunSettlement>): FeedPage<RunSettlement> => ({ ...read, items: read.items.map((item) => ({ cursor: item.cursor, fact: run(item.fact) })) });
  const status = (found: SubmissionStatus | undefined): SubmissionStatus | undefined =>
    found === undefined ? undefined : found.kind === "pending" ? { ...found, conversation: toSuite(found.conversation) } : { ...found, conversation: toSuite(found.conversation), run: run(found.run) };

  const everyAnswer = async (): Promise<RunSettlement[]> => {
    const all: RunSettlement[] = [];
    let after: string | undefined;
    for (;;) {
      const read = await (await use()).submissions.answers.read(after, 100);
      all.push(...read.items.map((item) => item.fact));
      if (read.items.length < 100) return all;
      after = read.items.at(-1)?.cursor;
    }
  };
  const dispatch = async (ref: ConversationRef, requestId: string, ctx: AppContext) => {
    await (await use()).dispatch({ requestId, conversation: ref, prompt: `${ref.key} ${requestId}` }, ctx);
  };

  const answers: AgentSubmissions["answers"] = { read: async (after, limit) => page(await (await use()).submissions.answers.read(after, limit)) };

  const submissions: RecordingSubmissions = {
    async pending(ctx) {
      const list = await (await use()).submissions.pending(ctx);
      return list.map((entry): PendingConversation => ({ ...entry, conversation: toSuite(entry.conversation) }));
    },
    async get(conversation, requestId, ctx) {
      return status(await (await use()).submissions.get(await toReal(conversation, ctx), requestId, ctx));
    },
    answers,
    async admitted(conversation, requestId, ctx) {
      await dispatch(await toReal(conversation, ctx), requestId, ctx);
    },
    async settled(settlement, ctx) {
      const r = await use();
      const ref = await toReal(settlement.conversation, ctx);
      if ((await r.submissions.get(ref, settlement.requestId, ctx))?.kind === "settled") {
        // Settled already: the world redelivers it, and the runtime reconciles.
        await dispatch(ref, settlement.requestId, ctx);
        return;
      }
      for (const requestId of settlement.requestIds) {
        if ((await r.submissions.get(ref, requestId, ctx)) === undefined) await dispatch(ref, requestId, ctx);
      }
      if (settlement.kind === "aborted") {
        await model.called(ref.key);
        await r.abort(ref, ctx);
      } else {
        await model.end(ref.key, settlement.kind === "failed" ? { error: settlement.error?.message ?? "" } : { text: settlement.text ?? "" });
      }
      // Until its run is logged in `answers`, where the suite reads it.
      await until(`the run of ${settlement.requestId} in answers`, async () =>
        (await everyAnswer()).some((logged) => logged.conversation.conversationId === ref.conversationId && logged.requestIds.includes(settlement.requestId)) ? true : undefined,
      );
    },
    async abandoned(conversation, requestIds, reason, ctx) {
      const r = await use();
      const ref = await toReal(conversation, ctx);
      const before = (await everyAnswer()).length;
      await r.abandon(ref, requestIds, reason, ctx);
      const appended = (await everyAnswer()).slice(before).find((logged) => logged.conversation.conversationId === ref.conversationId && logged.error?.code === "abandoned");
      return appended === undefined ? undefined : run(appended);
    },
  };

  return {
    submissions: () => submissions,
    async restart() {
      await opening;
      await close();
      await open();
    },
    async dispose() {
      await opening.catch(() => {});
      await close();
      await records.dispose?.();
    },
  };
}
