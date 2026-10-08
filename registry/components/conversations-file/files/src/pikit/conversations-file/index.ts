/**
 * conversations-file: the conversation registry in one JSON file (`conversations.registry`,
 * in @pikit/contracts' conversations.ts).
 *
 * It provides `conversations.registry`: which runtime conversation each conversation key is in now.
 * The first message of a conversation creates its conversation (through `agent.conversations`, which
 * the agent runtime provides) and records the pointer; a reset creates a new conversation and moves the
 * pointer, keeping the old conversation and remembering it. No pointer is ever deleted, and nothing
 * here is dropped when a conversation goes idle.
 *
 * Dependency direction: the registry uses `agent.conversations`, the runtime never uses the registry.
 * So the runtime starts first, and conversations are created only once it runs.
 *
 * The file is the record; the map in memory is its cache. Every change is written to a temporary
 * file, flushed, and renamed over the old one, so a crash leaves either the old file or the new
 * one, never half of each. The pointer is used only after it is on disk. A crash after a conversation
 * is created and before its pointer is written leaves an unused conversation behind, never a pointer
 * to a missing one.
 *
 * One process owns the file: changes run one at a time in this process, and two processes on one
 * file are not supported (one server replica).
 *
 * Target: `server` (it uses the filesystem).
 */

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type AppContext, defineComponent } from "@pikit/core";
import type { ConversationRef, ConversationRegistry, ConversationReset } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

const Config = Type.Object({
  /** The registry file, relative to the working directory. */
  path: Type.String({ minLength: 1, default: ".pikit/conversations.json" }),
});

const Pointer = Type.Object({
  agent: Type.String({ minLength: 1 }),
  conversationId: Type.String({ minLength: 1 }),
  /** Runtime conversations this key was in before, oldest first. Kept, never deleted. */
  previousConversationIds: Type.Array(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
type Pointer = Static<typeof Pointer>;

/** The file's format. */
export const VERSION = 1;

const RegistryFile = Type.Object({
  version: Type.Literal(VERSION),
  conversations: Type.Record(Type.String(), Pointer),
});

export default defineComponent({
  name: "conversations-file",
  config: Config,
  setup(pikit, config) {
    const conversations = pikit.use("agent.conversations");

    let path: string | undefined;
    /** By key. A `Map`, not an object: keys are opaque and may be `__proto__`. */
    let pointers = new Map<string, Pointer>();
    /** Changes run one at a time: a first resolve and its concurrent twin create one conversation. */
    let line: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = line.then(work);
      line = next.catch(() => {});
      return next;
    };

    const running = (): string => {
      if (path === undefined) throw new Error("conversations-file: conversations.registry used while the app is not running");
      return path;
    };
    const ref = (key: string, pointer: Pointer): ConversationRef => ({ key, agent: pointer.agent, conversationId: pointer.conversationId });

    /** A new, empty conversation in the agent runtime. */
    const newConversation = (ctx: AppContext): Promise<string> => conversations.get().create(ctx);

    /** Write `next` to disk, then make it the cache: memory never runs ahead of the file. */
    const commit = async (file: string, next: Map<string, Pointer>): Promise<void> => {
      await writeAtomically(file, serialize(next));
      pointers = next;
    };

    const registry: ConversationRegistry = {
      resolve: (key, agent, ctx) =>
        serial(async () => {
          const file = running();
          const found = pointers.get(key);
          if (found !== undefined) return ref(key, found);
          const now = ctx.clock.now();
          const pointer: Pointer = { agent, conversationId: await newConversation(ctx), previousConversationIds: [], createdAt: now, updatedAt: now };
          await commit(file, new Map(pointers).set(key, pointer));
          return ref(key, pointer);
        }),

      async get(key) {
        running();
        const found = pointers.get(key);
        return found === undefined ? undefined : ref(key, found);
      },

      async reset(key, ctx, agent) {
        const reset = await serial(async (): Promise<ConversationReset | undefined> => {
          const file = running();
          const previous = pointers.get(key);
          if (previous === undefined) return undefined;
          const pointer: Pointer = {
            ...previous,
            // Another agent only when asked: the key's own is gone (`admitInbound`).
            ...(agent !== undefined && { agent }),
            conversationId: await newConversation(ctx),
            previousConversationIds: [...previous.previousConversationIds, previous.conversationId],
            updatedAt: ctx.clock.now(),
          };
          await commit(file, new Map(pointers).set(key, pointer));
          return { conversation: ref(key, pointer), previousConversationId: previous.conversationId, newConversationId: pointer.conversationId };
        });
        // Outside the line: a listener may call the registry.
        if (reset !== undefined) await ctx.emit("conversation.reset", reset);
        return reset;
      },
    };
    pikit.provide("conversations.registry", registry);

    return {
      async start() {
        const file = resolve(config.path);
        await mkdir(dirname(file), { recursive: true });
        const loaded = await load(file);
        // A missing file is written now, so a directory that cannot hold it fails the start.
        if (loaded === undefined) await writeAtomically(file, serialize(new Map()));
        pointers = loaded ?? new Map();
        path = file;
      },
      async stop(ctx) {
        path = undefined;
        // Let a change in progress reach the disk; the stop deadline bounds the wait.
        await untilAborted(line, ctx.abortSignal);
      },
    };
  },
});

/** The pointers in `file`, or `undefined` when there is no file. A file that is not a registry fails. */
async function load(file: string): Promise<Map<string, Pointer> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`conversations-file: ${file} is not valid JSON`, { cause: error });
  }
  if (!Value.Check(RegistryFile, parsed)) {
    const [first] = Value.Errors(RegistryFile, parsed);
    throw new Error(`conversations-file: ${file} is not a conversation registry (${first?.instancePath || "/"}: ${first?.message})`);
  }
  return new Map(Object.entries(parsed.conversations));
}

function serialize(pointers: Map<string, Pointer>): string {
  // `Object.fromEntries` defines properties, so a key such as `__proto__` stays a key.
  return `${JSON.stringify({ version: VERSION, conversations: Object.fromEntries(pointers) }, null, 2)}\n`;
}

let temporaries = 0;

/** Temporary file, flush, rename: a reader sees the old file or the new one, never half of each. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${++temporaries}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // The rename lives in the directory: flush it too, where the platform allows it.
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } catch {
    // Some platforms refuse fsync on a directory; the rename is still atomic there.
  } finally {
    await directory.close();
  }
}

function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  const settled = work.then(
    () => {},
    () => {},
  );
  if (signal === undefined) return settled;
  return Promise.race([
    settled,
    new Promise<void>((done) => {
      if (signal.aborted) done();
      signal.addEventListener("abort", () => done(), { once: true });
    }),
  ]);
}
