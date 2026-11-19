/**
 * The conversation directory of admin-api's tests: the contracts' `createMemoryDirectory` with a
 * recorder of the runtime's events (what conversations-directory does), shared by every App a test
 * makes (a server's, the Worker's and each object's; the workerd lane's real objects too). No Bun or
 * Node global: the workerd lane imports it.
 */

import { type AppContext, type ComponentDefinition, defineComponent } from "@pikit/core";
import { channelKindOf, type ConversationRef, type EntryRef } from "@pikit/contracts";
import { createMemoryDirectory, type MemoryDirectory } from "@pikit/contracts/testing";

/**
 * The conversation directory a test's Apps share: `createMemoryDirectory`, recorded from the runtime's
 * events in each App that has `component()` (each at its clock, kept increasing). `reset` resets a key
 * where its conversation is (a delete for everyone of a key's current one).
 */
export class Directory {
  readonly memory: MemoryDirectory;
  private seq = 0;
  private last = 0;

  constructor(reset: (key: string, ctx: AppContext) => Promise<void>) {
    this.memory = createMemoryDirectory({ reset });
  }

  private next(ctx?: AppContext): { at: number; seq: number } {
    this.last = Math.max(this.last + 1, ctx?.clock.now() ?? Date.now());
    return { at: this.last, seq: ++this.seq };
  }

  /** A message dispatched to `ref` (of `agent`, on its key's channel), as the recorder records it; `at` given, the time of the activity. */
  dispatched(ref: EntryRef & { agent: string; channel?: string; owner?: { channel: string; id: string } }, requestId: string, options: { at?: number; sender?: { channel: string; id: string }; duplicate?: boolean } = {}): void {
    const { seq, at } = this.next();
    const place = { agent: ref.agent, channel: ref.channel ?? channelKindOf(ref.key) ?? "unknown", ...(ref.owner !== undefined && { owner: ref.owner }) };
    this.memory.seen({
      kind: "dispatched",
      ref: { key: ref.key, conversationId: ref.conversationId, ...place },
      requestId,
      ...(options.sender !== undefined && { sender: options.sender }),
      duplicate: options.duplicate === true,
      at: options.at ?? at,
      seq,
    });
  }

  /** The directory, and its recorder of this App's runtime events. */
  component(): ComponentDefinition {
    const directory = this;
    return defineComponent({
      name: "directory-test",
      setup(pikit) {
        const registry = pikit.useOptional("conversations.registry");
        pikit.provide("conversations.directory", directory.memory.directory);
        const placeOf = async (conversation: ConversationRef, ctx: AppContext) => {
          const recorded = await registry.get()?.get(conversation.key, ctx);
          const owner = recorded?.owner ?? conversation.owner;
          return { agent: conversation.agent, channel: recorded?.channel ?? conversation.channel ?? channelKindOf(conversation.key) ?? "unknown", ...(owner !== undefined && { owner }) };
        };
        const ref = (conversation: ConversationRef): EntryRef => ({ key: conversation.key, conversationId: conversation.conversationId });
        pikit.on("agent.dispatched", async ({ conversation, admission, sender }, ctx) => {
          const place = await placeOf(conversation, ctx);
          directory.memory.seen({ kind: "dispatched", ref: { ...ref(conversation), ...place }, requestId: admission.requestId, ...(sender !== undefined && { sender }), duplicate: admission.kind === "duplicate", ...directory.next(ctx) });
        });
        pikit.on("agent.started", ({ conversation, requestId }, ctx) => directory.memory.seen({ kind: "started", ref: ref(conversation), requestId, ...directory.next(ctx) }));
        const ended = ({ conversation, requestId, requestIds }: { conversation: ConversationRef; requestId: string; requestIds: readonly string[] }, ctx: AppContext) =>
          directory.memory.seen({ kind: "settled", ref: ref(conversation), requestId, requestIds, ...directory.next(ctx) });
        pikit.on("agent.settled", ended);
        pikit.on("agent.failed", ended);
        pikit.on("conversation.reset", async ({ conversation, previousConversationId }, ctx) => {
          const place = await placeOf(conversation, ctx);
          directory.memory.seen({ kind: "reset", previous: { key: conversation.key, conversationId: previousConversationId }, ref: { ...ref(conversation), ...place }, ...directory.next(ctx) });
        });
      },
    });
  }
}
