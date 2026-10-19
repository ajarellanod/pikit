/**
 * extension-approvals in a real App: runtime-pi on a SQLite file, mailbox-local, approvals-sql, and the
 * scripted faux model. The agent asks for approval of one exact `bash` call; a stranger's answer
 * records nothing; the approver's does, once, also when redelivered; after a restart that exact call
 * runs once, and the same call again, or another command, is refused.
 *
 * A repository test, not copied with the component (a component's files never import another's, SPEC
 * P4); in a project it is the project's own.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, Halt, silentLogger } from "@pikit/core";
import { type AgentRuntime, type AgentTool, answerText, type ConversationRef, defineAgent, type QuestionPart, type Sender } from "@pikit/contracts";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { recordingBash, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import approvalsSql from "../approvals-sql/files/src/pikit/approvals-sql/index.ts";
import mailboxLocal from "../mailbox-local/files/src/pikit/mailbox-local/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import type { ApprovalStore } from "./files/src/pikit/extension-approvals/contract.ts";
import extensionApprovals from "./files/src/pikit/extension-approvals/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const owner: Sender = { channel: "telegram", id: "1001" };
const stranger: Sender = { channel: "telegram", id: "2002" };
const config = { "extension-approvals": { tools: ["bash"], approvers: ["telegram:1001", "dashboard:*"] } };

const agents = defineComponent({
  name: "agents-test",
  setup: (pikit) => pikit.provideKeyed("agent.definition", "guarded", defineAgent({ name: "guarded", model: "faux/scripted", tools: ["bash"], extensions: ["approvals"] })),
});

/** An App over the SQLite file `db`; `send` dispatches a message (through `inbound.normalize`, as `admitInbound` does) and waits for its run. */
async function start(db: string, ran: string[]) {
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  let reached: { runtime: AgentRuntime; approvals: ApprovalStore; create: () => Promise<string> } | undefined;
  const observer = defineComponent({
    name: "observer",
    setup(pikit) {
      const runtime = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      const approvals = pikit.use("approvals");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return { start: (ctx) => void (reached = { runtime: runtime.get(), approvals: approvals.get(), create: () => conversations.get().create(ctx) }) };
    },
  });
  const tools = defineComponent({
    name: "tool-test",
    setup(pikit) {
      pikit.provideKeyed("agent.tool", "bash", recordingBash(ran) as AgentTool);
      pikit.provide("execution", createLocalExecution({ cwd: tmpdir(), env: {} }));
    },
  });
  const provider = defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider()) });
  const components = [sqliteStorage(db), mailboxLocal, approvalsSql, extensionApprovals, agents, provider, tools, runtimePi, observer];
  const app = await defineApp({ components, config, logger: silentLogger }).create();
  await app.start();
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();

  return {
    app,
    approvals: () => live().approvals,
    create: async (): Promise<ConversationRef> => ({ key: "telegram:1001", agent: "guarded", conversationId: await live().create() }),
    async send(conversation: ConversationRef, id: string, text: string, sender: Sender) {
      const normalized = await app.context().run("inbound.normalize", { id, channel: sender.channel, conversationId: "chat-1", actor: { id: sender.id }, text });
      if (normalized instanceof Halt) throw new Error(`halted: ${normalized.reason}`);
      const admission = await live().runtime.dispatch({ requestId: id, conversation, prompt: normalized.text, sender }, app.context());
      if (admission.kind === "duplicate") return { admission, result: undefined };
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = results.find((r) => r.requestId === id);
        if (result !== undefined) return { admission, result };
        if (Date.now() > deadline) throw new Error(`timed out waiting for the result of ${id}`);
        await Bun.sleep(5);
      }
    },
  };
}

test("an exact call approved by an approver runs once after a restart; strangers, other arguments and a second call are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-approvals-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "pikit.db");
  const ran: string[] = [];
  let s = await start(db, ran);
  cleanup.push(() => s.app.stop());
  const conversation = await s.create();

  // Before any approval the call is refused, and the model is told how to ask.
  const early = await s.send(conversation, "m1", "bash: ls", owner);
  expect(early.result?.text).toContain(`"bash" needs a person's approval of this exact call. Call request_approval with tool "bash" and args {"command":"ls"}`);

  // The agent asks; its run ends with the question.
  const asked = await s.send(conversation, "m2", 'call: request_approval {"tool":"bash","args":{"command":"ls"},"title":"List the files","reason":"To see them"}', owner);
  const question = asked.result?.parts?.[0] as QuestionPart | undefined;
  expect(question?.type).toBe("question");
  expect(question?.id).toStartWith("approval:");
  expect(question?.fallback).toContain('Action: bash {"command":"ls"}');
  const id = (question?.id ?? "").slice("approval:".length);
  const yes = answerText(question as QuestionPart, { approve: true });
  expect(question?.fallback).toContain(yes);

  // A stranger's yes records nothing, and the call stays refused.
  const strangers = await s.send(conversation, "m3", yes, stranger);
  expect(strangers.result?.text).toContain(`[approvals] Not recorded: telegram:2002 may not decide approval ${id}.`);
  expect((await s.approvals().list({ status: "pending" }, s.app.context())).items.map((a) => a.id)).toEqual([id]);
  await s.send(conversation, "m4", "bash: ls", owner);
  expect(ran).toEqual([]);

  // The approver's yes is recorded before the model reads it; delivered again, nothing changes.
  const approved = await s.send(conversation, "m5", yes, owner);
  expect(approved.result?.text).toContain(`[approvals] Recorded: approval ${id} is approved, decided by telegram:1001.`);
  const decidedAt = (await s.approvals().list({}, s.app.context())).items[0]?.decidedAt;
  const redelivered = await s.send(conversation, "m5", yes, owner);
  expect(redelivered.admission.kind).toBe("duplicate");
  expect((await s.approvals().list({}, s.app.context())).items[0]?.decidedAt).toBe(decidedAt);

  // After a restart: other arguments are refused, the exact call runs once, the same call again is refused.
  await s.app.stop();
  s = await start(db, ran);
  cleanup.push(() => s.app.stop());
  const other = await s.send(conversation, "m6", "bash: rm -rf /", owner);
  expect(other.result?.text).toContain("needs a person's approval");
  const exact = await s.send(conversation, "m7", "bash: ls", owner);
  expect(exact.result?.text).toBe("tool said: ran");
  const second = await s.send(conversation, "m8", "bash: ls", owner);
  expect(second.result?.text).toContain("needs a person's approval");
  expect(ran).toEqual(["ls"]);
  const [record] = (await s.approvals().list({}, s.app.context())).items;
  expect(record).toMatchObject({ id, status: "executed", decidedBy: owner });
});

test("an approval is claimed only in the conversation that asked for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-approvals-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const ran: string[] = [];
  const s = await start(join(dir, "pikit.db"), ran);
  cleanup.push(() => s.app.stop());
  const asking = await s.create();
  const elsewhere = { ...(await s.create()), key: "telegram:3003" };

  const asked = await s.send(asking, "a1", 'call: request_approval {"tool":"bash","args":{"command":"ls"},"title":"List","reason":"Why not"}', owner);
  const question = asked.result?.parts?.[0] as QuestionPart;
  await s.send(asking, "a2", answerText(question, { approve: true }), owner);

  const other = await s.send(elsewhere, "b1", "bash: ls", owner);
  expect(other.result?.text).toContain("needs a person's approval");
  expect(ran).toEqual([]);
  await s.send(asking, "a3", "bash: ls", owner);
  expect(ran).toEqual(["ls"]);
});

test("request_approval refuses a tool that needs no approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-approvals-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = await start(join(dir, "pikit.db"), []);
  cleanup.push(() => s.app.stop());

  const asked = await s.send(await s.create(), "r1", 'call: request_approval {"tool":"read","args":{"path":"x"},"title":"Read","reason":"Why"}', owner);
  expect(JSON.stringify(asked.result?.messages)).toContain('\\"read\\" needs no approval here; only these do: bash');
  expect((await s.approvals().list({}, s.app.context())).items).toEqual([]);
});
