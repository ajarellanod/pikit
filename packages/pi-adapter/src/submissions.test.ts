/**
 * `storedRunsOf` (a reconciliation's grouping) against `runsOf` (the live one) over a real pi-durable
 * (`MemoryStorage`, pi-ai's faux provider): the same runs, in the same order, under the same keys, so a
 * run logged live is never logged again and no run is merged into another.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type CommitChange, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { isSettledInput, type SettledInput } from "./result.ts";
import { runKey, runsOf, storedRunsOf } from "./submissions.ts";

const ctx = BACKGROUND_CONTEXT;

async function open(responses: FauxResponseStep[], model = { provider: "faux", modelId: "faux-1" }) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { followUpMode: "all", steeringMode: "all" } }, ctx);
  const commits: CommitChange[][] = [];
  harness.subscribeCommits((publication) => void commits.push([...publication.changes]));
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
  /** The keys of the runs as the runtime groups them live (per commit) and as a reconciliation does (all at once). */
  const keys = async () => {
    const perCommit = commits.map((changes) => changes.flatMap((change) => (change.type === "submission" && isSettledInput(change.value) ? [change.value] : [])));
    const live = perCommit.flatMap((settled) => runsOf(settled));
    const stored = await storedRunsOf(storage, perCommit.flat(), ctx);
    const named = (runs: SettledInput[][]) => runs.map((run) => [runKey(run), run.map((record) => record.requestId)]);
    return { live: named(live), stored: named(stored) };
  };
  return { harness, conversation, keys };
}

/** A step that waits for `release()`, then answers `text` (or fails with it, `failing`). */
function gated(text: string, failing = false) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const reachedP = new Promise<void>((resolve) => (reached = resolve));
  const step: FauxResponseStep = async () => {
    reached();
    await released;
    return failing ? fauxAssistantMessage("", { stopReason: "error", errorMessage: text }) : fauxAssistantMessage(text);
  };
  return { step, reached: reachedP, release: () => release() };
}

test("two runs that failed in a row, with nothing between their inputs, are two runs, under their live keys", async () => {
  const { harness, conversation, keys } = await open([], { provider: "faux", modelId: "missing" });
  await (await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx)).wait(ctx);
  await (await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx)).wait(ctx);

  const { live, stored } = await keys();

  expect(live.map(([, requestIds]) => requestIds)).toEqual([["r1"], ["r2"]]);
  expect(stored).toEqual(live);
  await harness.close(ctx);
});

test("a batch that failed is one run, apart from the run before it, under its live key", async () => {
  const gate = gated("one");
  const broken = gated("scripted failure", true);
  const { harness, conversation, keys } = await open([gate.step, broken.step]);
  const first = await conversation.submit({ type: "input", content: "one", requestId: "r1" }, ctx);
  await gate.reached;
  const second = await conversation.submit({ type: "input", content: "two", requestId: "r2" }, ctx);
  const third = await conversation.submit({ type: "input", content: "three", requestId: "r3" }, ctx);
  gate.release();
  await first.wait(ctx);
  await broken.reached;
  broken.release();
  expect((await third.wait(ctx)).status).toBe("unanswered");
  expect((await second.wait(ctx)).status).toBe("unanswered");

  const { live, stored } = await keys();

  expect(live.map(([, requestIds]) => requestIds)).toEqual([["r1"], ["r2", "r3"]]);
  expect(stored).toEqual(live);
  await harness.close(ctx);
});
