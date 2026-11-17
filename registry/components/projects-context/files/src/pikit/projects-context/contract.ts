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
 * - **Who and from where** (features/projects.md): every write names its author (`Author`, from
 *   `@pikit/contracts`: the agent, its conversation and the person it answered for a tool; the person
 *   for a command; the component for memory-summaries; the operator for a dashboard route), set by the
 *   calling component from what it authenticated, never by a model. A memory keeps its author (`by`;
 *   absent on rows kept before authors were recorded) and `updatedAt`.
 * - **A change log per owner** (`Change`, `../change.ts` of `@pikit/contracts`; item kinds `rule`,
 *   `note` (a fact), `summary`, `preference`; id the memory's id, title its first words): every
 *   `remember` that keeps something new, `approve` that activates, `forget` that removes, `replace`
 *   and `restore`, in the same transaction as the change; a repeat that changes
 *   nothing appends nothing. `changeLogCases` holds for it. `restore(n)` brings back the state before
 *   `n` (a forgotten memory back under its id, with its words, status and original author; a replaced
 *   one's old words back and the new removed), as a `restored` entry by the restorer. `redact(n)` is an
 *   operator's only (`forbidden` for any other author). `purge(owner)` deletes an owner's memories and
 *   log for good (a removed project's space).
 * - **Policy-free**: whether a rule is kept `active` or `pending` is the caller's (memory-recall's)
 *   choice: in a project's space every rule is active at once, elsewhere an agent's waits.
 * - **A rule or preference is named by its words** (`memoryItemId`, over `memoryWords`): the same words,
 *   in any case and spacing, are one rule wherever they are added (memory-recall's tools and `/rules`, a
 *   project's page), so adding them again keeps one. Every user names them so; the store does not check.
 *
 * Rejections carry a `code` (memory-sql's are `ActorCallError`s): `invalid` (malformed, a credential's
 * shape, an author that `parseAuthor` refuses), `forbidden` (a redaction by anyone but an operator),
 * `gone` (a restore past retention or redacted), `not_found` (a restore of no such change).
 */

import type { AppContext } from "@pikit/core";
import type { Author, Change, ChangePage, ChangePageRequest, ConversationRef } from "@pikit/contracts";

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
  /** When its words or status last changed (epoch ms); absent: never since `createdAt`. */
  updatedAt?: number;
  /** Who kept it (its first author: a restore keeps it); absent on rows kept before authors were recorded. */
  by?: Author;
};

/** What `remember` and `replace` are given: a memory with its author, always. */
export type NewMemory = Omit<Memory, "updatedAt" | "by"> & { by: Author };

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
/** What `search` looks in when no filter is given: the owner's facts and summaries. */
export const MEMORY_SEARCH_DEFAULT: MemoryFilter = { kinds: ["fact", "summary"] };
/** The change log's item kind of each memory kind. */
export const MEMORY_CHANGE_KIND: Readonly<Record<MemoryKind, string>> = { fact: "note", summary: "summary", rule: "rule", preference: "preference" };

/** A rule's or preference's words as kept: trimmed, its spaces folded. */
export const memoryWords = (text: string): string => text.trim().replace(/\s+/g, " ");

/** The id of a rule (`r-`) or preference (`p-`) of `text`: the first 4 bytes of SHA-256 of its words (`memoryWords`) lowercased, in hex. */
export async function memoryItemId(kind: "rule" | "preference", text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memoryWords(text).toLowerCase())));
  return `${kind === "rule" ? "r" : "p"}-${[...digest.slice(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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
  /** Keeps `memory` by `memory.by`; one already kept under its `id` stays as it is, text, status and author (idempotent, nothing logged). */
  remember(owner: MemoryOwner, memory: NewMemory, ctx: AppContext): Promise<void>;
  /**
   * Makes `owner`'s memory `id` of `kind` active, when it is pending. `true` when `owner` has an active
   * memory of `kind` under `id` now (one already active included: approving twice is approving once),
   * `false` when it has none of that kind.
   */
  approve(owner: MemoryOwner, id: string, kind: MemoryKind, by: Author, ctx: AppContext): Promise<boolean>;
  /** Removes `owner`'s memory `id` when `filter` takes it, by `by`; `true` when one was removed (an unknown id is `false`, not an error). */
  forget(owner: MemoryOwner, id: string, filter: MemoryFilter, by: Author, ctx: AppContext): Promise<boolean>;
  /**
   * New words for `owner`'s memory `id` (a rule's or a note's), as one change by `memory.by`: `id` removed
   * and `memory` kept (its own id: a rule's id is its words'), so one restore brings the old words back.
   * The kept memory has `id`'s kind and status; its `by` is the replacer. `undefined` when `id` is not kept.
   */
  replace(owner: MemoryOwner, id: string, memory: NewMemory, ctx: AppContext): Promise<Memory | undefined>;
  /**
   * `owner`'s memories `filter` takes (default `MEMORY_SEARCH_DEFAULT`: facts and summaries; any status
   * unless given) that match `query`'s words (all of them, else the phrase, else any of them), any case,
   * the best `limit` first (the newest first among equals), each with a snippet. A query with no word
   * finds nothing.
   */
  search(owner: MemoryOwner, query: string, limit: number, ctx: AppContext, filter?: MemoryFilter): Promise<MemoryMatch[]>;
  /** `owner`'s change log, newest first. */
  changes(owner: MemoryOwner, page: ChangePageRequest, ctx: AppContext): Promise<ChangePage>;
  /** Brings back the state before change `n`, as a `restored` change by `by`; `gone` past retention or redacted. */
  restore(owner: MemoryOwner, n: number, by: Author, ctx: AppContext): Promise<Change>;
  /** Blanks the stored states of change `n`: an operator's only (`forbidden` for any other author). */
  redact(owner: MemoryOwner, n: number, by: Author, ctx: AppContext): Promise<void>;
  /** Deletes every memory and the log of `owner`, for good (a removed project's space). */
  purge(owner: MemoryOwner, ctx: AppContext): Promise<void>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    memory: MemoryStore;
  }
}
