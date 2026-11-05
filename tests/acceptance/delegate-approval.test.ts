/**
 * Acceptance: a delegation that needs a person's approval (pi-hive's `request_task`), with no new
 * component. extension-approvals gates tool-delegate's own `delegate` tool: the trader may hand work
 * to the developer only once an approver has approved that exact call, and only once.
 *
 * The App: runtime-pi on a SQLite file (the same file across a restart), conversations-kv over
 * storage-kv-sql, router-basic (the trader answers the chat), tool-delegate, approvals-sql (on
 * mailbox-local), extension-approvals with `tools: ["delegate"]`, admin-approvals (an operator decides
 * in the dashboard), the scripted faux model (`call: <tool> <json>` calls a tool), and a test channel
 * that admits people's messages with `admitInbound`. The developer has `work`, a tool that records each
 * task it runs, so a delegation that ran is visible.
 *
 * A repository test: it imports the components' files from `registry/`, as team-bases.test.ts does.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppContext, type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createManualClock } from "@pikit/core/testing";
import { type AdminAuth, admitInbound, type AgentTool, answerText, defineAgent, type HttpRoute, type QuestionPart, type RunSettlement } from "@pikit/contracts";
import { scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
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
import storageKvSql from "../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolDelegate from "../../registry/components/tool-delegate/files/src/pikit/tool-delegate/index.ts";
import { unframed } from "../../registry/components/tool-delegate/unframed.test-support.ts";
import wakeupsTimers from "../../registry/components/wakeups-timers/files/src/pikit/wakeups-timers/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const CHAT = "team";
const OPERATOR = { authorization: "Bearer operator" };

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];
type Live = {
  ctx: AppContext;
  admit(id: string, actor: string, text: string): Promise<string>;
  answers(): Promise<RunSettlement[]>;
  approvals: ApprovalStore;
  routes: { get(key: string): HttpRoute | undefined };
};

/** `work`: the developer's work, recorded in `done` each time it runs. */
function workTool(done: string[]) {
  return defineTool({
    name: "work",
    description: "Does a piece of work.",
    parameters: Type.Object({ what: Type.String() }),
    replay: "unsafe",
    execute: async (args) => {
      done.push(args.what);
      return { output: [{ type: "text", text: `done: ${args.what}` }] };
    },
  });
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-delegate-approval-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = createManualClock(Date.UTC(2030, 0, 1));
  const done: string[] = [];
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
        pikit.provideKeyed("model.provider", "faux", unframed(scriptedProvider()));
        pikit.provideKeyed("agent.tool", "work", workTool(done) as unknown as AgentTool);
        const trader = defineAgent({ name: "trader", model: "faux/scripted", tools: ["delegate"], extensions: ["approvals"] });
        const developer = defineAgent({ name: "developer", model: "faux/scripted", tools: ["work"] });
        pikit.provideKeyed("agent.definition", trader.name, trader);
        pikit.provideKeyed("agent.definition", developer.name, developer);
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
      channel,
    ];
    const config = {
      "router-basic": { defaultAgent: "trader" },
      "tool-delegate": { agents: [{ name: "developer", description: "Changes skills and scripts.", from: ["trader"] }] },
      "extension-approvals": { tools: ["delegate"], approvers: ["test:boss", "dashboard:*"] },
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
  const say = async (actor: string, id: string, text: string): Promise<Result> => {
    expect(await live().admit(id, actor, text)).toBe("admitted");
    return until(() => results.find((r) => r.requestId === id), `the run of ${id}`);
  };
  const answered = (requestId: string) => until(async () => (await live().answers()).find((a) => a.requestIds.includes(requestId)), `the answer to ${requestId}`);
  const approvals = async (): Promise<Approval[]> => (await live().approvals.list({}, live().ctx)).items;
  const decide = async (id: string, verdict: "approve" | "reject") => {
    const route = live().routes.get("POST /admin/api/approvals/:id/decision");
    const response = await route?.(new Request(`http://pikit.test/admin/api/approvals/${id}/decision`, { method: "POST", headers: OPERATOR, body: JSON.stringify({ verdict }) }), live().ctx);
    return response?.status;
  };
  /** Runs of the developer so far. */
  const developerRuns = () => results.filter((r) => r.conversation.agent === "developer");
  return { done, results, boot, stop, until, say, answered, approvals, decide, developerRuns };
}

const toolResults = (result: Result): string[] =>
  (result.messages as { role: string; content?: { type: string; text?: string }[] }[]).flatMap((message) =>
    message.role === "toolResult" ? (message.content ?? []).flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])) : [],
  );

const call = (tool: string, args: unknown) => `call: ${tool} ${JSON.stringify(args)}`;
const BLOCKED = `"delegate" needs a person's approval of this exact call.`;
/** The delegation the trader asks for: the developer is to fix a script. */
const TASK = { agent: "developer", task: call("work", { what: "fix dv360 sync" }) };

/** The trader asks for `args` to be approved; returns the approval's id and the yes answer. */
async function ask(w: ReturnType<typeof world>, id: string, args: unknown) {
  await w.say("trader-user", id, call("request_approval", { tool: "delegate", args, title: "Hand the fix to the developer", reason: "The sync script is broken." }));
  const question = (await w.answered(id)).parts?.find((part) => part.type === "question") as QuestionPart | undefined;
  expect(question?.id).toStartWith("approval:");
  return { id: (question?.id ?? "").slice("approval:".length), yes: answerText(question as QuestionPart, { approve: true }) };
}

test("a delegation runs only once a person approves that exact delegate call, survives a restart, and runs once", async () => {
  const w = world();
  await w.boot();

  // 1. Without an approval the delegate call is refused before the developer runs.
  expect(toolResults(await w.say("alice", "m1", call("delegate", TASK)))[0]).toContain(BLOCKED);
  expect(w.developerRuns()).toEqual([]);
  expect(w.done).toEqual([]);

  // 2. The trader asks; the question reaches the chat.
  const { id, yes } = await ask(w, "m2", TASK);
  expect(await w.approvals()).toMatchObject([{ id, status: "pending", action: { type: "tool:delegate" } }]);

  // 3. Someone who is no approver records nothing; the approver does.
  expect((await w.say("mallory", "m3", yes)).text).toContain(`[approvals] Not recorded: test:mallory may not decide approval ${id}.`);
  expect((await w.say("boss", "m4", yes)).text).toContain(`[approvals] Recorded: approval ${id} is approved, decided by test:boss.`);

  // 4. Another task is another call: still refused.
  const other = { agent: "developer", task: call("work", { what: "delete the database" }) };
  expect(toolResults(await w.say("alice", "m5", call("delegate", other)))[0]).toContain(BLOCKED);
  expect(w.done).toEqual([]);

  // 5. A restart between the approval and its use keeps it.
  await w.stop();
  await w.boot();
  expect(await w.approvals()).toMatchObject([{ id, status: "approved" }]);

  // 6. The exact call runs the developer, once.
  expect(toolResults(await w.say("alice", "m6", call("delegate", TASK)))[0]).toStartWith('The agent "developer" answered:');
  expect(w.done).toEqual(["fix dv360 sync"]);
  expect(await w.approvals()).toMatchObject([{ id, status: "executed", decidedBy: { channel: "test", id: "boss" } }]);

  // 7. Once is once.
  expect(toolResults(await w.say("alice", "m7", call("delegate", TASK)))[0]).toContain(BLOCKED);
  expect(w.done).toEqual(["fix dv360 sync"]);
});

test("an operator approves or rejects a delegation from the dashboard (pi-hive's /tasks approve|reject); a background delegation works the same", async () => {
  const w = world();
  await w.boot();

  // Rejected in the dashboard: the call stays refused.
  const rejected = await ask(w, "m1", TASK);
  expect(await w.decide(rejected.id, "reject")).toBe(200);
  expect(toolResults(await w.say("alice", "m2", call("delegate", TASK)))[0]).toContain(BLOCKED);
  expect(w.done).toEqual([]);

  // Approved in the dashboard, for a delegation that does not wait: the developer runs in the background.
  const background = { ...TASK, wait: false };
  const approved = await ask(w, "m3", background);
  expect(await w.decide(approved.id, "approve")).toBe(200);
  expect((await w.answered(`approval-decided:${approved.id}`)).conversation).toMatchObject({ key: `test:${CHAT}`, agent: "trader" });
  expect(toolResults(await w.say("alice", "m4", call("delegate", background)))[0]).toMatch(/^The task "\d+" is with the agent "developer" now\./);
  await w.until(() => (w.done.length > 0 ? w.done : undefined), "the developer's work");
  expect(w.done).toEqual(["fix dv360 sync"]);
  await w.until(() => w.results.find((r) => r.requestId.startsWith("delegate-result:")), "the developer's report");
  expect((await w.approvals()).find((a) => a.id === approved.id)).toMatchObject({ status: "executed" });
});
