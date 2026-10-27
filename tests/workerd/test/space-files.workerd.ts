/**
 * tool-space-files on Cloudflare: two conversations of one space, each in its own Durable Object
 * (deployment-cloudflare's `Conversation` class, as `PlatformConversation`, `src/platform.ts`) with its
 * own workspace (execution-do, in its object's SQLite), share a file through the space's index actor,
 * the object `space-files:<space>`, reached through actors-do's `actor.mailbox` by RPC. The bytes are in
 * the component's in-memory `storage.blob` double, one for every object (they share one isolate here;
 * on Cloudflare a bucket, storage-blob-s3, is what every object reaches).
 *
 * - The model of the first conversation writes a file and calls `files_save`: the index lands in the
 *   space's object, not the conversation's.
 * - The second conversation's next request carries the file in its `space-files` section; its model
 *   calls `files_get` and reads the file back from its own workspace.
 * - A conversation of another space has no section and gets nothing; the space's object refuses a call
 *   for another space (`invalid`).
 */

import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { ActorCallError, type ActorMailbox, defineAgent } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";
import { afterEach, expect, it, vi } from "vitest";
import actorsDo from "../../../registry/components/actors-do/files/src/pikit/actors-do/index.ts";
import conversationsKv from "../../../registry/components/conversations-kv/files/src/pikit/conversations-kv/index.ts";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import providerFaux from "../../../registry/components/provider-faux/files/src/pikit/provider-faux/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import storageKvSql from "../../../registry/components/storage-kv-sql/files/src/pikit/storage-kv-sql/index.ts";
import toolRead from "../../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import toolSpaceFiles from "../../../registry/components/tool-space-files/files/src/pikit/tool-space-files/index.ts";
import { createMemoryBlobStorage, memoryBlob } from "../../../registry/components/tool-space-files/files/src/pikit/tool-space-files/memory-blob.test-support.ts";
import { actorKey, CALL, type ListedFile } from "../../../registry/components/tool-space-files/files/src/pikit/tool-space-files/space.ts";
import toolWrite from "../../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";
import { composeObjects, PLATFORM_BINDING } from "../src/platform.ts";
import { resetObjects, workerEnv } from "./host.ts";

const ACTORS = { "actors-do": { binding: PLATFORM_BINDING } };

afterEach(() => resetObjects());

/** A channel's object half: each message to its key's conversation of `assistant`, in the space the message names; answers pushed to `answers`. */
function channelActor(answers: string[]) {
  return defineComponent({
    name: "test-channel-actor",
    setup(pikit) {
      const inbox = pikit.use("actor.inbox");
      const registry = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      pikit.on("agent.settled", (result) => void answers.push(`${result.conversation.key}: ${result.text}`));
      return {
        start() {
          inbox.get().handle("test.message", async (key, message, ctx) => {
            const { id, text, space } = message as { id: string; text: string; space: string };
            const conversation = await registry.get().resolve(key, "assistant", { channel: "test", space }, ctx);
            await runtime.get().dispatch({ requestId: id, conversation, prompt: text }, ctx);
          });
        },
      };
    },
  });
}

/** The Worker's App: a mailbox to the objects. */
async function workerApp() {
  let mailbox: ActorMailbox | undefined;
  const probe = defineComponent({
    name: "test-mailbox",
    setup(pikit) {
      const handle = pikit.use("actor.mailbox");
      return { start: () => void (mailbox = handle.get()) };
    },
  });
  const app = await defineApp({ components: [actorsDo, probe], config: ACTORS, target: "durable", logger: silentLogger }).create();
  await app.start(withContextValue(WORKERS_HOST, { env: workerEnv }, BACKGROUND_CONTEXT));
  const live = () => mailbox as ActorMailbox;
  return {
    app,
    send: (key: string, message: { id: string; text: string; space: string }) => live().send(key, "test.message", message, app.context()),
    call: (key: string, type: string, message: Parameters<ActorMailbox["call"]>[2]) => live().call(key, type, message, app.context()),
  };
}

it("two conversations of a space, each in its own object, share a file through the space's object; another space sees none", async () => {
  const answers: string[] = [];
  const agent = defineAgent({ name: "assistant", model: "faux/scripted", tools: ["write", "read"], extensions: ["space-files"] });
  const agents = defineComponent({ name: "agents-fixture", setup: (pikit) => pikit.provideKeyed("agent.definition", agent.name, agent) });
  const blobs = createMemoryBlobStorage();
  composeObjects(
    [storageDo, storageKvSql, actorsDo, agents, providerFaux, runtimePi, conversationsKv, executionDo, toolWrite, toolRead, memoryBlob(blobs), toolSpaceFiles, channelActor(answers)],
    ACTORS,
  );
  const worker = await workerApp();
  const space = `gchat:spaces/${crypto.randomUUID()}`;
  const thread1 = `${space}/threads/1`;
  const thread2 = `${space}/threads/2`;
  const elsewhere = `gchat:spaces/${crypto.randomUUID()}/threads/1`;
  const answered = (key: string, prefix: string) =>
    vi.waitFor(() => {
      const found = answers.find((a) => a.startsWith(`${key}: ${prefix}`));
      expect(found).toBeDefined();
      return found as string;
    }, { timeout: 15_000 });
  try {
    // The first thread writes a file in its workspace and saves it to the space.
    await worker.send(thread1, { id: "m1", text: 'call: write {"path":"notes.md","content":"Ship on Friday.\\n"}', space });
    await answered(thread1, "write: ");
    await worker.send(thread1, { id: "m2", text: 'call: files_save {"path":"notes.md","description":"Release notes"}', space });
    expect(await answered(thread1, "files_save")).toBe(
      `${thread1}: files_save: Saved notes.md (version 1, 16 B) in this space's files: every conversation and agent of the space can get it with files_get.`,
    );

    // The index is in the space's object.
    const listed = (await worker.call(actorKey(space), CALL.list, { space, limit: 10 })) as { files: ListedFile[] };
    expect(listed.files.map((f) => [f.name, f.size, f.agent])).toEqual([["notes.md", 16, "assistant"]]);
    expect([...(blobs.data.get("tool-space-files")?.keys() ?? [])]).toHaveLength(1);

    // The second thread, in an object of its own, sees it in its section and gets it into its own workspace.
    await worker.send(thread2, { id: "m1", text: "echo-system space-files", space });
    expect(await answered(thread2, "<space-files>")).toContain("- notes.md (16 B): Release notes");
    await worker.send(thread2, { id: "m2", text: 'call: read {"path":"notes.md"}', space });
    expect(await answered(thread2, "read")).toContain(`${thread2}: read failed: `);
    await worker.send(thread2, { id: "m3", text: 'call: files_get {"name":"notes.md"}', space });
    expect(await answered(thread2, "files_get")).toBe(`${thread2}: files_get: Wrote notes.md (version 1, 16 B) to notes.md in your workspace.`);
    await worker.send(thread2, { id: "m4", text: 'call: read {"path":"notes.md"}', space });
    expect(await answered(thread2, "read: ")).toBe(`${thread2}: read: Ship on Friday.\n`);

    // Another space: no section, nothing to get; the space's object answers only for its space.
    const other = elsewhere.slice(0, -"/threads/1".length);
    await worker.send(elsewhere, { id: "m1", text: "echo-system space-files", space: other });
    expect(await answered(elsewhere, "(no section")).toBe(`${elsewhere}: (no section space-files)`);
    await worker.send(elsewhere, { id: "m2", text: 'call: files_get {"name":"notes.md"}', space: other });
    expect(await answered(elsewhere, "files_get failed: ")).toContain("no file named notes.md is saved in this space");
    const refused = await worker.call(actorKey(space), CALL.list, { space: other, limit: 10 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActorCallError);
    expect((refused as ActorCallError).code).toBe("invalid");
  } finally {
    await worker.app.stop();
  }
});
