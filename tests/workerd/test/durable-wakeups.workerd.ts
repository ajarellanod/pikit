/**
 * Wake-ups for pi-durable (`@pikit/pi-adapter/wakeups`) on a real Durable Object:
 * deployment-cloudflare's `Conversation` class (`PlatformConversation`, `src/platform.ts`) over an App
 * of storage-do, platform-cloudflare (its `wakeups` on the object's one alarm) and a small driver
 * component, which is the integration recipe in miniature:
 *
 * - at start it opens the Harness over `storage.sql` on the app's clock, registers the `wakeups`
 *   handler that drives a slice, and asks for a wake-up at `nextWakeAt` if work is pending;
 * - the handler runs `driveSlice` with the slice's cancellation, and asks again for `nextWakeAt`.
 *
 * A run that hits a model error's backoff leaves the object's alarm at the retry time; the object is
 * evicted (its in-process sleep with it); an early alarm runs nothing; the alarm at the retry time
 * constructs the object again, and the run completes in it.
 *
 * `Date` (the apps' clock: the tests and the objects share one isolate) is moved ahead by the test, so
 * the retry comes due without waiting out the backoff.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { Wakeups } from "@pikit/contracts";
import { type AppContext, defineComponent } from "@pikit/core";
import { driveSlice, nextWakeAt } from "@pikit/pi-adapter/wakeups";
import {
  answerOf,
  context,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  liveDueTimes,
  openClockedHarness,
  serviceUnavailable,
  submitInput,
} from "@pikit/pi-adapter/wakeups/testing";
import { afterEach, expect, it, vi } from "vitest";
import platformCloudflare from "../../../registry/components/platform-cloudflare/files/src/pikit/platform-cloudflare/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { composeObjects } from "../src/platform.ts";
import { resetObjects } from "./host.ts";

/** The `wakeups` name the driver owns. */
const DRIVE = "pi-durable.drive";
const RETRY_MS = 60_000;

type Harness = Awaited<ReturnType<typeof openClockedHarness>>["harness"];

/** The faux answers of each App the objects start, in order: the next App takes the first. */
let scripts: FauxResponseStep[][] = [];
/** Every App the driver started, the last one current. */
const apps: { harness: Harness; faux: FauxProviderHandle; wakeups: Wakeups; ctx: AppContext }[] = [];

const driver = defineComponent({
  name: "pi-durable-driver",
  setup(pikit) {
    const sql = pikit.use("storage.sql");
    const wakeupsHandle = pikit.use("wakeups");
    return {
      async start(ctx) {
        const wakeups = wakeupsHandle.get();
        const now = () => ctx.clock.now();
        const settings = { retry: { baseDelayMs: RETRY_MS } };
        const { harness, faux } = await openClockedHarness(sql.get(), { now, faux: scripts.shift() ?? [], settings });
        apps.push({ harness, faux, wakeups, ctx });
        wakeups.handle(DRIVE, async (slice) => {
          const result = await driveSlice(harness, { signal: slice.abortSignal, now });
          // Asked with the start context: the slice's may be cancelled already.
          if (result.nextWakeAt !== undefined) await wakeups.at(DRIVE, result.nextWakeAt, ctx);
        });
        // What survived an eviction asks for its wake-up again (the table's request may be gone).
        const next = await nextWakeAt(harness, context, { now });
        if (next !== undefined) await wakeups.at(DRIVE, next, ctx);
      },
    };
  },
});

afterEach(async () => {
  vi.useRealTimers();
  // Not closed here: a Harness touches its object's storage, which only that object's events may.
  apps.length = 0;
  scripts = [];
  await resetObjects();
});

/** From now on `Date`, the apps' clock, runs `ms` ahead of the real one. */
const ahead = (ms: number) => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms, shouldAdvanceTime: true });

/** What a test calls on the class: its `health` RPC starts the object's App. */
type Started = { health(): Promise<{ ok: true }> };

/** Runs `work` in the object once its App started, with the current App's driver state. */
const inside = <R>(stub: DurableObjectStub, work: (app: (typeof apps)[number], storage: DurableObjectStorage) => Promise<R>): Promise<R> =>
  runInDurableObject(stub, async (instance: DurableObject, state) => {
    await (instance as unknown as Started).health();
    const app = apps.at(-1);
    if (app === undefined) throw new Error("the driver did not start");
    return work(app, state.storage);
  });

it("a run evicted during a model error's backoff is completed by the alarm nextWakeAt set", async () => {
  scripts = [[serviceUnavailable()], [fauxAssistantMessage("Paris.")]];
  composeObjects([storageDo, platformCloudflare, driver]);
  const stub = env.PLATFORM_CONVERSATION.get(env.PLATFORM_CONVERSATION.newUniqueId());

  // A message arrives; the object asks for a drive at once (as a channel's dispatch would).
  const submissionId = await inside(stub, async (app) => {
    const id = await submitInput(app.harness, "Capital of France?");
    await app.wakeups.at(DRIVE, app.ctx.clock.now(), app.ctx);
    return id;
  });
  // The drive's slice: the model errors, and the backoff becomes the object's alarm. The runtime may
  // fire the due alarm itself; one fired here before the retry time only sets it again.
  const retryAt = await vi.waitFor(async () => {
    await runDurableObjectAlarm(stub);
    return inside(stub, async (app, storage) => {
      const { retryAt } = await liveDueTimes(app.harness);
      expect(retryAt).toBeDefined();
      expect(await nextWakeAt(app.harness, context, { now: () => app.ctx.clock.now() })).toBe(retryAt);
      expect(await storage.getAlarm()).toBe(Math.ceil(retryAt as number));
      return retryAt as number;
    });
  });
  expect(apps[0]?.faux.state.callCount).toBe(1);

  // Evicted: the instance and its in-process sleep are gone. Locally, a pending timer keeps an object
  // from being evicted (and the tests share the isolate), so the instance's Harness is closed first,
  // in an event of its object, which ends the sleep as an eviction would.
  await inside(stub, (app) => app.harness.close(context));
  await evictDurableObject(stub);

  // Early: the alarm constructs the object again, whose App finds the run pending; nothing runs yet.
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await inside(stub, async (app, storage) => {
    expect(apps.length).toBe(2);
    expect(app.faux.state.callCount).toBe(0);
    expect(await answerOf(app.harness, submissionId)).toEqual({ status: "placed" });
    expect(await storage.getAlarm()).toBe(Math.ceil(retryAt));
  });

  // At the retry time, the alarm drives the run to its answer, and asks for nothing more.
  ahead(retryAt - Date.now() + 1_000);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await inside(stub, async (app, storage) => {
    expect(app.faux.state.callCount).toBe(1);
    expect(await answerOf(app.harness, submissionId)).toEqual({ status: "done", answer: "Paris." });
    expect(await nextWakeAt(app.harness, context)).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });
});
