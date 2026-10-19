/**
 * `memory`: what an agent remembers of a person, across that person's conversations
 * (features/memory.md). Declared by memory-sql; every component that uses it carries an identical
 * copy of this file (a component never imports another's files; copies that differ fail `tsc`).
 *
 * What every provider guarantees:
 * - **Per agent and person.** A memory is one agent's of one person: nothing is listed, searched or
 *   forgotten across another agent or person.
 * - **`remember` is idempotent by `id`.** A memory already kept under its id (in its scope) stays as it
 *   is: a replayed tool call or a retried summary keeps it once.
 * - **A memory never holds a known credential** (`sk-…`, a GitHub token, a bot token, a JWT, a private
 *   key, a URL with a password: `credentialSettingProblem`'s shapes, whole or as a word), nor an empty
 *   text, nor one past `MEMORY_TEXT_MAX`: `remember` rejects, keeps nothing, and its error never echoes
 *   the text.
 * - **It survives a restart**: every memory is committed before `remember` resolves.
 */

import type { AppContext } from "@pikit/core";

/** Whose memory: one agent's memory of one person. */
export type MemoryScope = { agent: string; person: string };

/** A fact the agent chose to keep, or a summary of one of its conversations with the person. */
export type MemoryKind = "fact" | "summary";

/** One thing kept. A type, not an interface: it crosses `actor.mailbox` as JSON. */
export type Memory = {
  /** Its identity and idempotency key: `${conversationId}:${callId}` when a tool call wrote it. */
  id: string;
  kind: MemoryKind;
  text: string;
  /** Epoch ms, from the App's clock. */
  createdAt: number;
};

/** The longest text a memory holds, in characters. */
export const MEMORY_TEXT_MAX = 4_000;
/** The longest id, in characters. */
export const MEMORY_ID_MAX = 256;
/** The most memories one `list` or `search` answers. */
export const MEMORY_LIST_MAX = 200;

export interface MemoryStore {
  /** The newest `limit` memories of `kind` in `scope`, oldest first: a stable order. */
  list(scope: MemoryScope, kind: MemoryKind, limit: number, ctx: AppContext): Promise<Memory[]>;
  /** Keeps `memory`; one already kept under its `id` stays as it is (idempotent). */
  remember(scope: MemoryScope, memory: Memory, ctx: AppContext): Promise<void>;
  /** Removes the memory `id` of `scope`; an unknown id is not an error. */
  forget(scope: MemoryScope, id: string, ctx: AppContext): Promise<void>;
  /** Memories of `scope` (both kinds) whose text contains `query` (ASCII case ignored), newest first. */
  search(scope: MemoryScope, query: string, limit: number, ctx: AppContext): Promise<Memory[]>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    memory: MemoryStore;
  }
}
