/**
 * The `conversations.registry` suite run against an in-memory double (S12): proof that the suite
 * asks nothing specific to one store. The double's records (pointers and a set of session ids)
 * live in the fixture, so a second app over them is a restart. A real project uses a component
 * such as `conversations-file`, whose records survive the process.
 */

import { test } from "bun:test";
import type { ConversationRef } from "../agent.ts";
import { defineComponent } from "../app.ts";
import type { ConversationRegistry } from "../contracts/conversations.ts";
import { createConversationRegistryConformance } from "./conversations.ts";

interface Records {
  pointers: Map<string, ConversationRef>;
  sessions: Set<string>;
}

function memoryRegistry(records: Records) {
  return defineComponent({
    name: "conversations-memory",
    setup(pikit) {
      let next = records.sessions.size;
      const newSession = (): string => {
        const id = `s${++next}`;
        records.sessions.add(id);
        return id;
      };
      const registry: ConversationRegistry = {
        async resolve(key, agent) {
          // Synchronous from lookup to record: concurrent first resolves cannot both create.
          let ref = records.pointers.get(key);
          if (ref === undefined) {
            ref = { key, agent, sessionId: newSession() };
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
          const conversation = { ...previous, sessionId: newSession() };
          records.pointers.set(key, conversation);
          const reset = { conversation: { ...conversation }, previousSessionId: previous.sessionId, newSessionId: conversation.sessionId };
          await ctx.emit("conversation.reset", reset);
          return reset;
        },
      };
      pikit.provide("conversations.registry", registry);
    },
  });
}

for (const c of createConversationRegistryConformance(() => {
  const records: Records = { pointers: new Map(), sessions: new Set() };
  return { components: [memoryRegistry(records)], sessionIds: async () => [...records.sessions] };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
