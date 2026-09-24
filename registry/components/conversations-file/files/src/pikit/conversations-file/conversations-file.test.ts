/**
 * conversations-file's tests. They are copied with the component and keep running in your project.
 * Sessions come from Pi's in-memory repository through `@pikit/pi-adapter/testing`, shared by
 * every app of a test, so a second app over the same file and store is a restart.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type ComponentDefinition, type ConversationRegistry, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { createConversationRegistryConformance, createLifecycleConformance } from "@pikit/core/testing";
import { testComponents } from "@pikit/pi-adapter/testing";
import conversationsFile from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** A registry file in a new directory, and one session store shared by every app over it. */
function records() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-conversations-file-"));
  directories.push(dir);
  const { sessions } = testComponents();
  return { path: join(dir, "state", "conversations.json"), sessions };
}

/** The ids of the sessions in a store, read through a small app of its own. */
async function sessionIds(sessions: ComponentDefinition): Promise<string[]> {
  let ids: string[] = [];
  const probe = defineComponent({
    name: "sessions-probe",
    setup(pikit) {
      const handle = pikit.use("sessions.store");
      return {
        async start(ctx) {
          ids = (await handle.get().list(undefined, ctx)).map((metadata: { id: string }) => metadata.id);
        },
      };
    },
  });
  const app = await defineApp({ components: [sessions, probe], logger: silentLogger }).create();
  await app.start();
  await app.stop();
  return ids;
}

/** A started app over `records`, and the registry it provides. */
async function started(r: ReturnType<typeof records>): Promise<{ app: App; registry: ConversationRegistry }> {
  let registry: ConversationRegistry | undefined;
  const reader = defineComponent({
    name: "registry-reader",
    setup(pikit) {
      const handle = pikit.use("conversations.registry");
      return { start: () => void (registry = handle.get()) };
    },
  });
  const app = await defineApp({
    components: [r.sessions, conversationsFile, reader],
    config: { "conversations-file": { path: r.path } },
    logger: silentLogger,
  }).create();
  await app.start();
  if (registry === undefined) throw new Error("conversations.registry was not resolved");
  return { app, registry };
}

// The conversations.registry contract (SPEC §14), including the sessions it creates in the store.
for (const c of createConversationRegistryConformance(() => {
  const r = records();
  return {
    components: [r.sessions, conversationsFile],
    config: { "conversations-file": { path: r.path } },
    sessionIds: () => sessionIds(r.sessions),
  };
})) {
  test(`conversations-file ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline.
for (const c of createLifecycleConformance(() => {
  const r = records();
  return { component: conversationsFile, providers: [r.sessions], config: { "conversations-file": { path: r.path } } };
})) {
  test(`conversations-file ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const r = records();
  const app = await defineApp({ components: [r.sessions, conversationsFile], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "conversations-file")).toMatchObject({
    provides: ["conversations.registry"],
    requires: ["sessions.store"],
    optional: [],
  });
});

test("the file records each pointer and the sessions a conversation was in before", async () => {
  const r = records();
  const { app, registry } = await started(r);
  const ctx = app.context();
  const first = await registry.resolve("http:c1", "assistant", ctx);
  const reset = await registry.reset("http:c1", ctx);

  const file = JSON.parse(readFileSync(r.path, "utf8"));

  expect(file.version).toBe(1);
  expect(file.conversations["http:c1"]).toMatchObject({
    agent: "assistant",
    sessionId: reset?.newSessionId,
    previousSessionIds: [first.sessionId],
  });
  expect(statSync(r.path).mode & 0o777).toBe(0o600);
  await app.stop();
});

test("a key named __proto__ is a key like any other, also after a restart", async () => {
  const r = records();
  const first = await started(r);
  const created = await first.registry.resolve("__proto__", "assistant", first.app.context());
  await first.app.stop();

  const second = await started(r);

  expect(await second.registry.get("__proto__", second.app.context())).toEqual(created);
  expect(await second.registry.get("toString", second.app.context())).toBeUndefined();
  await second.app.stop();
});

test("it refuses to start over a file that is not a registry", async () => {
  for (const content of ["{ not json", JSON.stringify({ version: 2, conversations: {} }), JSON.stringify({ version: 1, conversations: { k: { agent: "a" } } })]) {
    const r = records();
    const app = await defineApp({
      components: [r.sessions, conversationsFile],
      config: { "conversations-file": { path: r.path } },
      logger: silentLogger,
    }).create();
    await Bun.write(r.path, content);

    const error = await app.start().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(((error as Error).cause as Error).message)).toContain("conversations-file:");
  }
});

test("it refuses to start where the file cannot be written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-conversations-file-"));
  directories.push(dir);
  writeFileSync(join(dir, "blocked"), "a file where the directory should be");
  const { sessions } = testComponents();
  const app = await defineApp({
    components: [sessions, conversationsFile],
    config: { "conversations-file": { path: join(dir, "blocked", "conversations.json") } },
    logger: silentLogger,
  }).create();

  const failed = await app.start().then(
    () => false,
    () => true,
  );

  expect(failed).toBe(true);
});

test("the registry is refused while the app is not running", async () => {
  const r = records();
  const { app, registry } = await started(r);
  await app.stop();

  await expect(registry.get("http:c1", app.context())).rejects.toThrow("while the app is not running");
  await expect(registry.resolve("http:c1", "assistant", app.context())).rejects.toThrow("while the app is not running");
});
