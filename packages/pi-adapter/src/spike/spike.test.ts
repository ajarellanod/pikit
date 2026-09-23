/**
 * The adapter spike's proofs (ROADMAP M1, first step), one `describe` per claim.
 * What Pi itself does not do is characterised in `pi-gaps.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  JsonlSessionRepo,
  MemorySessionRepo,
  NOOP_TELEMETRY_CONTEXT,
  withTelemetryContext,
  type AgentHarnessTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT, createContextKey, withCancel, withContextValue } from "@pikit/core";
import { SpikeConversation, toPi, type Submission } from "./conversation.ts";
import { gateTool, scriptedModel, tool } from "./fixtures.ts";

const ctx = BACKGROUND_CONTEXT;

async function openFresh(tools: AgentHarnessTool<undefined>[] = []) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({}, ctx);
  const opened = await SpikeConversation.open({ session, ...scriptedModel(), tools }, ctx);
  return { repo, session, ...opened };
}

function started(submission: Submission) {
  if (submission.kind !== "started") throw new Error(`expected a started run, got ${submission.kind}`);
  return submission;
}

describe("1. one conversation is one AgentHarness over one Pi session", () => {
  test("the harness writes into the session it was given, and only that one", async () => {
    const repo = new MemorySessionRepo();
    const a = await repo.create({}, ctx);
    const b = await repo.create({}, ctx);
    const { conversation } = await SpikeConversation.open({ session: a, ...scriptedModel() }, ctx);
    expect(conversation.sessionId).toBe(a.metadata.id);

    await started(await conversation.submit("req-1", "hello", ctx)).settled;

    expect((await a.getStats(ctx)).messageCount).toBe(2);
    expect((await b.getStats(ctx)).messageCount).toBe(0);
    await conversation.close(ctx);
  });
});

describe("2. a prompt runs to an answer", () => {
  test("idle conversation: the run completes and its answer is in the transcript", async () => {
    const { conversation } = await openFresh();
    const run = started(await conversation.submit("req-1", "hello", ctx));

    const outcome = await run.settled;

    expect(outcome.status).toBe("completed");
    expect(outcome.operationId).toBe("req-1");
    expect((await conversation.answerTo("req-1", ctx))?.text).toBe("answer: hello");
    await conversation.close(ctx);
  });
});

describe("3. a message sent mid-run is steered and its answer is attributable", () => {
  test("busy conversation: the message waits in Pi's inbox and the same run answers it", async () => {
    const gate = gateTool("gate");
    const { conversation } = await openFresh([gate.tool]);
    const run = started(await conversation.submit("req-1", "use-tool:gate", ctx));
    await gate.started;

    const queued = await conversation.submit("req-2", "change course", ctx);
    if (queued.kind !== "queued") throw new Error(`expected queued, got ${queued.kind}`);
    expect(await conversation.queued(ctx)).toEqual([{ entryId: queued.entryId, kind: "steer" }]);

    gate.open("gate opened");
    const outcome = await run.settled;

    // One run: the steer entered after the tool finished, before the next model call.
    expect(outcome.status).toBe("completed");
    expect(await conversation.queued(ctx)).toEqual([]);
    const answer = await conversation.answerTo("req-2", ctx);
    expect(answer?.text).toBe("answer: change course");
    // The prompt and the message placed in its turn settle with the same answer entry.
    expect((await conversation.answerTo("req-1", ctx))?.entryId).toBe(answer?.entryId);
    await conversation.close(ctx);
  });

  test("gap 2 closed: a message that arrives while the run is ending is answered by that run", async () => {
    const { conversation, harness } = await openFresh();
    let entered!: () => void;
    let release!: () => void;
    const ending = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    // Holds the run at its last boundary: after the final answer, before Pi commits its end.
    harness.hooks.on("before_run_end", async () => {
      if (!first) return undefined;
      first = false;
      entered();
      await held;
      return undefined;
    });
    const run = started(await conversation.submit("req-1", "hello", ctx));
    await ending;

    const late = await conversation.submit("req-2", "one more thing", ctx);
    release();

    expect(late.kind).toBe("queued");
    expect((await run.settled).status).toBe("completed");
    expect((await conversation.answerTo("req-2", ctx))?.text).toBe("answer: one more thing");
    expect(await conversation.queued(ctx)).toEqual([]);
    await conversation.close(ctx);
  });
});

describe("4. a repeated requestId is recognised as a duplicate", () => {
  test("of a settled run", async () => {
    const { conversation } = await openFresh();
    await started(await conversation.submit("req-1", "hello", ctx)).settled;

    expect(await conversation.submit("req-1", "hello", ctx)).toEqual({
      kind: "duplicate",
      requestId: "req-1",
      where: "transcript",
    });
    await conversation.close(ctx);
  });

  test("of a running run", async () => {
    const gate = gateTool("gate");
    const { conversation } = await openFresh([gate.tool]);
    const run = started(await conversation.submit("req-1", "use-tool:gate", ctx));
    await gate.started;

    expect(await conversation.submit("req-1", "use-tool:gate", ctx)).toMatchObject({ kind: "duplicate" });
    gate.open("done");
    await run.settled;
    await conversation.close(ctx);
  });

  test("gap 3 closed: of a message still waiting in the inbox", async () => {
    const gate = gateTool("gate");
    const { conversation } = await openFresh([gate.tool]);
    const run = started(await conversation.submit("req-1", "use-tool:gate", ctx));
    await gate.started;

    const first = await conversation.submit("req-2", "change course", ctx);
    const again = await conversation.submit("req-2", "change course", ctx);

    expect(first.kind).toBe("queued");
    expect(again).toEqual({ kind: "duplicate", requestId: "req-2", where: "queued" });
    expect(await conversation.queued(ctx)).toHaveLength(1);
    gate.open("done");
    await run.settled;
    await conversation.close(ctx);
  });

  test("gap 1 closed: two deliveries of one request at the same time start one run", async () => {
    const { conversation } = await openFresh();

    const [a, b] = await Promise.all([
      conversation.submit("req-1", "hello", ctx),
      conversation.submit("req-1", "hello", ctx),
    ]);

    expect([a.kind, b.kind]).toEqual(["started", "duplicate"]);
    await started(a).settled;
    await conversation.close(ctx);
  });
});

describe("5. agent.state is a session value and starts fresh after a reset", () => {
  test("survives a new harness over the same session; a new session starts from the initial state", async () => {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, ctx);
    const initialState = { phase: "testing", testsPassed: false };
    const first = await SpikeConversation.open({ session, ...scriptedModel(), initialState }, ctx);

    expect(await first.conversation.getState(ctx)).toEqual(initialState);
    await first.conversation.setState({ phase: "deploying", testsPassed: true }, ctx);
    await first.conversation.close(ctx);

    // Eviction is not a reset: a new harness over the same stored session reads the same state.
    // Closing the harness closed its Session object, so the next owner reopens it from the repo.
    const reopened = await SpikeConversation.open(
      { session: await repo.open(session.metadata, ctx), ...scriptedModel(), initialState },
      ctx,
    );
    expect(await reopened.conversation.getState(ctx)).toEqual({ phase: "deploying", testsPassed: true });
    await reopened.conversation.close(ctx);

    // A reset is a new session (SPEC §7.6); the old one is kept.
    const fresh = await SpikeConversation.open({ session: await repo.create({}, ctx), ...scriptedModel(), initialState }, ctx);
    expect(await fresh.conversation.getState(ctx)).toEqual(initialState);
    await fresh.conversation.close(ctx);
  });
});

describe("6. a killed run is continued by resume() in a new process", () => {
  async function killMidTool(replay: "safe" | "never") {
    const root = mkdtempSync(join(tmpdir(), "pikit-spike-"));
    const worker = spawn(process.execPath, [join(import.meta.dir, "worker.ts"), root, root, replay], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let sessionId: string | undefined;
    let submitted = false;
    let toolStarted = false;
    for await (const line of createInterface({ input: worker.stdout })) {
      const event = JSON.parse(line) as { event: string; sessionId?: string };
      if (event.event === "session") sessionId = event.sessionId;
      if (event.event === "submitted") submitted = true;
      if (event.event === "tool_started") toolStarted = true;
      if (toolStarted && submitted) break;
    }
    worker.kill("SIGKILL");
    await new Promise((resolve) => worker.once("exit", resolve));
    if (sessionId === undefined || !submitted) throw new Error("worker died before its run started");

    // This process is the new worker: it opens the same session and resumes.
    const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
    const metadata = (await repo.list(undefined, ctx)).find((candidate) => candidate.id === sessionId);
    if (metadata === undefined) throw new Error(`session ${sessionId} not found`);
    const session = await repo.open(metadata, ctx);
    const slow = tool("slow", async () => "finished after resume", replay);
    const opened = await SpikeConversation.open({ session, ...scriptedModel(), tools: [slow] }, ctx);
    const cleanup = async () => {
      await opened.conversation.close(ctx);
      await repo.close(ctx);
      rmSync(root, { recursive: true, force: true });
    };
    return { ...opened, cleanup };
  }

  test("replay: safe — the interrupted tool runs again and the run completes", async () => {
    const { conversation, openOperations, cleanup } = await killMidTool("safe");
    expect(openOperations.map((operation) => operation.operationId)).toEqual(["req-killed"]);
    // Nobody in this process submitted req-killed; its end still arrives as an event.
    const ends: { runId: string; status: string }[] = [];
    conversation.onRunEnd((end) => ends.push(end));

    const outcome = await conversation.resume(ctx);

    expect(outcome?.status).toBe("completed");
    expect(outcome?.operationId).toBe("req-killed");
    expect((await conversation.answerTo("req-killed", ctx))?.text).toBe("tool said: finished after resume");
    expect(ends).toEqual([{ runId: "req-killed", status: "completed" }]);
    expect(await conversation.getState(ctx)).toEqual({ phase: "working" });
    // The request id was committed with the message, so a redelivery after the crash is known.
    expect(await conversation.submit("req-killed", "use-tool:slow", ctx)).toMatchObject({ kind: "duplicate" });
    await cleanup();
  }, 20_000);

  test("replay: never — the tool is not re-run; Pi reports it interrupted and the run completes", async () => {
    const { conversation, openOperations, cleanup } = await killMidTool("never");
    expect(openOperations).toHaveLength(1);

    const outcome = await conversation.resume(ctx);

    expect(outcome?.status).toBe("completed");
    const answer = await conversation.answerTo("req-killed", ctx);
    expect(answer?.text).toStartWith("tool said: [Tool execution was interrupted.");
    expect(answer?.text).not.toContain("finished after resume");
    await cleanup();
  }, 20_000);
});

describe("inbound messages as Pi custom messages", () => {
  test("Pi's events show them as `custom` messages, the role Pi extensions already handle", async () => {
    const { conversation, harness } = await openFresh();
    const ended: AgentMessage[] = [];
    harness.events.on("message_end", (event) => void ended.push(event.message));

    await started(await conversation.submit("req-1", "hello", ctx)).settled;

    expect(ended.map((message) => message.role)).toEqual(["custom", "assistant"]);
    expect(ended[0]).toMatchObject({ customType: "pikit.inbound", details: { requestId: "req-1" } });
    await conversation.close(ctx);
  });

  test("compaction summarises them, and the conversation goes on after it", async () => {
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, ctx);
    const { conversation, harness } = await SpikeConversation.open({ session, ...scriptedModel() }, ctx);
    await harness.setCompactionSettings({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 }, ctx);
    for (const [id, text] of [["req-1", "first"], ["req-2", "second"], ["req-3", "third"]] as const) {
      await started(await conversation.submit(id, text, ctx)).settled;
    }

    const compacted = await (await harness.lane("main", ctx)).compact(undefined, ctx);

    if (!compacted.ok) throw compacted.error;
    expect(compacted.value.compaction.status).toBe("completed");
    const after = started(await conversation.submit("req-4", "fourth", ctx));
    expect((await after.settled).status).toBe("completed");
    expect((await conversation.answerTo("req-4", ctx))?.text).toBe("answer: fourth");
    // Compaction adds a summary entry and keeps the old entries on the branch, so a request
    // summarised away is still recognised.
    expect(await conversation.submit("req-1", "first", ctx)).toMatchObject({ kind: "duplicate" });
    await conversation.close(ctx);
  });
});

describe("context bridge (SPEC §6.2)", () => {
  test("a pikit context keeps its cancellation when Pi derives from it only through the bridge", () => {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT);

    // Pi derives telemetry contexts with Chord's withContextValue.
    const unbridged = withTelemetryContext(NOOP_TELEMETRY_CONTEXT, context);
    const bridged = withTelemetryContext(NOOP_TELEMETRY_CONTEXT, toPi(context));

    cancel();
    expect(unbridged.abortSignal).toBeUndefined();
    expect(bridged.abortSignal?.aborted).toBe(true);
  });

  test("context values reach tools; cancelling the context stops the wait, not the durable run", async () => {
    const gate = gateTool("gate");
    const { conversation } = await openFresh([gate.tool]);
    const TENANT = createContextKey<string>("tenant");
    const { context, cancel } = withCancel(withContextValue(TENANT, "acme", BACKGROUND_CONTEXT));
    const ended = new Promise<{ runId: string; status: string }>((resolve) => conversation.onRunEnd(resolve));
    const run = started(await conversation.submit("req-1", "use-tool:gate", context));
    const toolContext = await gate.started;
    expect(toolContext.value(TENANT)).toBe("acme");

    cancel();

    await expect(run.settled).rejects.toThrow("aborted");
    expect(toolContext.abortSignal?.aborted).toBe(false);
    gate.open("still running");
    // The waiter is gone; the run's end is still reported.
    expect(await ended).toEqual({ runId: "req-1", status: "completed" });
    await conversation.close(ctx);
  });

  test("abort() cancels the running tool and ends the run as aborted", async () => {
    const gate = gateTool("gate");
    const { conversation } = await openFresh([gate.tool]);
    const run = started(await conversation.submit("req-1", "use-tool:gate", ctx));
    const toolContext = await gate.started;

    await conversation.abort(ctx);

    // Cooperative: abort() returned only because the tool honoured its signal.
    expect(toolContext.abortSignal?.aborted).toBe(true);
    expect((await run.settled).status).toBe("aborted");
    await conversation.close(ctx);
  });
});
