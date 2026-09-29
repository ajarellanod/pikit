/**
 * The Durable Object session backend passes Pi's session conformance (SPEC §4): sessions-sql,
 * unmodified, over storage-do on a real SQLite-backed Durable Object, under Pi's own `SessionRepo` and
 * `Storage` suites. Then runtime-pi runs the `agent.runtime` conformance on those sessions, a worker
 * killed mid-run included: here a run abandoned in the object (`interruptInProcess`), which leaves
 * what a reset object leaves.
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createAgentRuntimeConformance, withWorkersHost } from "@pikit/contracts/testing";
import type { SessionStore } from "@pikit/pi-adapter";
import {
  createRuntimeFixture,
  createSessionRepoConformance,
  createSessionRepoStreamingForkConformance,
  createStorageConformance,
  interruptInProcess,
  storageOf,
} from "@pikit/pi-adapter/testing/neutral";
import { it } from "vitest";
import { createRuntimePi } from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import sessionsSql from "../../../registry/components/sessions-sql/files/src/pikit/sessions-sql/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import { inObject, objectHost } from "./host.ts";

/** sessions-sql over storage-do in the object the case runs in: what the conversation's object runs. */
const records = () => withWorkersHost(objectHost(), [storageDo, sessionsSql]);

/** A started app with the records, and the `sessions.store` it provides. */
async function openSessions(): Promise<{ sessions: SessionStore; stop(): Promise<void> }> {
  let sessions: SessionStore | undefined;
  const reader = defineComponent({
    name: "sessions-reader",
    setup(pikit) {
      const handle = pikit.use("sessions.store");
      return { start: () => void (sessions = handle.get()) };
    },
  });
  const app = await defineApp({ components: [...records(), reader], logger: silentLogger }).create();
  await app.start();
  if (sessions === undefined) throw new Error("sessions.store was not resolved");
  return { sessions, stop: () => app.stop() };
}

// Pi's SessionRepo suites, the fork cases Pi runs for its own repositories included.
let open: { stop(): Promise<void> } | undefined;
const repo = async () => {
  const opened = await openSessions();
  open = opened;
  return opened.sessions;
};
const closeRepo = async () => {
  await open?.stop();
};
for (const c of [...createSessionRepoConformance(repo, closeRepo), ...createSessionRepoStreamingForkConformance(repo, closeRepo)]) {
  it(`sessions-sql over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}

// Pi's Storage suite, over the storage of a session the store created.
for (const c of createStorageConformance(async () => {
  const { sessions, stop } = await openSessions();
  const session = await sessions.create({}, BACKGROUND_CONTEXT);
  return {
    storage: storageOf(session),
    [Symbol.asyncDispose]: async () => {
      await session.close(BACKGROUND_CONTEXT);
      await stop();
    },
  };
})) {
  it(`sessions-sql over storage-do storage ${c.group}: ${c.name}`, () => inObject(c));
}

// runtime-pi on those sessions: each worker is an app over the same object.
for (const c of createAgentRuntimeConformance(() =>
  createRuntimeFixture(({ onHarness }) => [createRuntimePi({ onHarness })], {
    components: records(),
    async createSession() {
      const { sessions, stop } = await openSessions();
      const session = await sessions.create({}, BACKGROUND_CONTEXT);
      await session.close(BACKGROUND_CONTEXT);
      await stop();
      return session.metadata.id;
    },
    async interrupt(sessionId, requestId) {
      // The dying worker's app is never stopped: its run stays open, driven by no one.
      const { sessions } = await openSessions();
      await interruptInProcess(sessions, sessionId, requestId);
    },
  }),
)) {
  it(`runtime-pi on sessions-sql over storage-do ${c.group}: ${c.name}`, () => inObject(c));
}
