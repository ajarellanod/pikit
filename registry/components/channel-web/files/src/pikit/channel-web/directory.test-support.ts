/**
 * Test support: `conversations.directory` as channel-web's tests have it, the contracts' in-memory double
 * (`createMemoryDirectory`, which passes the directory's conformance suite) fed as the provider's recorder
 * feeds it: from the runtime's events in each conversation's App (`agent.dispatched` with its sender,
 * `agent.started`, `agent.settled`, `agent.failed`, `conversation.reset`), the place read from
 * `conversations.registry`. The provider itself (conversations-directory) is the kit's; these tests
 * check channel-web as a view of the contract.
 *
 * One directory for a whole test: on a server the App's (`provider` and `recorder` in it), on the fake
 * Cloudflare platform the Worker's App and every object's share it (`provider` in each; `recorder` in
 * each object), as the provider's halves share its actor. A delete for everyone resets the key where
 * its conversation is: `resetIn` says how (by default the App of the last recorder made).
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { ConversationRegistry, Principal } from "@pikit/contracts";
import { createMemoryDirectory, type MemoryDirectory } from "@pikit/contracts/testing";

export interface TestDirectory {
  memory: MemoryDirectory;
  /** Provides `conversations.directory` (every App of the test). */
  provider(name?: string): ReturnType<typeof defineComponent>;
  /** Records the runtime's events of the App it is in (each App that holds conversations). */
  recorder(name?: string): ReturnType<typeof defineComponent>;
  /** Every update it recorded, by kind, in order. */
  seen: string[];
}

/**
 * A directory for one test. `resetIn(key)`: the registry that holds `key` (on the fake platform, its
 * object's); absent, the registry of the App a recorder is in (a server: the one App).
 */
export function testDirectory(resetIn?: (key: string) => Promise<ConversationRegistry>): TestDirectory {
  let registry: (() => ConversationRegistry) | undefined;
  const memory = createMemoryDirectory({
    async reset(key: string, ctx: AppContext) {
      const holder = resetIn === undefined ? registry?.() : await resetIn(key);
      if (holder === undefined) throw new Error("directory-test: no registry to reset a key in");
      await holder.reset(key, undefined, ctx);
    },
  });
  const seen: string[] = [];
  let seq = 0;
  return {
    memory,
    seen,
    provider: (name = "directory-test") => defineComponent({ name, setup: (pikit) => pikit.provide("conversations.directory", memory.directory) }),
    recorder: (name = "directory-recorder-test") =>
      defineComponent({
        name,
        setup(pikit) {
          const conversations = pikit.use("conversations.registry");
          registry = () => conversations.get();
          const place = async (key: string, fallback: { agent: string; channel?: string; space?: string; owner?: Principal }, ctx: AppContext) => {
            const recorded = (await conversations.get().get(key, ctx)) ?? fallback;
            return {
              agent: fallback.agent,
              channel: recorded.channel ?? "",
              ...(recorded.space !== undefined && { space: recorded.space }),
              ...(recorded.owner !== undefined && { owner: { channel: recorded.owner.channel, id: recorded.owner.id } }),
            };
          };
          pikit.on("agent.dispatched", async ({ conversation, admission, sender }, ctx) => {
            seen.push("dispatched");
            const at = place(conversation.key, conversation, ctx);
            memory.seen({
              kind: "dispatched",
              ref: { key: conversation.key, conversationId: conversation.conversationId, ...(await at) },
              requestId: admission.requestId,
              ...(sender !== undefined && { sender }),
              duplicate: admission.kind === "duplicate",
              at: ctx.clock.now(),
              seq: ++seq,
            });
          });
          pikit.on("agent.started", ({ conversation, requestId }, ctx) => {
            seen.push("started");
            memory.seen({ kind: "started", ref: { key: conversation.key, conversationId: conversation.conversationId }, requestId, at: ctx.clock.now(), seq: ++seq });
          });
          const ended = ({ conversation, requestId, requestIds }: { conversation: { key: string; conversationId: string }; requestId: string; requestIds: readonly string[] }, ctx: AppContext) => {
            seen.push("settled");
            memory.seen({ kind: "settled", ref: { key: conversation.key, conversationId: conversation.conversationId }, requestId, requestIds, at: ctx.clock.now(), seq: ++seq });
          };
          pikit.on("agent.settled", ended);
          pikit.on("agent.failed", ended);
          pikit.on("conversation.reset", async ({ conversation, previousConversationId }, ctx) => {
            seen.push("reset");
            memory.seen({
              kind: "reset",
              previous: { key: conversation.key, conversationId: previousConversationId },
              ref: { key: conversation.key, conversationId: conversation.conversationId, ...(await place(conversation.key, conversation, ctx)) },
              at: ctx.clock.now(),
              seq: ++seq,
            });
          });
        },
      }),
  };
}
