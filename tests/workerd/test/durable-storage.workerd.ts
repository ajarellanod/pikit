/**
 * pi-durable 1.0's `SqliteStorage` over storage-do's `storage.sql` on a real SQLite-backed Durable
 * Object (spike, packages/pi-adapter/src/durable/README.md): pi-durable's own storage conformance
 * suite, each case in an object of its own; then a `Harness` over it, reopened in the same object,
 * after an eviction, and across the object's events.
 */

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import type { SqlDatabase } from "@pikit/contracts";
import type { WorkersHost } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/testing";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { openDurableStorage } from "@pikit/pi-adapter/durable";
import {
  answerOnce,
  answerWithTool,
  checkReopened,
  context,
  fauxAssistantMessage,
  interruptGeneration,
  MODEL,
  openHarness,
  pendingWork,
  registerStorageConformance,
  resumeInterrupted,
} from "@pikit/pi-adapter/durable/testing";
import { describe, expect, it } from "vitest";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { hostOf, inObject, objectHost } from "./host.ts";

/** A started app of storage-do in the object of `host`, and its `storage.sql`. */
async function openApp(host: WorkersHost): Promise<{ db: SqlDatabase; stop(): Promise<void> }> {
  let db: SqlDatabase | undefined;
  const reader = defineComponent({
    name: "durable-reader",
    setup(pikit) {
      const handle = pikit.use("storage.sql");
      return { start: () => void (db = handle.get()) };
    },
  });
  const app = await defineApp({ components: [...withWorkersHost(host, [storageDo]), reader], logger: silentLogger }).create();
  await app.start();
  if (db === undefined) throw new Error("storage.sql was not resolved");
  return { db, stop: () => app.stop() };
}

/** Runs `work` over a new app of storage-do in `stub`'s object (one event of the object). */
function inApp<T>(stub: DurableObjectStub, work: (db: SqlDatabase) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, async (_instance, state: DurableObjectState) => {
    const { db, stop } = await openApp(hostOf(state));
    try {
      return await work(db);
    } finally {
      await stop();
    }
  });
}

registerStorageConformance(
  { describe, expect, it: (name, test) => it(name, () => inObject(() => test())) },
  "pi-durable storage over storage-do",
  async (use) => {
    const { db, stop } = await openApp(objectHost());
    try {
      const storage = await openDurableStorage(db);
      try {
        await use(storage);
      } finally {
        await storage.close(context).catch(() => {});
      }
    } finally {
      await stop();
    }
  },
);

describe("a Harness over storage-do's storage.sql", () => {
  it("answers, finds a resubmitted requestId, and a new app in the same object finds root and transcript", () =>
    inObject(async (host) => {
      const first = await openApp(host);
      const run = await answerOnce(first.db).finally(() => first.stop());
      const second = await openApp(host);
      await checkReopened(second.db, run).finally(() => second.stop());
    }));

  it("a tool call is validated (TypeBox), run and answered in workerd", () =>
    inObject(async (host) => {
      const { db, stop } = await openApp(host);
      await answerWithTool(db).finally(stop);
    }));

  it("an evicted object keeps root, transcript and submissions", async () => {
    const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
    const run = await inApp(stub, answerOnce);
    await evictDurableObject(stub);
    await inApp(stub, (db) => checkReopened(db, run));
  });

  it("a run interrupted mid-generation, then evicted, is pending in the object and resumes", async () => {
    const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
    const run = await inApp(stub, interruptGeneration);
    await evictDurableObject(stub);
    const pending = await inApp(stub, pendingWork);
    expect(pending.tasks.map((t) => [t.kind, t.status, t.inspection])).toEqual([["pi.generation", "pending", "ready"]]);
    expect(pending.submissions).toEqual(["placed"]);
    await inApp(stub, (db) => resumeInterrupted(db, run));
  });

  it("a Harness kept by the object runs a submission on after the event that submitted it returned", async () => {
    const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
    // The object's instance keeps its app and Harness across events, as a conversation's object would.
    const kept: { harness?: Awaited<ReturnType<typeof openHarness>>; stop?: () => Promise<void> } = {};
    const submissionId = await runInDurableObject(stub, async (_instance, state: DurableObjectState) => {
      const { db, stop } = await openApp(hostOf(state));
      kept.stop = stop;
      kept.harness = await openHarness(db, [fauxAssistantMessage("Later.")]);
      const root = await kept.harness.root(context, { agent: { model: MODEL } });
      return (await root.submit({ type: "input", content: "Answer later", requestId: "later" }, context)).id;
    });
    const settled = await runInDurableObject(stub, async () => {
      const submission = await kept.harness!.submission(submissionId, context);
      return (await submission!.wait(context)).status;
    });
    expect(settled).toBe("done");
    await runInDurableObject(stub, async () => {
      await kept.harness!.close(context);
      await kept.stop!();
    });
  });
});
