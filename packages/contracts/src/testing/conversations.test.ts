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

/** How a broken double breaks: it forgets spaces or owners, lets a later resolve replace one, or takes any owner. */
type Broken = "drops-space" | "replaces-space" | "drops-owner" | "replaces-owner" | "keeps-owner-name" | "takes-empty-owner";

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
          if (broken !== "takes-empty-owner" && place.owner !== undefined && (place.owner.channel === "" || place.owner.id === "")) throw new Error("an owner has a channel and an id");
          // Synchronous from lookup to record: concurrent first resolves cannot both create.
          let ref = records.pointers.get(key);
          if (ref === undefined) {
            const owner = place.owner === undefined || broken === "drops-owner" ? undefined : broken === "keeps-owner-name" ? { ...place.owner } : { channel: place.owner.channel, id: place.owner.id };
            ref = { key, agent, channel: place.channel, ...(broken !== "drops-space" && place.space !== undefined && { space: place.space }), ...(owner !== undefined && { owner }), conversationId: newSession() };
            records.pointers.set(key, ref);
          } else if (broken === "replaces-space" && place.space !== undefined) {
            ref = { ...ref, space: place.space };
            records.pointers.set(key, ref);
          } else if (broken === "replaces-owner" && place.owner !== undefined) {
            ref = { ...ref, owner: place.owner };
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

const CAUGHT_BY: Record<Broken, string> = {
  "drops-space": "a conversation keeps the space it was created with",
  "replaces-space": "a conversation keeps the space it was created with",
  "drops-owner": "a conversation keeps the owner it was created with",
  "replaces-owner": "a conversation keeps the owner it was created with",
  "keeps-owner-name": "a conversation keeps the owner it was created with",
  "takes-empty-owner": "an owner with an empty channel or id is refused",
};
for (const [broken, name] of Object.entries(CAUGHT_BY) as [Broken, string][]) {
  test(`a provider that ${broken} fails the case "${name}"`, async () => {
    const c = suite(broken).find((each) => each.name.startsWith(name));
    if (c === undefined) throw new Error(`the case "${name}" is missing`);
    await expect(c.run()).rejects.toThrow();
  });
}
