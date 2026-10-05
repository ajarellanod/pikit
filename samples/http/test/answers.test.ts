/**
 * No admitted message ends without an answer reaching its user, across crashes, restarts and
 * deploys (SPEC P5; `agent.submissions` and its answers feed). With the storage and submissions
 * `runtime-pi` brings:
 *
 * - **Killed after the ack.** Telegram was told "received" (it will not send the message again), and
 *   the process is killed mid-run (SIGKILL). The next process resumes the run at start and the answer
 *   reaches the chat, with no new message.
 * - **An answer that ends during a shutdown.** The channel stops before the runtime; a run that ends
 *   in between is delivered by the channel when the app starts again.
 * - **HTTP.** A POST that answered `202` reads its answer with `GET`, and sending it again returns it.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineComponent } from "@pikit/core";
import { holdTool, scriptedAgent } from "@pikit/pi-adapter/testing";
import { type FakeTelegram, startFakeTelegram } from "../../../registry/components/channel-telegram/files/src/pikit/channel-telegram/fake-telegram.test-support.ts";
import { createSample, type Sample } from "./sample.ts";
import { OWNER, telegramApp } from "./telegram.ts";

const WORKER = join(import.meta.dir, "telegram-worker.ts");
const directories: string[] = [];
const apps: App[] = [];
const fakes: FakeTelegram[] = [];
const samples: Sample[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const sample of samples.splice(0)) await sample.dispose();
  for (const fake of fakes.splice(0)) await fake.stop();
});
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-answers-"));
  directories.push(dir);
  return dir;
}

/** Resolves once `stream` has printed the line `line`. */
async function printed(stream: ReadableStream<Uint8Array>, line: string): Promise<void> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.split("\n").includes(line)) return;
  }
  throw new Error(`the stream ended before printing "${line}"`);
}

/**
 * The `hold` of an app that must not run it: its answer comes from what the previous process
 * recorded. A call is counted (the test asserts none) and fails the tool, so a re-run cannot pass.
 */
let holdRanAgain = 0;
afterEach(() => {
  holdRanAgain = 0;
});
async function notRunAgain(): Promise<string> {
  holdRanAgain++;
  throw new Error("hold ran again: the answer must come from the recorded run");
}

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test("killed after Telegram's ack, mid-run: the next process answers with no new message", async () => {
  const dataDir = temporaryDir();
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  const worker = Bun.spawn([process.execPath, WORKER, dataDir, telegram.url], { stdout: "pipe", stderr: "pipe" });
  try {
    const held = printed(worker.stdout, "held");

    telegram.say(OWNER, "hold");
    await Promise.race([
      held,
      worker.exited.then(async () => {
        throw new Error(`the worker exited: ${await new Response(worker.stderr).text()}`);
      }),
    ]);
    // Telegram forgets an update once a later poll confirms it: it will never deliver it again.
    await until(() => telegram.pending().length === 0, "Telegram to have the message acknowledged");
  } finally {
    worker.kill("SIGKILL");
    await worker.exited;
  }
  expect(telegram.sent).toEqual([]);

  // The next process: nobody writes again. The resumed run does not run `hold` again (`replay: "never"`).
  const app = await telegramApp({ dataDir, apiBase: telegram.url, hold: notRunAgain }).create();
  apps.push(app);
  await app.start();

  const [answer] = await telegram.sentCount(1, 15_000);
  expect(answer).toEqual({ chatId: OWNER.id, text: "answer: hold", html: true });
  expect(telegram.pending()).toEqual([]);
  expect(holdRanAgain).toBe(0);
}, 60_000);

test("an answer that ends while the channel is stopping reaches the chat when the app starts again", async () => {
  const dataDir = temporaryDir();
  const telegram = startFakeTelegram();
  fakes.push(telegram);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const holding = new Promise<void>((resolve) => (started = resolve));
  /**
   * Stops after the channel and before the runtime, as `pikit up` does to a running app: it lets the
   * run end there, and waits for its end.
   */
  const deploy = defineComponent({
    name: "deploy-in-between",
    setup(pikit) {
      pikit.use("agent.runtime");
      let ended!: () => void;
      const end = new Promise<void>((resolve) => (ended = resolve));
      pikit.on("agent.settled", () => ended());
      return {
        async stop() {
          release();
          await end;
        },
      };
    },
  });
  const first = await telegramApp({
    dataDir,
    apiBase: telegram.url,
    between: [deploy],
    hold: async () => {
      started();
      await released;
      return "released";
    },
  }).create();
  await first.start();
  telegram.say(OWNER, "hold");
  await holding;

  await first.stop();
  // Before this change, the answer was lost here: the channel had stopped when the run ended.
  expect(telegram.sent).toEqual([]);

  // The answer comes from the recorded run's end, not from running it again.
  const next = await telegramApp({ dataDir, apiBase: telegram.url, hold: notRunAgain }).create();
  apps.push(next);
  await next.start();

  const [answer] = await telegram.sentCount(1, 10_000);
  expect(answer).toEqual({ chatId: OWNER.id, text: "answer: hold", html: true });
  await Bun.sleep(200);
  expect(telegram.sent).toHaveLength(1);
  expect(holdRanAgain).toBe(0);
}, 60_000);

test("HTTP: a POST that answered 202 reads its answer with GET, and sending it again returns it", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const agent = scriptedAgent(
    holdTool(async () => {
      await released;
      return "released";
    }),
  );
  const sample = await createSample({ agents: [agent], config: { "channel-http": { replyTimeoutMs: 200 } } });
  samples.push(sample);
  await sample.app.start();

  expect(await sample.post("/v1/messages", { conversationId: "c1", text: "hold", messageId: "m1" })).toEqual({ status: 202, body: { requestId: "m1" } });
  expect(await sample.get("/v1/conversations/c1/messages/m1")).toEqual({ status: 202, body: { requestId: "m1" } });
  release();
  const deadline = Date.now() + 10_000;
  while ((await sample.get("/v1/conversations/c1/messages/m1")).status === 202) {
    if (Date.now() > deadline) throw new Error("the answer never came");
    await Bun.sleep(20);
  }

  expect(await sample.get("/v1/conversations/c1/messages/m1")).toEqual({ status: 200, body: { requestId: "m1", text: "answer: hold" } });
  expect(await sample.post("/v1/messages", { conversationId: "c1", text: "hold", messageId: "m1" })).toEqual({
    status: 200,
    body: { requestId: "m1", text: "answer: hold" },
  });
  expect((await sample.get("/v1/conversations/c1/messages/never-sent")).status).toBe(404);
}, 30_000);
