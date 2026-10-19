/**
 * Acceptance: the team bases compose in one real App without knowing each other. Delegation
 * (tool-delegate), approvals (approvals-sql, extension-approvals, admin-approvals) and the scheduler
 * (scheduler-sql, scheduler-admit, tool-schedule) meet only through the kit's contracts: none of them
 * imports another, and this test is the only file that names them all.
 *
 * The App: runtime-pi on a SQLite file (the same file across restarts), conversations-kv over
 * storage-kv-sql, router-basic, mailbox-local (approvals-sql's actor), wakeups-timers on a manual clock
 * (scheduler-sql's ticks), the scripted faux model (`call: <tool> <json>` calls a tool, `hold` calls
 * `hold`, anything else is answered `answer: <message>`), and a test channel that admits people's
 * messages with `admitInbound` (so `inbound.normalize` runs, as on every channel). Two agents:
 * `coordinator` (the chat's) delegates to `worker`; both may call `pay`, a tool with an effect on a
 * ledger, gated by extension-approvals. `boss` approves in the chat, an operator in the dashboard;
 * `mallory` may not.
 *
 * What composes: a background delegation, a gated call, an approval asked and decided in the
 * coordinator's own conversation, a scheduled prompt, a restart in the middle, the payment made once.
 * What does not, yet (the second test, `features/approvals.md`): an approval asked by a delegated
 * agent reaches no approver, and is spent nowhere it could be told.
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
const PAYMENT = { amount: 10, to: "acme" };
const OPERATOR = { authorization: "Bearer operator" };

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
type Live = {
  ctx: AppContext;
  admit(id: string, actor: string, text: string): Promise<string>;
  answers(): Promise<RunSettlement[]>;
  approvals: ApprovalStore;
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
        pikit.provideKeyed("model.provider", "faux", scriptedProvider());
        pikit.provideKeyed("agent.tool", "pay", payTool(ledger) as unknown as AgentTool);
        pikit.provideKeyed("agent.tool", "hold", held.tool as unknown as AgentTool);
        const coordinator = defineAgent({ name: "coordinator", model: "faux/scripted", tools: ["delegate", "delegate_tasks", "delegate_steer", SCHEDULE_TOOL, "pay"], extensions: ["approvals"] });
        const worker = defineAgent({ name: "worker", model: "faux/scripted", tools: ["hold", "pay"], extensions: ["approvals"] });
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
        const routes = pikit.useKeyed("http.route");
        pikit.on("agent.settled", (result) => void results.push(result));
        pikit.on("agent.failed", (result) => void results.push(result));
        return {
          start(ctx) {
            reached = {
              ctx,
              admit: async (id, actor, text) =>
                (await admitInbound(ctx, { id, channel: "test", conversationId: CHAT, actor: { id: actor }, text }, { conversations: conversations.get(), runtime: runtime.get(), key: `test:${CHAT}` })).kind,
              answers: async () => (await submissions.get().answers.read(undefined, 500)).items.map((item) => item.fact),
              approvals: approvals.get(),
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
  /** `actor`'s message in the chat; resolves with its run's result. */
  const say = async (actor: string, id: string, text: string): Promise<Result> => {
    expect(await live().admit(id, actor, text)).toBe("admitted");
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
  return { clock, ledger, held, results, boot, stop, live, until, say, answered, advance, approvals, decide };
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

  // 1. The coordinator hands work to the worker without waiting; the task is listed running.
  const delegated = await w.say("alice", "m1", call("delegate", { agent: "worker", task: "hold", wait: false }));
  const task = /^The task "(\d+)" is with the agent "worker" now\./.exec(toolResults(delegated)[0] ?? "")?.[1];
  expect(task).toBeDefined();
  await w.held.started;
  expect(toolResults(await w.say("alice", "m2", call("delegate_tasks", {})))).toEqual([`- ${task}: the agent "worker", running`]);
  // Once its hold ends, the worker tries the payment.
  expect(toolResults(await w.say("alice", "m3", call("delegate_steer", { id: task, message: call("pay", PAYMENT) })))[0]).toStartWith(`The message is with the task "${task}".`);

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

  // The restart cut the worker's hold; it goes on with the steered payment, now that one is approved,
  // and is refused: an approval is claimed only from the conversation that asked for it, not a child.
  const report = await w.until(() => w.results.find((r) => r.requestId.startsWith("delegate-result:")), "the worker's report");
  expect(report.conversation.agent).toBe("coordinator");
  expect(report.text).toContain(`answer: ${call("pay", PAYMENT)}`);
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

test("today, an approval a delegated worker asks for reaches no approver, and is useless where the work is", async () => {
  const w = world();
  await w.boot();
  await w.say("alice", "m1", "hello");
  const chat = (await w.answered("m1")).conversation;

  // The worker asks in its child conversation; its run ends with the question part.
  const asked = call("request_approval", { tool: "pay", args: PAYMENT, title: "Pay acme 10", reason: "The invoice is due." });
  await w.say("alice", "m2", call("delegate", { agent: "worker", task: asked, wait: false }));
  const report = await w.until(() => w.results.find((r) => r.requestId.startsWith("delegate-result:")), "the worker's report");

  // The report carries the child's answer text only: the question is lost on the way, so the chat never sees it.
  expect(report.text).toContain('[The agent "worker" finished the task you delegated to it.');
  expect(report.text).toContain("(nothing)");
  const questions = (await w.live().answers()).flatMap((a) => (a.parts ?? []).filter((part) => part.type === "question"));
  expect(questions).toEqual([]);

  // The approval belongs to the child conversation, which no channel delivers for.
  const [approval] = await w.approvals();
  expect(approval).toMatchObject({ status: "pending", requestedBy: { conversation: { agent: "worker", channel: "delegate" }, sender: { channel: "delegate", id: "coordinator" } } });
  expect(approval?.requestedBy.conversation.conversationId).not.toBe(chat.conversationId);

  // An operator can still find it in the dashboard and approve it; the decision is told to the child,
  // whose answer is logged under the child's key, never the chat's.
  expect(await w.decide(approval?.id as string, "approve")).toBe(200);
  const told = await w.answered(`approval-decided:${approval?.id}`);
  expect(told.conversation).toMatchObject({ agent: "worker", conversationId: approval?.requestedBy.conversation.conversationId });
  expect(told.conversation.key).not.toBe(`test:${CHAT}`);

  // Approved, but unusable: the coordinator's call and a new delegation (a new child) are both refused.
  expect(toolResults(await w.say("alice", "m3", call("pay", PAYMENT)))[0]).toContain(BLOCKED);
  const again = await w.say("alice", "m4", call("delegate", { agent: "worker", task: call("pay", PAYMENT) }));
  expect(toolResults(again)[0]).toStartWith('The agent "worker" answered:');
  expect(w.ledger).toEqual([]);
  expect(await w.approvals()).toMatchObject([{ id: approval?.id, status: "approved" }]);
});
