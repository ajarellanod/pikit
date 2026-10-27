/**
 * `memory`: what the agents of a space remember, and what each person prefers (features/memory.md).
 * Declared by memory-sql; every component that uses it carries an identical copy of this file (a
 * component never imports another's files; copies that differ fail `tsc`).
 *
 * Whose memory is an owner (`MemoryOwner`): a space's (every agent working in that space shares it), an
 * agent's own across all its spaces (for the agents the provider keeps apart), or a person's (their
 * preferences, wherever they write). `ownerOf` maps a conversation to its space's or agent's: the one
 * place that policy is decided, so every component asks it and none decides again.
 *
 * What every provider guarantees:
 * - **Per owner.** A memory is one owner's: nothing is listed, got, searched, approved or forgotten
 *   across another owner, even under the same id.
 * - **Kinds by owner.** A space or an agent keeps `fact`, `summary` and `rule`; a person keeps
 *   `preference`. A fact or a summary is always `active`; a rule or a preference is `active` or
 *   `pending` (proposed, waiting for a person). Anything else is refused.
 * - **`remember` is idempotent by `id`.** A memory already kept under its id (in its owner) stays as it
 *   is, text and status: a replayed tool call, a retried summary or a command run twice keeps it once,
 *   and a proposal never demotes an active rule of the same id.
 * - **A memory never holds a known credential** (`sk-...`, a GitHub token, a bot token, a JWT, a private
 *   key, a URL with a password: `credentialSettingProblem`'s shapes, whole or as a word), nor an empty
 *   text, nor one past `MEMORY_TEXT_MAX`: `remember` rejects, keeps nothing, and its error never echoes
 *   the text.
 * - **Search is full-text** over the owner's facts and summaries: words, any case, ranked best first; a
 *   query of any text (an email, a URL, quotes, a hyphenated id) is never a syntax error.
 * - **It survives a restart**: every change is committed before its call resolves.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";

/**
 * Whose memory. A type, not an interface: it crosses `actor.mailbox` as JSON.
 * - `space`: a space's (`spaceOf(conversation)`), shared by every agent working there;
 * - `agent`: one agent's own, across every space it works in;
 * - `person`: one person's preferences, as a channel identifies them (a request's `Sender`).
 */
export type MemoryOwner = { type: "space"; space: string } | { type: "agent"; agent: string } | { type: "person"; channel: string; id: string };

/**
 * What a memory is. Facts (an agent's `remember`) and summaries (of a quiet conversation) are data;
 * rules (of a space, or of an agent kept apart) and preferences (a person's) are instructions, once a
 * person made them active.
 */
export type MemoryKind = "fact" | "summary" | "rule" | "preference";

/** A rule or preference an agent proposed is `pending` until a person approves it; everything else is `active`. */
export type MemoryStatus = "active" | "pending";

/** One thing kept. */
export type Memory = {
  /** Its identity and idempotency key: `${conversationId}:${callId}` when a tool call wrote it. */
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  text: string;
  /** Epoch ms, from the App's clock. */
  createdAt: number;
};

/** What `search` finds: a memory, and the words around what matched (the matched words in `[` `]`). */
export type MemoryMatch = Memory & { snippet: string };

/** Which memories `list` and `forget` apply to: of one of `kinds`, and of `status` when given. */
export type MemoryFilter = { kinds: readonly MemoryKind[]; status?: MemoryStatus };

/** The longest text a memory holds, in characters. */
export const MEMORY_TEXT_MAX = 4_000;
/** The longest id, and the longest part of an owner, in characters. */
export const MEMORY_ID_MAX = 256;
/** The most memories one `list` or `search` answers. */
export const MEMORY_LIST_MAX = 200;

export interface MemoryStore {
  /**
   * The owner of `conversation`'s shared memory: its space's (`spaceOf`: a delegated conversation is in
   * its origin's space), or its agent's own for an agent the provider keeps apart (its config). The
   * same conversation always has the same owner. Never a person: a person's owner is their `Sender`.
   */
  ownerOf(conversation: ConversationRef): MemoryOwner;
  /** The newest `limit` memories of `owner` that `filter` takes, oldest first: a stable order. */
  list(owner: MemoryOwner, filter: MemoryFilter, limit: number, ctx: AppContext): Promise<Memory[]>;
  /** The memory `id` of `owner`, or `undefined`. */
  get(owner: MemoryOwner, id: string, ctx: AppContext): Promise<Memory | undefined>;
  /** Keeps `memory`; one already kept under its `id` stays as it is, text and status (idempotent). */
  remember(owner: MemoryOwner, memory: Memory, ctx: AppContext): Promise<void>;
  /**
   * Makes `owner`'s memory `id` of `kind` active, when it is pending. `true` when `owner` has an active
   * memory of `kind` under `id` now (one already active included: approving twice is approving once),
   * `false` when it has none of that kind.
   */
  approve(owner: MemoryOwner, id: string, kind: MemoryKind, ctx: AppContext): Promise<boolean>;
  /** Removes `owner`'s memory `id` when `filter` takes it; `true` when one was removed (an unknown id is `false`, not an error). */
  forget(owner: MemoryOwner, id: string, filter: MemoryFilter, ctx: AppContext): Promise<boolean>;
  /**
   * `owner`'s facts and summaries that match `query`'s words (all of them, else the phrase, else any of
   * them), any case, the best `limit` first (the newest first among equals), each with a snippet. A
   * query with no word finds nothing.
   */
  search(owner: MemoryOwner, query: string, limit: number, ctx: AppContext): Promise<MemoryMatch[]>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    memory: MemoryStore;
  }
}
