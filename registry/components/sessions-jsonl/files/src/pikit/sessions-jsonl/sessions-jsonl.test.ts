/**
 * sessions-jsonl's tests. They are copied with the component and keep running in your project.
 * Pi's own session suites run over the store this component provides (SPEC §7.5, §14), through
 * `@pikit/pi-adapter/testing`, so they never import Pi.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import type { SessionStore } from "@pikit/pi-adapter";
import { createSessionRepoConformance, createStorageConformance, JSONL_REPO_CONFORMANCE_GAPS, storageOf } from "@pikit/pi-adapter/testing";
import sessionsJsonl from "./index.ts";

/** A started app with this component over `root`, and the store it provides. */
async function started(root: string): Promise<{ app: App; sessions: SessionStore }> {
  let sessions: SessionStore | undefined;
  const reader = defineComponent({
    name: "sessions-reader",
    setup(pikit) {
      const handle = pikit.use("sessions.store");
      return { start: () => void (sessions = handle.get()) };
    },
  });
  const app = await defineApp({
    components: [sessionsJsonl, reader],
    config: { "sessions-jsonl": { root } },
    logger: silentLogger,
  }).create();
  await app.start();
  if (sessions === undefined) throw new Error("sessions.store was not resolved");
  return { app, sessions };
}

function temporaryRoot(): { root: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pikit-sessions-jsonl-"));
  return { root: join(dir, "sessions"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

// Pi's SessionRepo suite. One case is a known gap of Pi's JSONL repository on this Pi version
// (`JSONL_REPO_CONFORMANCE_GAPS`); it is expected to fail, and passing is a signal to remove it.
let current: { app: App; remove(): void } | undefined;
for (const c of createSessionRepoConformance(
  async () => {
    const { root, remove } = temporaryRoot();
    const { app, sessions } = await started(root);
    current = { app, remove };
    return sessions;
  },
  async () => {
    await current?.app.stop();
    current?.remove();
  },
)) {
  (JSONL_REPO_CONFORMANCE_GAPS.includes(c.name) ? test.failing : test)(`sessions-jsonl ${c.group}: ${c.name}`, () => c.run());
}

// Pi's Storage suite, over the storage of a session this store created.
for (const c of createStorageConformance(async () => {
  const { root, remove } = temporaryRoot();
  const { app, sessions } = await started(root);
  const session = await sessions.create({}, app.context());
  return {
    storage: storageOf(session),
    [Symbol.asyncDispose]: async () => {
      await session.close(app.context());
      await app.stop();
      remove();
    },
  };
})) {
  test(`sessions-jsonl storage ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline.
const lifecycleRoot = temporaryRoot();
afterAll(() => lifecycleRoot.remove());
for (const c of createLifecycleConformance(() => ({ component: sessionsJsonl, config: { "sessions-jsonl": { root: lifecycleRoot.root } } }))) {
  test(`sessions-jsonl ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [sessionsJsonl], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "sessions-jsonl", provides: ["sessions.store"], requires: [], optional: [] }]);
});

test("a session outlives the process: a new app over the same root opens it", async () => {
  const { root, remove } = temporaryRoot();
  const first = await started(root);
  const created = await first.sessions.create({}, first.app.context());
  await created.setName("remembered", first.app.context());
  await created.close(first.app.context());
  await first.app.stop();

  const second = await started(root);
  const ctx = second.app.context();
  const [metadata] = await second.sessions.list(undefined, ctx);
  const reopened = await second.sessions.open(metadata, ctx);

  expect(metadata.id).toBe(created.metadata.id);
  expect(await reopened.getName(ctx)).toBe("remembered");
  expect(metadata.cwd).toBe(process.cwd());
  await reopened.close(ctx);
  await second.app.stop();
  remove();
});

test("it refuses to start when its root cannot hold files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-sessions-jsonl-"));
  const root = join(dir, "not-a-directory");
  writeFileSync(root, "a file where the sessions directory should be");
  const app = await defineApp({
    components: [sessionsJsonl],
    config: { "sessions-jsonl": { root } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain('"sessions-jsonl" failed to start');
  rmSync(dir, { recursive: true, force: true });
});

test("the store is refused while the app is not running", async () => {
  const { root, remove } = temporaryRoot();
  const { app, sessions } = await started(root);
  await app.stop();

  expect(() => sessions.list(undefined, app.context())).toThrow("while the app is not running");
  remove();
});
