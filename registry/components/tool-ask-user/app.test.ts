/**
 * tool-ask-user in a real App: runtime-pi runs the agent on a SQLite file and the model is the scripted
 * faux provider (`faux/scripted`: `call: <tool> <json>` calls a tool, anything else is answered
 * `answer: <message>`). The run that calls `askUser` ends with the question in `AgentResult.parts`, and
 * the answer, sent later as a message, starts a new run that reads it.
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppEvents, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentRuntime, answerText, type ConversationRef, defineAgent, type QuestionPart } from "@pikit/contracts";
import { scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import toolAskUser, { ASK_USER_TOOL } from "./files/src/pikit/tool-ask-user/index.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Result = AppEvents["agent.settled"] | AppEvents["agent.failed"];

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-ask-user-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const results: Result[] = [];
  let reached: { runtime: AgentRuntime; create: () => Promise<string> } | undefined;
  const app = await defineApp({
    components: [
      sqliteStorage(join(dir, "pikit.db")),
      defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted", tools: [ASK_USER_TOOL] })) }),
      defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider()) }),
      toolAskUser,
      runtimePi,
      defineComponent({
        name: "observer",
        setup(pikit) {
          const runtime = pikit.use("agent.runtime");
          const conversations = pikit.use("agent.conversations");
          pikit.on("agent.settled", (result) => void results.push(result));
          pikit.on("agent.failed", (result) => void results.push(result));
          return { start: (ctx) => void (reached = { runtime: runtime.get(), create: () => conversations.get().create(ctx) }) };
        },
      }),
    ],
    logger: silentLogger,
  }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const live = () => reached ?? (() => { throw new Error("the observer has not started"); })();
  return {
    async conversation(key: string): Promise<ConversationRef> {
      return { key, agent: "assistant", conversationId: await live().create() };
    },
    async send(conversation: ConversationRef, requestId: string, prompt: string): Promise<void> {
      await live().runtime.dispatch({ requestId, conversation, prompt, sender: { channel: "test", id: "alice" } }, app.context());
    },
    async result(requestId: string): Promise<Result> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = results.find((result) => result.requestId === requestId);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${requestId}; results: ${JSON.stringify(results.map((r) => [r.requestId, r.kind]))}`);
        await Bun.sleep(5);
      }
    },
  };
}

test("askUser ends the run with the question in AgentResult.parts; the answer, a later message, starts a run that reads it", async () => {
  const s = await start();
  const conversation = await s.conversation("test:1");
  const question = { title: "Which environment?", fields: [{ kind: "select", name: "env", label: "Environment", required: true, options: [{ value: "prod", label: "Production" }, { value: "staging", label: "Staging" }] }] };
  await s.send(conversation, "m1", `call: ${ASK_USER_TOOL} ${JSON.stringify(question)}`);

  const asked = await s.result("m1");
  expect(asked.kind).toBe("completed");
  // The run ended with the call: no answer after it, only the question.
  expect(asked.text ?? "").toBe("");
  const [part, ...more] = (asked.parts ?? []) as QuestionPart[];
  expect(more).toEqual([]);
  expect(part).toMatchObject({ type: "question", title: "Which environment?", fields: question.fields });
  expect(part?.id).toMatch(new RegExp(`^${conversation.conversationId}:m1:.+$`));
  expect(part?.fallback).toContain("- Environment: one of Production (prod), Staging (staging)");

  const answer = answerText(part!, { env: "staging" });
  await s.send(conversation, "m2", answer);
  const answered = await s.result("m2");
  expect(answered.kind).toBe("completed");
  expect(answered.text).toBe(`answer: ${answer}`);
  expect(answered.parts ?? []).toEqual([]);
});
