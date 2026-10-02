/**
 * The `conversations.registry` suite run against an in-memory double: proof that the suite
 * asks nothing specific to one store. The double's records (pointers and a set of conversation ids)
 * live in the fixture, so a second app over them is a restart. A real project uses a component
 * such as `conversations-file`, whose records survive the process.
 */

import { test } from "bun:test";
import type { ConversationRef } from "../agent.ts";
import { defineComponent } from "@pikit/core";
import type { ConversationRegistry } from "../conversations.ts";
import { createConversationRegistryConformance } from "./conversations.ts";

interface Records {
  pointers: Map<string, ConversationRef>;
  conversations: Set<string>;
}

function memoryRegistry(records: Records) {
  return defineComponent({
    name: "conversations-memory",
    setup(pikit) {
      let next = records.conversations.size;
      const newSession = (): string => {
        const id = `s${++next}`;
        records.conversations.add(id);
        return id;
      };
      const registry: ConversationRegistry = {
        async resolve(key, agent) {
          // Synchronous from lookup to record: concurrent first resolves cannot both create.
          let ref = records.pointers.get(key);
          if (ref === undefined) {
            ref = { key, agent, conversationId: newSession() };
            records.pointers.set(key, ref);
          }
          return { ...ref };
        },
        async get(key) {
          const ref = records.pointers.get(key);
          return ref === undefined ? undefined : { ...ref };
        },
        async reset(key, ctx) {
          const previous = records.pointers.get(key);
          if (previous === undefined) return undefined;
          const conversation = { ...previous, conversationId: newSession() };
          records.pointers.set(key, conversation);
          const reset = { conversation: { ...conversation }, previousConversationId: previous.conversationId, newConversationId: conversation.conversationId };
          await ctx.emit("conversation.reset", reset);
          return reset;
        },
      };
      pikit.provide("conversations.registry", registry);
    },
  });
}

for (const c of createConversationRegistryConformance(() => {
  const records: Records = { pointers: new Map(), conversations: new Set() };
  return { components: [memoryRegistry(records)], conversationIds: async () => [...records.conversations] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
