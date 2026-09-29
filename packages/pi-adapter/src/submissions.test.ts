/**
 * The runtime with `agent.submissions` (@pikit/contracts' submissions.ts): what it records, when,
 * and how `recover` brings back the work a dead process left: a run left open, and a run whose end
 * Pi stored but nobody recorded. Without the option, nothing here happens (the rest of the
 * adapter's tests run without it).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context as PiContext, JsonlSessionRepo, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { type AppContext, type AppEvents, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { AgentSubmissions } from "@pikit/contracts";
import { createMemorySubmissions } from "@pikit/contracts/testing";
import { createPiRuntime, modelsFrom, type SessionStore } from "./index.ts";
import { holdTool, killMidRun, scriptedAgent, scriptedProvider } from "./testing/index.ts";

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

/** A runtime over `sessions` recording in `submissions`, and the results its app reports. */
async function setup(options: { sessions?: SessionStore; submissions?: AgentSubmissions; hold?: (context: PiContext, started: () => void) => Promise<string> } = {}) {
  const sessions: SessionStore = options.sessions ?? new MemorySessionRepo();
  const results: Result[] = [];
  const waiters: (() => void)[] = [];
  /** At each result, where `agent.submissions` says its request is. */
  const seenAtEvent: (string | undefined)[] = [];
  let appContext: AppContext | undefined;
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const record = async (result: Result) => {
        if (options.submissions !== undefined) {
          seenAtEvent.push((await options.submissions.get(result.conversation, result.requestId, appContext as AppContext))?.kind);
        }
        results.push(result);
        for (const wake of waiters.splice(0)) wake();
      };
      pikit.on("agent.settled", record);
      pikit.on("agent.failed", record);
    },
  });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  appContext = app.context();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const hold = options.hold;
  const agent = scriptedAgent(
    holdTool(
      hold !== undefined
        ? (context) => hold(context, started)
        : async () => {
            started();
            await released;
            return "released";
          },
    ),
  );
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => (name === agent.name ? agent : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
    ...(options.submissions !== undefined && { submissions: options.submissions }),
  });
  const conversation = async () => {
    const session = await sessions.create({ cwd: "/" }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    return { key: `test:${session.metadata.id}`, agent: agent.name, sessionId: session.metadata.id };
  };
  const result = async (requestId: string): Promise<Result> => {
    for (;;) {
      const found = results.find((r) => r.requestId === requestId);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { app, ctx: app.context(), runtime, sessions, conversation, result, results, seenAtEvent, hold: { started: holding, release: () => release() } };
}

test("a message is recorded before dispatch resolves, and its run's end before agent.settled", async () => {
  const { submissions } = createMemorySubmissions();
  const calls: string[] = [];
  const watched: AgentSubmissions = {
    ...submissions,
    admitted: (conversation, requestId, ctx) => (calls.push(`admitted ${requestId}`), submissions.admitted(conversation, requestId, ctx)),
    settled: (run, ctx) => (calls.push(`settled ${run.requestIds.join(",")}`), submissions.settled(run, ctx)),
  };
  const s = await setup({ submissions: watched });
  const conversation = await s.conversation();

  await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, s.ctx);
  calls.push("dispatch resolved");
  await s.result("r1");

  expect(calls.indexOf("admitted r1")).toBeLessThan(calls.indexOf("dispatch resolved"));
  expect(calls).toContain("settled r1");
  expect(s.seenAtEvent).toEqual(["settled"]);
  const { items } = await submissions.answers.read(undefined, 10);
  expect(items.map((i) => i.fact)).toEqual([{ conversation, requestId: "r1", requestIds: ["r1"], kind: "completed", text: "answer: hello" }]);
  await s.runtime.close(s.ctx);
});

test("a queued message is settled by the run that took it; one abort() withdrew is settled aborted", async () => {
  const { submissions } = createMemorySubmissions();
  const s = await setup({ submissions });
  const conversation = await s.conversation();

  await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, s.ctx);
  await s.hold.started;
  await s.runtime.dispatch({ requestId: "r2", conversation, prompt: "change course" }, s.ctx);
  s.hold.release();
  await s.result("r1");
  const r2 = await submissions.get(conversation, "r2", s.ctx);
  expect(r2?.kind === "settled" && [r2.run.requestId, r2.run.text]).toEqual(["r1", "answer: change course"]);

  // A second run, aborted with a message queued in it.
  const other = await setup({
    submissions,
    hold: (context, started) =>
      new Promise<string>((_, reject) => {
        started();
        context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const busy = await other.conversation();
  await other.runtime.dispatch({ requestId: "a1", conversation: busy, prompt: "hold" }, other.ctx);
  await other.hold.started;
  await other.runtime.dispatch({ requestId: "a2", conversation: busy, prompt: "never mind" }, other.ctx);
  await other.runtime.abort(busy, other.ctx);
  await other.result("a1");
  const a2 = await submissions.get(busy, "a2", other.ctx);
  expect(a2?.kind === "settled" && [a2.run.kind, a2.run.requestIds]).toEqual(["aborted", ["a2"]]);
  expect(await submissions.pending(other.ctx)).toEqual([]);
  await s.runtime.close(s.ctx);
  await other.runtime.close(other.ctx);
});

test("recover resumes a run a dead worker left open, records its end, and resolves once it ended", async () => {
  const root = mkdtempSync(join(tmpdir(), "pikit-recover-"));
  try {
    const sessions = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
    const { submissions } = createMemorySubmissions();
    const s = await setup({ sessions, submissions, hold: async () => "not replayed" });
    const conversation = await s.conversation();
    await killMidRun(root, conversation.sessionId, "r-killed", "never");
    // What the dead worker recorded before its dispatch resolved.
    await submissions.admitted(conversation, "r-killed", s.ctx);

    await s.runtime.recover(conversation, ["r-killed"], s.ctx);

    expect((await submissions.get(conversation, "r-killed", s.ctx))?.kind).toBe("settled");
    expect((await s.result("r-killed")).kind).toBe("completed");
    expect(await submissions.pending(s.ctx)).toEqual([]);
    await s.runtime.close(s.ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("recover settles, from the result Pi stored, a run whose end was never recorded, and announces it", async () => {
  const sessions = new MemorySessionRepo();
  const { submissions } = createMemorySubmissions();
  // The first process: its run ended in Pi, and it died before recording it.
  const first = await setup({ sessions });
  const conversation = await first.conversation();
  await submissions.admitted(conversation, "r1", first.ctx);
  await first.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, first.ctx);
  await first.result("r1");
  await first.runtime.close(first.ctx);
  expect((await submissions.get(conversation, "r1", first.ctx))?.kind).toBe("pending");

  const next = await setup({ sessions, submissions });
  await next.runtime.recover(conversation, ["r1"], next.ctx);

  const status = await submissions.get(conversation, "r1", next.ctx);
  expect(status?.kind === "settled" && status.run.text).toBe("answer: hello");
  expect((await next.result("r1")).text).toBe("answer: hello");
  // Recovering again finds nothing to do: it is no longer pending, and a second record changes nothing.
  await next.runtime.recover(conversation, ["r1"], next.ctx);
  expect((await submissions.answers.read(undefined, 10)).items).toHaveLength(1);
  await next.runtime.close(next.ctx);
});

test("a failed admission record fails the dispatch, and the run still ends recorded; a failed end record is tried again", async () => {
  const { submissions } = createMemorySubmissions();
  let failAdmitted = 1;
  let failSettled = 1;
  const flaky: AgentSubmissions = {
    ...submissions,
    async admitted(conversation, requestId, ctx) {
      if (failAdmitted-- > 0) throw new Error("storage failed");
      return submissions.admitted(conversation, requestId, ctx);
    },
    async settled(run, ctx) {
      if (failSettled-- > 0) throw new Error("storage failed");
      return submissions.settled(run, ctx);
    },
  };
  const s = await setup({ submissions: flaky });
  const conversation = await s.conversation();

  await expect(s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, s.ctx)).rejects.toThrow("storage failed");
  // The platform is not acknowledged and delivers it again: a duplicate, and nothing more to record.
  expect((await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, s.ctx)).kind).toBe("duplicate");
  expect((await s.result("r1")).text).toBe("answer: hello");

  const deadline = Date.now() + 5_000;
  while ((await submissions.get(conversation, "r1", s.ctx))?.kind !== "settled") {
    if (Date.now() > deadline) throw new Error("the run's end was never recorded");
    await Bun.sleep(50);
  }
  await s.runtime.close(s.ctx);
}, 10_000);

/** A hold that never returns until the run is aborted. */
const abortableHold = (context: PiContext, started: () => void) =>
  new Promise<string>((_, reject) => {
    started();
    context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

test("a redelivery of a request Pi ran but agent.submissions never heard of settles it from the session", async () => {
  const sessions = new MemorySessionRepo();
  const { submissions } = createMemorySubmissions();
  // Two crashes: the process that took r1 died before `admitted`, the one that ran it before `settled`.
  const first = await setup({ sessions });
  const conversation = await first.conversation();
  await first.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, first.ctx);
  await first.result("r1");
  await first.runtime.close(first.ctx);

  const next = await setup({ sessions, submissions });
  expect((await next.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, next.ctx)).kind).toBe("duplicate");

  const status = await submissions.get(conversation, "r1", next.ctx);
  expect(status?.kind === "settled" && status.run.text).toBe("answer: hello");
  expect((await next.result("r1")).text).toBe("answer: hello");
  // Delivered again: recorded already, so nothing is recorded or announced twice.
  await next.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, next.ctx);
  expect((await submissions.answers.read(undefined, 10)).items).toHaveLength(1);
  expect(next.results).toHaveLength(1);
  await next.runtime.close(next.ctx);
});

test("recover settles a request steered into a run named after another, not pending, request", async () => {
  const sessions = new MemorySessionRepo();
  const { submissions } = createMemorySubmissions();
  // r1 was never recorded (its admission failed); r2 joined its run; the run ended and nobody recorded it.
  const first = await setup({ sessions });
  const conversation = await first.conversation();
  await first.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, first.ctx);
  await first.hold.started;
  await first.runtime.dispatch({ requestId: "r2", conversation, prompt: "change course" }, first.ctx);
  first.hold.release();
  expect((await first.result("r1")).requestIds).toEqual(["r1", "r2"]);
  await first.runtime.close(first.ctx);
  await submissions.admitted(conversation, "r2", first.ctx);

  const next = await setup({ sessions, submissions });
  await next.runtime.recover(conversation, ["r2"], next.ctx);

  const status = await submissions.get(conversation, "r2", next.ctx);
  expect(status?.kind === "settled" && [status.run.requestId, status.run.text]).toEqual(["r1", "answer: change course"]);
  expect(await submissions.pending(next.ctx)).toEqual([]);
  expect((await next.result("r1")).requestIds).toEqual(["r1", "r2"]);
  await next.runtime.close(next.ctx);
});

test("recover settles as aborted a request an abort withdrew, when the process died before recording it", async () => {
  const sessions = new MemorySessionRepo();
  const { submissions } = createMemorySubmissions();
  // The abort's withdrawn record is in the session; the process died before `settled`.
  const first = await setup({ sessions, hold: abortableHold });
  const conversation = await first.conversation();
  await first.runtime.dispatch({ requestId: "a1", conversation, prompt: "hold" }, first.ctx);
  await first.hold.started;
  await first.runtime.dispatch({ requestId: "a2", conversation, prompt: "never mind" }, first.ctx);
  await first.runtime.abort(conversation, first.ctx);
  await first.result("a1");
  await first.runtime.close(first.ctx);
  await submissions.admitted(conversation, "a2", first.ctx);

  const next = await setup({ sessions, submissions });
  await next.runtime.recover(conversation, ["a2"], next.ctx);

  const status = await submissions.get(conversation, "a2", next.ctx);
  expect(status?.kind === "settled" && [status.run.kind, status.run.requestIds]).toEqual(["aborted", ["a2"]]);
  expect(await submissions.pending(next.ctx)).toEqual([]);
  await next.runtime.close(next.ctx);
});

test("recover with a stale pending list announces nothing already settled", async () => {
  const sessions = new MemorySessionRepo();
  const { submissions } = createMemorySubmissions();
  const first = await setup({ sessions });
  const conversation = await first.conversation();
  await submissions.admitted(conversation, "r1", first.ctx);
  await first.runtime.dispatch({ requestId: "r1", conversation, prompt: "hello" }, first.ctx);
  await first.result("r1");
  await first.runtime.close(first.ctx);

  const next = await setup({ sessions, submissions });
  const stale = await submissions.pending(next.ctx);
  // Settled meanwhile (here by a first recover; in production, by the run a new message resumed).
  await next.runtime.recover(conversation, ["r1"], next.ctx);
  for (const { conversation: c, requestIds } of stale) await next.runtime.recover(c, requestIds, next.ctx);

  expect(next.results.map((r) => r.requestId)).toEqual(["r1"]);
  await next.runtime.close(next.ctx);
});

test("recover does not wait for a run a new message started in the conversation", async () => {
  const { submissions } = createMemorySubmissions();
  const s = await setup({ submissions });
  const conversation = await s.conversation();
  await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, s.ctx);
  await s.hold.started;

  const recovered = s.runtime.recover(conversation, ["r0"], s.ctx).then(() => "recovered");
  const outcome = await Promise.race([recovered, Bun.sleep(1_000).then(() => "waited for r1")]);

  expect(outcome).toBe("recovered");
  s.hold.release();
  await s.result("r1");
  await s.runtime.close(s.ctx);
});

test("recover abandons, and announces, the requests of a conversation whose agent or session is gone", async () => {
  const { submissions } = createMemorySubmissions();
  const s = await setup({ submissions });
  const removed = { ...(await s.conversation()), agent: "removed" };
  const missing = { key: "test:missing", agent: "scripted", sessionId: "no-such-session" };
  await submissions.admitted(removed, "r1", s.ctx);
  await submissions.admitted(missing, "r2", s.ctx);

  await s.runtime.recover(removed, ["r1"], s.ctx);
  await s.runtime.recover(missing, ["r2"], s.ctx);

  expect([(await s.result("r1")).error, (await s.result("r2")).error]).toEqual([
    { code: "abandoned", message: "agent_removed" },
    { code: "abandoned", message: "session_missing" },
  ]);
  expect(await submissions.pending(s.ctx)).toEqual([]);
  // At the next start nothing is pending: recovering again announces nothing.
  await s.runtime.recover(removed, ["r1"], s.ctx);
  expect(s.results).toHaveLength(2);
  await s.runtime.close(s.ctx);
});

test("abandon leaves the requests a run of this worker may still take", async () => {
  const { submissions } = createMemorySubmissions();
  const s = await setup({ submissions });
  const conversation = await s.conversation();
  await s.runtime.dispatch({ requestId: "r1", conversation, prompt: "hold" }, s.ctx);
  await s.hold.started;

  await s.runtime.abandon(conversation, ["r1"], "unanswered_too_long", s.ctx);

  expect((await submissions.get(conversation, "r1", s.ctx))?.kind).toBe("pending");
  s.hold.release();
  expect((await s.result("r1")).kind).toBe("completed");
  await s.runtime.close(s.ctx);
});
