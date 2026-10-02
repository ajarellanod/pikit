/**
 * conversations-kv over the real `storage.kv` of this registry: storage-kv-sql on a SQLite file.
 *
 * A repository test, not copied with the component: a component's files never import another
 * component's (SPEC P4), so this one lives beside `files/`. The copied tests use the memory `storage.kv`
 * from `@pikit/contracts/testing`; this one checks the same contract where the values are rows and
 * two processes share a database. Conversations come from Pi's in-memory repository through
 * `@pikit/pi-adapter/testing`.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import type { ConversationRegistry } from "@pikit/contracts";
import { createConversationRegistryConformance } from "@pikit/contracts/testing";
import { fakeConversations } from "@pikit/pi-adapter/testing";
import storageKvSql from "../storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import { testStorage } from "../storage-kv-sql/files/src/pikit/storage-kv-sql/storage.test-support.ts";
import conversationsKv from "./files/src/pikit/conversations-kv/index.ts";

const directories: string[] = [];
const apps: App[] = [];
afterAll(async () => {
  for (const app of apps) await app.stop().catch(() => {});
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-conversations-kv-"));
  directories.push(dir);
  return join(dir, "pikit.db");
}

for (const c of createConversationRegistryConformance(() => {
  const database = temporaryDatabase();
  const fake = fakeConversations();
  const conversations = fake.component;
  return { components: [testStorage(database), storageKvSql, conversations, conversationsKv], conversationIds: async () => [...fake.ids] };
})) {
  test(`conversations-kv on storage-kv-sql ${c.group}: ${c.name}`, () => c.run());
}

test("two processes over one database racing a first resolve get one conversation", async () => {
  const database = temporaryDatabase();
  const fake = fakeConversations();
  const conversations = fake.component;
  const open = async (): Promise<{ registry: ConversationRegistry; app: App }> => {
    let registry: ConversationRegistry | undefined;
    const reader = defineComponent({
      name: "registry-reader",
      setup(pikit) {
        const handle = pikit.use("conversations.registry");
        return { start: () => void (registry = handle.get()) };
      },
    });
    const app = await defineApp({ components: [testStorage(database), storageKvSql, conversations, conversationsKv, reader], logger: silentLogger }).create();
    apps.push(app);
    await app.start();
    if (registry === undefined) throw new Error("conversations.registry was not resolved");
    return { registry, app };
  };
  const a = await open();
  const b = await open();

  const refs = await Promise.all(
    Array.from({ length: 6 }, (_, i) => {
      const w = i % 2 === 0 ? a : b;
      return w.registry.resolve("http:c1", "assistant", w.app.context());
    }),
  );

  expect(new Set(refs.map((ref) => ref.conversationId)).size).toBe(1);
  // One conversation per process at most: the loser's is left unused, as the README says.
  expect((await [...fake.ids]).length).toBeLessThanOrEqual(2);
});
