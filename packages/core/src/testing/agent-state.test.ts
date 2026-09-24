/**
 * The `agent.state` suite run against an in-memory double (S12): proof that the suite asks nothing
 * specific to Pi. The real state lives in the conversation's Pi session (`@pikit/pi-adapter`).
 */

import { test } from "bun:test";
import { type AgentState, isJsonObject } from "../contracts/agent-state.ts";
import { createAgentStateConformance } from "./agent-state.ts";

/** A session's stored values: what survives a worker, and what a reset replaces. */
type Store = { value?: Record<string, unknown> };

function memoryState(store: Store, initial: Record<string, unknown>): AgentState {
  let line: Promise<unknown> = Promise.resolve();
  const read = () => structuredClone({ ...initial, ...store.value });
  return {
    get: async () => read(),
    update(patch) {
      if (!isJsonObject(patch)) return Promise.reject(new TypeError("agent.state: a patch must be a JSON object"));
      const copy = structuredClone(patch);
      const next = line.then(() => {
        store.value = { ...read(), ...copy };
        return read();
      });
      line = next.catch(() => {});
      return next;
    },
  };
}

for (const c of createAgentStateConformance(() => {
  let store: Store = {};
  let initial: Record<string, unknown> = {};
  return {
    async open(declared) {
      initial = declared;
      return memoryState(store, initial);
    },
    reopen: async () => memoryState(store, initial),
    async reset() {
      store = {};
      return memoryState(store, initial);
    },
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
