/**
 * The `conversations.registry` suite run against an in-memory double: proof that the suite
 * asks nothing specific to one store. The double's records (pointers and a set of conversation ids)
 * live in the fixture, so a second app over them is a restart. A real project uses a component
 * such as `conversations-file`, whose records survive the process.
 */

import { expect, test } from "bun:test";
import type { ConversationRef } from "../agent.ts";
import { defineComponent } from "@pikit/core";
import type { ConversationRegistry } from "../conversations.ts";
import { createConversationRegistryConformance } from "./conversations.ts";

interface Records {
  pointers: Map<string, ConversationRef>;
  conversations: Set<string>;
}

/** How a broken double breaks: it forgets spaces, or lets a later resolve replace one. */
type Broken = "drops-space" | "replaces-space";

function memoryRegistry(records: Records, broken?: Broken) {
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
        async resolve(key, agent, place) {
          if (place.space === "") throw new Error("a space is non-empty text");
          // Synchronous from lookup to record: concurrent first resolves cannot both create.
          let ref = records.pointers.get(key);
          if (ref === undefined) {
            ref = { key, agent, channel: place.channel, ...(broken !== "drops-space" && place.space !== undefined && { space: place.space }), conversationId: newSession() };
            records.pointers.set(key, ref);
          } else if (broken === "replaces-space" && place.space !== undefined) {
            ref = { ...ref, space: place.space };
            records.pointers.set(key, ref);
          }
          return { ...ref };
        },
        async get(key) {
          const ref = records.pointers.get(key);
          return ref === undefined ? undefined : { ...ref };
        },
        async reset(key, agent, ctx) {
          const previous = records.pointers.get(key);
          if (previous === undefined) return undefined;
          const conversation = { ...previous, ...(agent !== undefined && { agent }), conversationId: newSession() };
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

const suite = (broken?: Broken) =>
  createConversationRegistryConformance(() => {
    const records: Records = { pointers: new Map(), conversations: new Set() };
    return { components: [memoryRegistry(records, broken)], conversationIds: async () => [...records.conversations] };
  });

for (const c of suite()) {
  test(`${c.group}: ${c.name}`, () => c.run());
}

const SPACE_CASE = "a conversation keeps the space it was created with";
for (const broken of ["drops-space", "replaces-space"] as const) {
  test(`a provider that ${broken === "drops-space" ? "forgets a space" : "lets a later resolve replace a space"} fails the space case`, async () => {
    const c = suite(broken).find((each) => each.name.startsWith(SPACE_CASE));
    if (c === undefined) throw new Error("the space case is missing");
    await expect(c.run()).rejects.toThrow();
  });
}
