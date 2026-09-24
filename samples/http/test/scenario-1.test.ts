/**
 * Scenario 1 (SPEC §15): talk to an agent over HTTP. `runtime-pi` + `server-bun` + `channel-http`,
 * with the sample's sessions, registry, secrets and router, over real HTTP on a free port. Pi runs
 * the agent on its faux provider, scripted: each turn answers `answer: <newest message>`, and
 * `hold` blocks in a tool until the test releases it.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Admission, defineComponent } from "@pikit/core";
import { holdTool, scriptedAgent } from "@pikit/pi-adapter/testing";
import { createSample, type Sample } from "./sample.ts";

/** A `hold` tool the test releases, and a promise that it was called. */
function releasableHold() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let called!: () => void;
  const started = new Promise<void>((resolve) => (called = resolve));
  const tool = holdTool(async () => {
    called();
    await released;
    return "released";
  });
  return { agent: scriptedAgent(tool), started, release };
}

const samples: Sample[] = [];
afterEach(async () => {
  for (const sample of samples.splice(0)) await sample.dispose();
});

async function running(extra: Parameters<typeof createSample>[0]["extra"] = []) {
  const hold = releasableHold();
  const sample = await createSample({ agents: [hold.agent], extra });
  samples.push(sample);
  await sample.app.start();
  return { sample, hold };
}

test("a message is answered in the HTTP response", async () => {
  const { sample } = await running();

  const answered = await sample.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" });

  expect(answered).toEqual({ status: 200, body: { requestId: "m1", text: "answer: hello" } });
});

test("a message sent while the agent works changes its course, and both POSTs get the answer", async () => {
  let admitted!: (admission: Admission) => void;
  const secondAdmitted = new Promise<Admission>((resolve) => (admitted = resolve));
  const observer = defineComponent({
    name: "admissions",
    setup: (pikit) =>
      pikit.on("agent.dispatched", ({ admission }) => {
        if (admission.requestId === "m2") admitted(admission);
      }),
  });
  const { sample, hold } = await running([observer]);

  const first = sample.post("/v1/messages", { conversationId: "c1", text: "hold", messageId: "m1" });
  await hold.started;
  const second = sample.post("/v1/messages", { conversationId: "c1", text: "change course", messageId: "m2" });
  // Admitted into the running run: Pi's inbox, as a steer. pikit queues nothing of its own.
  expect(await secondAdmitted).toEqual({ kind: "queued", requestId: "m2" });
  hold.release();

  // The run took both messages (AgentResult.requestIds), so both POSTs get its one answer.
  expect(await first).toEqual({ status: 200, body: { requestId: "m1", text: "answer: change course" } });
  expect(await second).toEqual({ status: 200, body: { requestId: "m2", text: "answer: change course" } });
});

test("a wrong or missing token is a 401", async () => {
  const { sample } = await running();

  expect((await sample.post("/v1/messages", { conversationId: "c1", text: "hello" }, "wrong-token-0123456789")).status).toBe(401);
  expect((await sample.post("/v1/messages", { conversationId: "c1", text: "hello" }, "")).status).toBe(401);
  expect((await sample.post("/v1/conversations/c1/reset", undefined, "wrong-token-0123456789")).status).toBe(401);
});

test("/health is 200 while the process lives; /ready is 200 only after runtime.ready, and 503 while stopping", async () => {
  let finishStart!: () => void;
  const startGate = new Promise<void>((resolve) => (finishStart = resolve));
  let inStart!: () => void;
  const startEntered = new Promise<void>((resolve) => (inStart = resolve));
  let finishStop!: () => void;
  const stopGate = new Promise<void>((resolve) => (finishStop = resolve));
  let inStop!: () => void;
  const stopEntered = new Promise<void>((resolve) => (inStop = resolve));
  // Listed last: it starts after the server listens and stops before the server closes.
  const slow = defineComponent({
    name: "slow-component",
    setup: () => ({
      async start() {
        inStart();
        await startGate;
      },
      async stop() {
        inStop();
        await stopGate;
      },
    }),
  });
  const hold = releasableHold();
  const sample = await createSample({ agents: [hold.agent], extra: [slow] });
  samples.push(sample);

  const starting = sample.app.start();
  await startEntered;
  const whileStarting = [await sample.status("/health"), await sample.status("/ready")];
  finishStart();
  await starting;
  const whenReady = [await sample.status("/health"), await sample.status("/ready")];
  const stopping = sample.stop();
  await stopEntered;
  const whileStopping = [await sample.status("/health"), await sample.status("/ready")];
  finishStop();
  await stopping;

  expect(whileStarting).toEqual([200, 503]);
  expect(whenReady).toEqual([200, 200]);
  expect(whileStopping).toEqual([200, 503]);
});

test("reset starts the conversation over on a new session and keeps the old one", async () => {
  const { sample } = await running();
  await sample.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" });
  const duplicate = await sample.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" });

  const reset = await sample.post("/v1/conversations/c1/reset");
  // The same message id is new again: it is in the old session, not in the new one.
  const again = await sample.post("/v1/messages", { conversationId: "c1", text: "hello again", messageId: "m1" });

  expect(duplicate).toEqual({ status: 409, body: { requestId: "m1", error: "duplicate" } });
  expect(reset.status).toBe(200);
  expect(reset.body.sessionId).not.toBe(reset.body.previousSessionId);
  expect(again).toEqual({ status: 200, body: { requestId: "m1", text: "answer: hello again" } });
  const registry = JSON.parse(readFileSync(join(sample.dataDir, "conversations.json"), "utf8"));
  expect(registry.conversations["http:c1"]).toMatchObject({
    sessionId: reset.body.sessionId,
    previousSessionIds: [reset.body.previousSessionId],
  });
  expect(sessionFiles(sample.dataDir)).toHaveLength(2);
  expect((await sample.post("/v1/conversations/nobody/reset")).status).toBe(404);
});

test("a conversation outlives the process: after a restart it is the same conversation", async () => {
  const hold = releasableHold();
  const first = await createSample({ agents: [hold.agent] });
  await first.app.start();
  await first.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" });
  await first.stop();

  const second = await createSample({ agents: [hold.agent], dataDir: first.dataDir });
  samples.push(second);
  await second.app.start();

  // The registry and Pi's session were on disk: the message is known, the conversation continues.
  expect(await second.post("/v1/messages", { conversationId: "c1", text: "hello", messageId: "m1" })).toEqual({
    status: 409,
    body: { requestId: "m1", error: "duplicate" },
  });
  expect(await second.post("/v1/messages", { conversationId: "c1", text: "still there?", messageId: "m2" })).toEqual({
    status: 200,
    body: { requestId: "m2", text: "answer: still there?" },
  });
  expect(sessionFiles(second.dataDir)).toHaveLength(1);
});

/** Every session file Pi wrote under the sample's sessions root. */
function sessionFiles(dataDir: string): string[] {
  const root = join(dataDir, "sessions");
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".jsonl"));
}
