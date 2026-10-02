/**
 * Facts about @earendil-works/pi-durable 1.0.0 that the durable runtime (`runtime.ts`) relies on,
 * asserted on pi-durable directly (a `MemoryStorage`, pi-ai 1.0's faux provider), so a Pi bump that
 * changes one fails here before it breaks the runtime. Each names what depends on it.
 */

import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type CommitChange,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  type EntryId,
  Harness,
  InboxDoc,
  LiveDoc,
  MemoryStorage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openSqliteDatabase } from "./testing/sqlite.ts";
import { openDurableStorage } from "./sql.ts";
import { databaseFile } from "./test-support.ts";

const ctx = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

/** A step that waits for `release()` before answering `text`. */
function gated(text: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const reachedP = new Promise<void>((resolve) => (reached = resolve));
  const step: FauxResponseStep = async () => {
    reached();
    await released;
    return fauxAssistantMessage(text);
  };
  return { step, reached: reachedP, release: () => release() };
}

async function open(
  responses: FauxResponseStep[],
  options: {
    registry?: ReturnType<typeof createRegistry>;
    now?: () => number;
    retry?: object;
    followUpMode?: "all" | "one-at-a-time";
    model?: { provider: string; modelId: string };
  } = {},
) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const changes: CommitChange[][] = [];
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry: options.registry ?? createRegistry(),
      ...(options.now !== undefined && { now: options.now }),
      // The runtime's queue modes (runtime.ts): follow-ups, all at once.
      settings: { followUpMode: options.followUpMode ?? "all", steeringMode: "all", ...(options.retry !== undefined && { retry: options.retry }) },
    },
    ctx,
  );
  harness.subscribeCommits((publication) => void changes.push([...publication.changes]));
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: options.model ?? MODEL } }, ctx);
  const submissions = (filter: (record: SubmissionRecord) => boolean = () => true) =>
    changes.flat().flatMap((change) => (change.type === "submission" && filter(change.value) ? [change.value] : []));
  /** The sequence of the commit that appended entry `id`. */
  const commitOf = async (id: EntryId | undefined) => (id === undefined ? undefined : (await storage.entry(id, ctx))?.commitSeq);
  return { harness, conversation, faux, changes, submissions, commitOf };
}

describe("pi-durable facts (1.0.0)", () => {
  test("a known requestId returns its submission and commits nothing; another type under it throws (duplicate admission)", async () => {
    const { harness, conversation, changes } = await open([fauxAssistantMessage("one")]);
    const first = await conversation.submit({ type: "input", content: "hello", requestId: "r1" }, ctx);
    await first.wait(ctx);
    const commits = changes.length;

    const again = await conversation.submit({ type: "input", content: "hello", requestId: "r1" }, ctx);

    expect(again.id).toBe(first.id);
    expect(changes.length).toBe(commits);
    await expect(conversation.submit({ type: "write", entry: { kind: "x" }, requestId: "r1" }, ctx)).rejects.toThrow("already identifies");
    // A read-only commit is how the runtime asks before it submits.
    expect((await conversation.commit((tx) => tx.submissionByRequest(conversation.id, "r1"), ctx))?.id).toBe(first.id);
    await harness.close(ctx);
  });

  test("the commit creating a submission is published, with its first status, before submit() resolves (Admission)", async () => {
    const gate = gated("one");
    const { harness, conversation, submissions } = await open([gate.step, fauxAssistantMessage("two")]);
    const seen: string[] = [];

    await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx);
    seen.push(...submissions((r) => r.requestId === "r1").map((r) => r.status));
    await gate.reached;
    await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);
    seen.push(...submissions((r) => r.requestId === "r2").map((r) => r.status));

    expect(seen).toEqual(["placed", "queued"]);
    gate.release();
    await harness.waitForIdle(ctx);
    await harness.close(ctx);
  });

  test("followUpMode all: the follow-ups queued during a run start the next run together, in one commit, and settle with one answer (batching)", async () => {
    const gate = gated("one");
    const { harness, conversation, changes, commitOf } = await open([gate.step, fauxAssistantMessage("two and three")]);
    const first = await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx);
    await gate.reached;
    const second = await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);
    const third = await conversation.submit({ type: "input", content: "three", requestId: "r3" }, ctx);

    gate.release();
    const [one, two, three] = await Promise.all([first, second, third].map((submission) => submission.wait(ctx)));

    expect([one?.status, two?.status, three?.status]).toEqual(["done", "done", "done"]);
    // One answer for the two queued inputs, another for the first: two runs.
    const answers = [one, two, three].map((record) => (record?.status === "done" ? record.answer : undefined));
    expect(answers[1]).toBe(answers[2]);
    expect(answers[0]).not.toBe(answers[1]);
    // The commit that placed them started the run with both (pi.live.run.inputs, read by `observe`)...
    const placing = changes.find((commit) => commit.some((change) => change.type === "submission" && change.value.id === second.id && change.value.status === "placed"));
    const run = placing?.find((change) => change.type === "document" && change.record.kind === "pi.live");
    expect((run?.type === "document" ? (run.value as { run?: { inputs: number[] } }).run?.inputs : undefined)).toEqual([second.id, third.id]);
    // ...and the commit that ended it settled both (`runsOf`).
    const ending = changes.find((commit) => commit.some((change) => change.type === "submission" && change.value.id === second.id && change.value.status === "done"));
    expect(ending?.flatMap((change) => (change.type === "submission" && change.value.status === "done" ? [change.value.id] : []))).toEqual([second.id, third.id]);
    // Their `pi.user` entries were appended by that commit: they share its sequence, the first run's
    // input has another (`storedRunsOf`).
    const [seqOne, seqTwo, seqThree] = await Promise.all([one, two, three].map((record) => commitOf(record?.entry)));
    expect(seqTwo).toBeNumber();
    expect(seqThree).toBe(seqTwo);
    expect(seqOne).not.toBe(seqTwo);
    await harness.close(ctx);
  });

  test("two runs that failed in a row, with nothing between their inputs, placed them in different commits (storedRunsOf)", async () => {
    // A model no provider has fails a run before anything follows its input (`no_model`).
    const { harness, conversation, commitOf } = await open([], { model: { provider: "faux", modelId: "missing" } });
    const one = await (await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx)).wait(ctx);
    const two = await (await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx)).wait(ctx);

    expect([one, two].map((record) => [record.status, record.reason])).toEqual([
      ["unanswered", "no_model"],
      ["unanswered", "no_model"],
    ]);
    if (one.entry === undefined || two.entry === undefined) throw new Error("expected placed inputs");
    // Adjacent, and ended the same way: only their commits tell the two runs apart.
    const between = await conversation.entries({ minEntryId: one.entry, maxEntryId: two.entry }, 100, undefined, ctx);
    expect(between.items.map((entry) => entry.kind)).toEqual(["pi.user", "pi.user"]);
    expect(await commitOf(one.entry)).toBeLessThan((await commitOf(two.entry)) as number);
    await harness.close(ctx);
  });

  test("followUpMode one-at-a-time places follow-ups one per run; pi.live.run marks the busy span", async () => {
    const gate = gated("one");
    const { harness, conversation, changes } = await open([gate.step, fauxAssistantMessage("two"), fauxAssistantMessage("three")], { followUpMode: "one-at-a-time" });
    const first = await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx);
    await gate.reached;
    const second = await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);
    const third = await conversation.submit({ type: "input", content: "three", requestId: "r3" }, ctx);
    expect((await harness.snapshot(InboxDoc, conversation.id, ctx))?.items.map((item) => item.mode)).toEqual(["followUp", "followUp"]);

    gate.release();
    const settled = await Promise.all([first, second, third].map((submission) => submission.wait(ctx)));

    const answers = settled.map((record) => (record.status === "done" ? record.answer : undefined));
    expect(new Set(answers).size).toBe(3);
    expect(settled.map((record) => record.status)).toEqual(["done", "done", "done"]);
    const runs = changes
      .flat()
      .flatMap((change) => (change.type === "document" && change.record.kind === "pi.live" ? [(change.value as { run?: { inputs: number[] } } | null)?.run?.inputs] : []))
      .filter((inputs, index, all) => JSON.stringify(inputs) !== JSON.stringify(all[index - 1]));
    expect(runs).toEqual([[first.id], [second.id], [third.id], undefined]);
    await harness.close(ctx);
  });

  test("a run that fails leaves the follow-ups in the inbox; a write submission places the oldest and starts its run (reconcileInbox)", async () => {
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => (fail = resolve));
    let reached!: () => void;
    const reachedP = new Promise<void>((resolve) => (reached = resolve));
    const broken: FauxResponseStep = async () => {
      reached();
      await failing;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted failure" });
    };
    const { harness, conversation } = await open([broken, fauxAssistantMessage("two")]);
    const first = await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx);
    await reachedP;
    const second = await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);
    fail();

    expect(await first.wait(ctx)).toMatchObject({ status: "unanswered", reason: "model_error", detail: "scripted failure" });
    await harness.waitForIdle(ctx);
    expect((await second.status(ctx)).status).toBe("queued");
    expect((await harness.snapshot(LiveDoc, conversation.id, ctx))?.run).toBeUndefined();

    await conversation.submit({ type: "write", entry: { kind: "pikit.inbox-kick" } }, ctx);

    expect((await second.wait(ctx)).status).toBe("done");
    // The write is an entry without model messages: the model never sees it.
    const kick = (await conversation.entries({}, 100, undefined, ctx)).items.find((entry) => entry.kind === "pikit.inbox-kick");
    expect(kick?.model).toBeUndefined();
    await harness.close(ctx);
  });

  test("abort withdraws queued inputs unanswered (aborted, never placed) and ends the run's input aborted (placed)", async () => {
    const registry = createRegistry();
    let started!: () => void;
    const holding = new Promise<void>((resolve) => (started = resolve));
    let signalled = false;
    registry.install(
      defineExtension({
        name: "hold",
        tools: [
          defineTool({
            name: "hold",
            description: "Holds until aborted",
            parameters: Type.Object({}),
            execute: async (_args, _api, context) => {
              started();
              await new Promise<void>((_, reject) =>
                context.abortSignal?.addEventListener("abort", () => {
                  signalled = true;
                  reject(context.abortSignal?.reason);
                }),
              );
              return {};
            },
          }),
        ],
      }),
    );
    const { harness, conversation } = await open([fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" })], { registry });
    const first = await conversation.submit({ type: "input", content: "hold", requestId: "r1" }, ctx);
    await holding;
    const second = await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);

    await conversation.abort(ctx);

    expect(signalled).toBe(true);
    const [one, two] = [await first.wait(ctx), await second.wait(ctx)];
    expect([one.status, one.reason, one.entry !== undefined]).toEqual(["unanswered", "aborted", true]);
    expect([two.status, two.reason, two.entry]).toEqual(["unanswered", "aborted", undefined]);
    await harness.close(ctx);
  });

  test("a done input spans its pi.user entry to its answer; pi.system entries follow the input (result.ts)", async () => {
    const { harness, conversation } = await open([fauxAssistantMessage("hi")]);
    await conversation.configure({ instructions: "be brief" }, ctx);
    const settled = await (await conversation.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    if (settled.status !== "done" || settled.type !== "input") throw new Error("expected an answer");

    const page = await conversation.entries({ minEntryId: settled.entry, maxEntryId: settled.answer }, 100, undefined, ctx);

    const kinds = [...page.items].reverse().map((entry) => entry.kind);
    expect(kinds[0]).toBe("pi.user");
    expect(kinds.at(-1)).toBe("pi.assistant");
    expect(kinds).toContain("pi.system");
    await harness.close(ctx);
  });

  test("the conversation's pi.agent decides the request: the selected extensions' tools, filtered by name (agent.ts)", async () => {
    const tool = (name: string) => defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({}) });
    const registry = createRegistry();
    const mine = defineExtension({ name: "pikit.agent.a", tools: [tool("read"), tool("write")] });
    registry.install(mine);
    registry.install(defineExtension({ name: "pikit.agent.b", tools: [tool("bash")] }));
    const offered: string[][] = [];
    const record: FauxResponseStep = (context) => {
      offered.push(context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((t) => t.name) : [])));
      return fauxAssistantMessage("ok");
    };
    const { harness, conversation } = await open([record], { registry });
    await conversation.commit((tx) => configure(tx, conversation.id, { extensions: [mine], tools: [tool("write")], instructions: "be brief" }), ctx);

    await (await conversation.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);

    expect(offered).toEqual([["write"]]);
    expect(await harness.snapshot(AgentDoc, conversation.id, ctx)).toMatchObject({ extensions: ["pikit.agent.a"], tools: ["write"], instructions: "be brief" });
    await harness.close(ctx);
  });

  test("a conversation document survives a new Harness over the storage, and a new conversation starts from its initial value (agent.state)", async () => {
    const Doc = defineDoc<{ phase?: string }>({ kind: "pikit.fact", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}) });
    const file = databaseFile();
    try {
      const reopen = async () => {
        const sqlite = openSqliteDatabase(file.path);
        const harness = await Harness.open(await openDurableStorage(sqlite.database), { models: createModels(), registry: createRegistry() }, ctx);
        return { harness, close: () => harness.close(ctx).then(() => sqlite.close()) };
      };
      const first = await reopen();
      const conversation = await first.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      await conversation.commit(async (tx) => void ((await tx.doc(Doc, conversation.id)).phase = "deploying"), ctx);
      await first.close();

      const second = await reopen();
      expect(await second.harness.snapshot(Doc, conversation.id, ctx)).toEqual({ phase: "deploying" });
      const fresh = await second.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      expect(await second.harness.snapshot(Doc, fresh.id, ctx)).toBeUndefined();
      await second.close();
    } finally {
      file.dispose();
    }
  });

  test("a model retry waits in-process: its generation's checkpoint is phase retry with `until`, on the Harness clock (whenIdle, wakeups)", async () => {
    let clock = 1_000_000;
    const { harness, conversation } = await open(
      [fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }), fauxAssistantMessage("answered")],
      { now: () => clock, retry: { baseDelayMs: 5_000 } },
    );
    await conversation.submit({ type: "input", content: "hello" }, ctx);
    let checkpoint: { phase?: string; until?: number } | undefined;
    for (let i = 0; i < 200 && checkpoint?.phase !== "retry"; i++) {
      await Bun.sleep(2);
      const task = (await harness.inspect(ctx)).tasks.find((t) => t.record.kind === "pi.generation");
      checkpoint = (task?.record.state as { checkpoint?: typeof checkpoint } | undefined)?.checkpoint;
    }

    expect(checkpoint).toMatchObject({ phase: "retry", until: 1_005_000 });
    expect((await harness.snapshot(LiveDoc, conversation.id, ctx))?.generation?.retry?.at).toBe(1_005_000);
    // The sleep is a timer in this process: closing abandons it, and the next Harness continues from the checkpoint
    // (recovery.test.ts).
    await harness.close(ctx);
  });

  test("pi-durable sends the provider no session id: a provider's prompt-cache key gets none", async () => {
    const options: unknown[] = [];
    const { harness, conversation } = await open([
      (_context, streamOptions) => {
        options.push(streamOptions?.sessionId);
        return fauxAssistantMessage("ok");
      },
    ]);
    await (await conversation.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    expect(options).toEqual([undefined]);
    await harness.close(ctx);
  });
});
