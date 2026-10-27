/**
 * Acceptance: the team bases compose in one real App without knowing each other. Delegation
 * (tool-delegate), approvals (approvals-sql, extension-approvals, admin-approvals), the scheduler
 * (scheduler-sql, scheduler-admit, tool-schedule) and memory (memory-sql, memory-recall) meet only
 * through the kit's contracts: none of them imports another, and this test is the only file that
 * names them all.
 *
 * The App: runtime-pi on a SQLite file (the same file across restarts), conversations-kv over
 * storage-kv-sql, router-basic, mailbox-local (approvals-sql's actor), wakeups-timers on a manual clock
 * (scheduler-sql's ticks), the scripted faux model (`call: <tool> <json>` calls a tool, `hold` calls
 * `hold`, anything else is answered `answer: <message>`), and a test channel that admits people's
 * messages with `admitInbound` (so `inbound.normalize` runs, as on every channel). Two agents:
 * `coordinator` (the chat's) delegates to `worker`; both may call `pay`, a tool with an effect on a
 * ledger, gated by extension-approvals, and both remember (memory-recall). `boss` approves in the chat,
 * an operator in the dashboard; `mallory` may not.
 *
 * What composes: a background delegation, a gated call, an approval asked and decided in the
 * coordinator's own conversation, a scheduled prompt, a restart in the middle, the payment made once.
 * And through the conversation a delegated task comes from (`ConversationRef.origin`), what a delegated
 * worker does belongs to the chat it works for: its approval's question reaches the chat with the
 * coordinator's answer (the report carries the worker's parts), is decided there, and is used by the
 * chat's tree only; what it remembers is in the chat's space; its scheduled prompt comes back to the chat.
 *
 * A repository test: it imports the components' files from `registry/`, as their own `app.test.ts`
 * files do; no component's files import another's (SPEC P4).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppContext, type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { type AdminAuth, admitInbound, type AgentTool, answerText, defineAgent, type HttpRoute, type QuestionPart, type RunSettlement } from "@pikit/contracts";
import type { MemoryStore } from "../../registry/components/memory-recall/files/src/pikit/memory-recall/contract.ts";
import memoryRecall from "../../registry/components/memory-recall/files/src/pikit/memory-recall/index.ts";
import memorySql from "../../registry/components/memory-sql/files/src/pikit/memory-sql/index.ts";
import { holdTool, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import { defineTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";
import adminApprovals from "../../registry/components/admin-approvals/files/src/pikit/admin-approvals/index.ts";
import approvalsSql from "../../registry/components/approvals-sql/files/src/pikit/approvals-sql/index.ts";
import conversationsKv from "../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import type { Approval, ApprovalStore } from "../../registry/components/extension-approvals/files/src/pikit/extension-approvals/contract.ts";
import extensionApprovals from "../../registry/components/extension-approvals/files/src/pikit/extension-approvals/index.ts";
import mailboxLocal from "../../registry/components/mailbox-local/files/src/pikit/mailbox-local/index.ts";
import routerBasic from "../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import runtimePi from "../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import schedulerAdmit, { SCHEDULER_CHANNEL } from "../../registry/components/scheduler-admit/files/src/pikit/scheduler-admit/index.ts";
import schedulerSql from "../../registry/components/scheduler-sql/files/src/pikit/scheduler-sql/index.ts";
import storageKvSql from "../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolDelegate from "../../registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts";
import { unframed } from "../../registry/components/tool-delegate/unframed.test-support.ts";
import toolSchedule, { SCHEDULE_TOOL } from "../../registry/components/tool-schedule/files/src/pikit/tool-schedule/index.ts";
import wakeupsTimers from "../../registry/components/wakeups-timers/files/src/pikit/wakeups-timers/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const HOUR = 3_600_000;
/** 2030-01-01T00:00:00Z. */
const START = Date.UTC(2030, 0, 1);
/** The chat everyone writes in: conversation key `test:team`. */
const CHAT = "team";
/** Another chat, whose conversation is another tree of delegations: key `test:other`. */
const OTHER = "other";
const PAYMENT = { amount: 10, to: "acme" };
const OPERATOR = { authorization: "Bearer operator" };

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
type Live = {
  ctx: AppContext;
  admit(id: string, actor: string, text: string, chat: string): Promise<string>;
  answers(): Promise<RunSettlement[]>;
  approvals: ApprovalStore;
  memory: MemoryStore;
  routes: { get(key: string): HttpRoute | undefined };
};

/** `pay`: a payment, recorded in `ledger` each time it runs. */
function payTool(ledger: unknown[]) {
  return defineTool({
    name: "pay",
    description: "Pays an amount to someone.",
    parameters: Type.Object({ amount: Type.Number(), to: Type.String() }),
    replay: "unsafe",
    execute: async (args) => {
      ledger.push(args);
      return { output: [{ type: "text", text: `paid ${args.amount} to ${args.to}` }] };
    },
  });
}

/** The worker's `hold`: blocks until its App stops. */
function hold() {
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  const tool = holdTool(async (context) => {
    started();
    await new Promise<void>((_, reject) => {
      const signal = context.abortSignal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return "released";
  });
  return { tool, started: holding };
}

/** A world over one directory and one manual clock: Apps that restart over the same SQLite file. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-team-bases-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = createManualClock(START);
  const ledger: unknown[] = [];
  const held = hold();
  /** Every run's result, across Apps, with the messages it added. */
  const results: Result[] = [];
  /** The system messages (instructions, sections) of every model request, across Apps, in order, as JSON. */
  const systems: string[] = [];
  let app: App | undefined;
  let reached: Live | undefined;

  const stop = async () => {
    const running = app;
    app = undefined;
    reached = undefined;
    await running?.stop();
  };
  cleanup.push(stop);

  const boot = async () => {
    await stop();
    const fixtures = defineComponent({
      name: "fixtures-test",
      setup(pikit) {
        const auth: AdminAuth = { verify: async (request) => (request.headers.get("authorization") === OPERATOR.authorization ? { id: "operator" } : undefined) };
        pikit.provide("admin.auth", auth);
        // The worker reads its task without delegate's framing: the scripted rules match a message whole.
        pikit.provideKeyed("model.provider", "faux", unframed(scriptedProvider({ onRequest: (request) => void systems.push(JSON.stringify(request.messages.filter((message) => message.role === "system"))) })));
        pikit.provideKeyed("agent.tool", "pay", payTool(ledger) as unknown as AgentTool);
        pikit.provideKeyed("agent.tool", "hold", held.tool as unknown as AgentTool);
        const coordinator = defineAgent({ name: "coordinator", model: "faux/scripted", tools: ["delegate", "delegate_tasks", "delegate_steer", SCHEDULE_TOOL, "pay"], extensions: ["memory", "approvals"] });
        const worker = defineAgent({ name: "worker", model: "faux/scripted", tools: ["hold", "pay", SCHEDULE_TOOL], extensions: ["memory", "approvals"] });
        pikit.provideKeyed("agent.definition", coordinator.name, coordinator);
        pikit.provideKeyed("agent.definition", worker.name, worker);
      },
    });
    const channel = defineComponent({
      name: "channel-test",
      setup(pikit) {
        const conversations = pikit.use("conversations.registry");
        const runtime = pikit.use("agent.runtime");
        const submissions = pikit.use("agent.submissions");
        const approvals = pikit.use("approvals");
        const memory = pikit.use("memory");
        const routes = pikit.useKeyed("http.route");
        pikit.on("agent.settled", (result) => void results.push(result));
        pikit.on("agent.failed", (result) => void results.push(result));
        return {
          start(ctx) {
            reached = {
              ctx,
              admit: async (id, actor, text, chat) =>
                (await admitInbound(ctx, { id, channel: "test", conversationId: chat, actor: { id: actor }, text }, { conversations: conversations.get(), runtime: runtime.get(), key: `test:${chat}` })).kind,
              answers: async () => (await submissions.get().answers.read(undefined, 500)).items.map((item) => item.fact),
              approvals: approvals.get(),
              memory: memory.get(),
              routes,
            };
          },
        };
      },
    });
    const components = [
      sqliteStorage(join(dir, "pikit.db")),
      storageKvSql,
      mailboxLocal,
      wakeupsTimers,
      fixtures,
      runtimePi,
      conversationsKv,
      routerBasic,
      toolDelegate,
      approvalsSql,
      extensionApprovals,
      memorySql,
      memoryRecall,
      adminApprovals,
      schedulerSql,
      schedulerAdmit,
      toolSchedule,
      channel,
    ];
    const config = {
      "router-basic": { defaultAgent: "coordinator" },
      "tool-delegate": { agents: [{ name: "worker", description: "Does the work it is given." }] },
      "extension-approvals": { tools: ["pay"], approvers: ["test:boss", "dashboard:*"] },
    };
    app = await defineApp({ components, config, clock, logger: silentLogger }).create();
    await app.start();
  };

  const live = (): Live => reached ?? (() => { throw new Error("no App is running"); })();
  const until = async <T>(find: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = await find();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; runs: ${JSON.stringify(results.map((r) => [r.conversation.agent, r.requestId, r.kind]))}`);
      await Bun.sleep(5);
    }
  };
  /** `actor`'s message in `chat` (default the team's); resolves with its run's result. */
  const say = async (actor: string, id: string, text: string, chat = CHAT): Promise<Result> => {
    expect(await live().admit(id, actor, text, chat)).toBe("admitted");
    return until(() => results.find((r) => r.requestId === id), `the run of ${id}`);
  };
  /** The answer delivered to the chat for `requestId`, from the answers feed. */
  const answered = (requestId: string) => until(async () => (await live().answers()).find((a) => a.requestIds.includes(requestId)), `the answer to ${requestId}`);
  /** Moves the clock on, and lets the wakeups it ran admit their messages. */
  const advance = async (ms: number) => {
    await clock.advance(ms);
    for (let i = 0; i < 20; i++) await Bun.sleep(1);
  };
  const approvals = async (): Promise<Approval[]> => (await live().approvals.list({}, live().ctx)).items;
  /** An operator's decision through admin-approvals' route. */
  const decide = async (id: string, verdict: "approve" | "reject") => {
    const route = live().routes.get("POST /admin/api/approvals/:id/decision");
    const response = await route?.(new Request(`http://pikit.test/admin/api/approvals/${id}/decision`, { method: "POST", headers: OPERATOR, body: JSON.stringify({ verdict }) }), live().ctx);
    return response?.status;
  };
  return { clock, ledger, held, results, systems, boot, stop, live, until, say, answered, advance, approvals, decide };
}

/** The text of the tool results a run added. */
const toolResults = (result: Result): string[] =>
  (result.messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

const call = (tool: string, args: unknown) => `call: ${tool} ${JSON.stringify(args)}`;
const BLOCKED = `"pay" needs a person's approval of this exact call.`;

test("a coordinator delegates in the background, gets a payment approved in its own conversation, and a scheduled prompt pays once after a restart", async () => {
  const w = world();
  await w.boot();

  // 1. The coordinator hands work to the worker without waiting; the task is listed running, at its hold.
  const delegated = await w.say("alice", "m1", call("delegate", { agent: "worker", task: "hold", wait: false }));
  const task = /^The task "(\d+)" is with the agent "worker" now\./.exec(toolResults(delegated)[0] ?? "")?.[1];
  expect(task).toBeDefined();
  await w.held.started;
  expect(toolResults(await w.say("alice", "m2", call("delegate_tasks", {})))).toEqual([`- ${task}: the agent "worker", running; its latest step: called hold {}: running`]);
  // Once its hold ends, the worker wraps up.
  expect(toolResults(await w.say("alice", "m3", call("delegate_steer", { id: task, message: "wrap up" })))[0]).toStartWith(`The message is with the task "${task}".`);

  // 2. Without an approval, beforeTool blocks the gated call.
  expect(toolResults(await w.say("alice", "m4", call("pay", PAYMENT)))[0]).toContain(BLOCKED);
  expect(w.ledger).toEqual([]);

  // 3. The coordinator asks in its own conversation: the question reaches the chat as a part.
  await w.say("alice", "m5", call("request_approval", { tool: "pay", args: PAYMENT, title: "Pay acme 10", reason: "The invoice is due." }));
  const question = (await w.answered("m5")).parts?.find((part) => part.type === "question") as QuestionPart | undefined;
  expect(question?.id).toStartWith("approval:");
  const id = (question?.id ?? "").slice("approval:".length);
  const yes = answerText(question as QuestionPart, { approve: true });

  // 4a. A person who is no approver answers yes: nothing is recorded.
  expect((await w.say("mallory", "m6", yes)).text).toContain(`[approvals] Not recorded: test:mallory may not decide approval ${id}.`);
  expect(await w.approvals()).toMatchObject([{ id, status: "pending" }]);

  // 4b. The approver answers in the chat: recorded before the model reads it.
  expect((await w.say("boss", "m7", yes)).text).toContain(`[approvals] Recorded: approval ${id} is approved, decided by test:boss.`);

  // 7. The payment is scheduled for 01:00, in this conversation.
  await w.say("alice", "m8", call(SCHEDULE_TOOL, { prompt: call("pay", PAYMENT), at: new Date(START + HOUR).toISOString() }));
  expect(w.ledger).toEqual([]);

  // 5. A restart mid-flow: the worker still holding, the approval approved and unused, the job waiting.
  await w.stop();
  await w.boot();
  expect(await w.approvals()).toMatchObject([{ id, status: "approved" }]);

  // The restart cut the worker's hold; it goes on with the steer, and reports to the coordinator.
  const report = await w.until(() => w.results.find((r) => r.requestId.startsWith("delegate-result:")), "the worker's report");
  expect(report.conversation.agent).toBe("coordinator");
  expect(report.text).toContain("answer: wrap up");
  expect(w.ledger).toEqual([]);
  expect(await w.approvals()).toMatchObject([{ id, status: "approved" }]);

  // 6. At 01:00 the scheduled prompt comes back from the scheduler and the approved call runs, once.
  await w.advance(HOUR - 1);
  expect(w.ledger).toEqual([]);
  await w.advance(1);
  const ticks = async () => (await w.live().answers()).filter((a) => a.requestIds.some((r) => r.startsWith(`${SCHEDULER_CHANNEL}:`)));
  const [tick] = await w.until(async () => ((await ticks()).length > 0 ? ticks() : undefined), "the scheduled prompt");
  expect(tick?.conversation).toMatchObject({ key: `test:${CHAT}`, agent: "coordinator" });
  expect(tick?.text).toBe("answer: call: pay {\"amount\":10,\"to\":\"acme\"}");
  expect(w.ledger).toEqual([PAYMENT]);
  expect(await w.approvals()).toMatchObject([{ id, status: "executed", decidedBy: { channel: "test", id: "boss" } }]);

  // The same call again is refused, and no second tick comes.
  expect(toolResults(await w.say("alice", "m9", call("pay", PAYMENT)))[0]).toContain(BLOCKED);
  await w.advance(3 * HOUR);
  expect(await ticks()).toHaveLength(1);
  expect(w.ledger).toEqual([PAYMENT]);
});

test("a delegated worker's approval reaches the chat with the coordinator's answer, is decided there, and pays once after a restart; no other tree can use it", async () => {
  const w = world();
  await w.boot();
  await w.say("alice", "m1", "hello");
  const chat = (await w.answered("m1")).conversation;

  // The worker asks in its child conversation; its report brings the question to the coordinator's answer.
  const asked = call("request_approval", { tool: "pay", args: PAYMENT, title: "Pay acme 10", reason: "The invoice is due." });
  await w.say("alice", "m2", call("delegate", { agent: "worker", task: asked, wait: false }));
  const report = await w.until(() => w.results.find((r) => r.requestId.startsWith("delegate-result:")), "the worker's report");
  expect(report.conversation).toMatchObject({ key: `test:${CHAT}`, agent: "coordinator" });
  expect(report.text).toContain("[The person is shown what follows with your answer, as it is: do not repeat it.]");
  // In the answers the chat's channel delivers, once.
  const delivered = (await w.live().answers()).filter((a) => a.conversation.key === `test:${CHAT}` && (a.parts ?? []).some((part) => part.type === "question"));
  expect(delivered.map((a) => a.requestId)).toEqual([report.requestId]);
  const question = delivered[0]?.parts?.find((part) => part.type === "question") as QuestionPart | undefined;
  expect(question?.id).toStartWith("approval:");
  const id = (question?.id ?? "").slice("approval:".length);
  const yes = answerText(question as QuestionPart, { approve: true });

  // It is the chat's: asked for the conversation the worker's task comes from.
  expect(await w.approvals()).toMatchObject([
    { id, status: "pending", requestedBy: { conversation: { key: `test:${CHAT}`, agent: "coordinator", conversationId: chat.conversationId, channel: "test" }, sender: { channel: "delegate", id: "coordinator" } } },
  ]);

  // Decided in the chat: a person who is no approver records nothing, the approver does.
  expect((await w.say("mallory", "m3", yes)).text).toContain(`[approvals] Not recorded: test:mallory may not decide approval ${id}.`);
  expect((await w.say("boss", "m4", yes)).text).toContain(`[approvals] Recorded: approval ${id} is approved, decided by test:boss.`);

  // Another chat is another tree: its worker cannot use the team's approval.
  await w.say("eve", "o1", call("delegate", { agent: "worker", task: call("pay", PAYMENT) }), OTHER);
  expect(w.ledger).toEqual([]);
  expect(await w.approvals()).toMatchObject([{ id, status: "approved" }]);

  // There, a worker that waits for its task asks too: the question comes with the delegate call's result,
  // and an operator's decision is told to that chat, never to the worker's task.
  const other = { amount: 20, to: "acme" };
  const waited = await w.say("eve", "o2", call("delegate", { agent: "worker", task: call("request_approval", { tool: "pay", args: other, title: "Pay acme 20", reason: "Another invoice." }) }), OTHER);
  const second = waited.parts?.find((part) => part.type === "question") as QuestionPart | undefined;
  expect(second?.id).toStartWith("approval:");
  const secondId = (second?.id ?? "").slice("approval:".length);
  expect(await w.decide(secondId, "approve")).toBe(200);
  expect((await w.answered(`approval-decided:${secondId}`)).conversation).toMatchObject({ key: `test:${OTHER}`, agent: "coordinator" });

  // A restart, then the coordinator hands the work over again: a new child of the same tree pays, once.
  await w.stop();
  await w.boot();
  expect(toolResults(await w.say("alice", "m5", call("delegate", { agent: "worker", task: call("pay", PAYMENT) })))[0]).toStartWith('The agent "worker" answered:');
  expect(w.ledger).toEqual([PAYMENT]);
  expect((await w.approvals()).find((a) => a.id === id)).toMatchObject({ status: "executed", decidedBy: { channel: "test", id: "boss" } });

  // Once is once: the same payment again is refused, in the chat's tree as in the chat.
  await w.say("alice", "m6", call("delegate", { agent: "worker", task: call("pay", PAYMENT) }));
  expect(toolResults(await w.say("alice", "m7", call("pay", PAYMENT)))[0]).toContain(BLOCKED);
  expect(w.ledger).toEqual([PAYMENT]);
});

test("what a delegated worker remembers is in the chat's space, and a prompt it schedules comes back to the chat, once", async () => {
  const w = world();
  await w.boot();
  await w.say("alice", "m1", "hello");
  const fact = "Alice pays acme every month";

  // The worker keeps a fact while on a task from the chat: a delegated conversation is in its origin's
  // space (the chat, its own space), whose memory every agent working there shares.
  await w.say("alice", "m2", call("delegate", { agent: "worker", task: call("remember", { fact }) }));
  const space = { type: "space", space: `test:${CHAT}` } as const;
  expect(await w.live().memory.list(space, { kinds: ["fact"] }, 10, w.live().ctx)).toMatchObject([{ text: fact }]);

  // A later task from the chat, in a new child conversation, recalls it; a task from another chat does not.
  const before = w.systems.length;
  await w.say("alice", "m3", call("delegate", { agent: "worker", task: "what do you know?" }));
  expect(w.systems.slice(before).some((system) => system.includes(fact))).toBe(true);
  const elsewhere = w.systems.length;
  await w.say("eve", "o1", call("delegate", { agent: "worker", task: "what do you know?" }), OTHER);
  expect(w.systems.slice(elsewhere).some((system) => system.includes(fact))).toBe(false);

  // The worker schedules a prompt: it comes back to the chat at 01:00, answered there by the coordinator, once.
  await w.say("alice", "m4", call("delegate", { agent: "worker", task: call(SCHEDULE_TOOL, { prompt: "remind alice about acme", at: new Date(START + HOUR).toISOString() }) }));
  const ticks = async () => (await w.live().answers()).filter((a) => a.requestIds.some((r) => r.startsWith(`${SCHEDULER_CHANNEL}:`)));
  await w.advance(HOUR - 1);
  expect(await ticks()).toEqual([]);
  await w.advance(1);
  const [tick] = await w.until(async () => ((await ticks()).length > 0 ? ticks() : undefined), "the scheduled prompt");
  expect(tick?.conversation).toMatchObject({ key: `test:${CHAT}`, agent: "coordinator" });
  expect(tick?.text).toBe("answer: remind alice about acme");
  await w.advance(3 * HOUR);
  expect(await ticks()).toHaveLength(1);
});
