/**
 * Who changed what: the vocabulary of the append-only change logs several stores keep and one page
 * reads (features/projects.md, "History, versions and undo"). Shared vocabulary (contract rule 2): the
 * project store (`projects`), the space's files (`space.files`) and memory (memory-sql's `memory`)
 * each keep a log of their own, in the actor that owns the items, and channel-web merges the three into
 * a project's History. None of them knows the others; they agree on these shapes.
 *
 * - **`Principal`**: a channel's identity, as a request's `Sender` (`{ channel, id }`), with the display
 *   name the channel gave at the time (`name`: shown, never checked, never a key).
 * - **`Author`**: who made a change and from where. Set by the component that took the change, from what
 *   it authenticated (a session, `RUN_REQUESTS`, `CONVERSATION`, `admin.auth`), never from a model's or a
 *   page's words. It crosses actors as JSON: every actor checks it on arrival with `parseAuthor`.
 * - **`Change`**: one entry of a store's log for one owner (a space, a project, a memory owner).
 *
 * What every store that keeps a log guarantees (`changeLogCases` in `@pikit/contracts/testing` checks
 * it, each store's suite runs it):
 * - **Every change is recorded, with its author, in the same commit as the change**: the store writes
 *   the item and its entry in one transaction, in the actor that owns both. A write that changes nothing
 *   (a repeat) appends nothing.
 * - **Append-only**: `n` counts 1, 2, 3... per log, gapless, never reused, never rewritten. No method
 *   changes or deletes an entry; `restore` appends one. The only exceptions are not members': an
 *   operator's `redact(n)` (blanks the stored states and the title of one entry for a personal datum
 *   that must not stay; who and when stay, and `redacted` says it was), retention (entries past
 *   `CHANGE_RETENTION_DAYS` dropped from the oldest; numbers never reused) and the purge of a removed
 *   owner.
 * - **Restore is exact**: `restore(n)` puts the item back as it was just before change `n` (an added item
 *   removed, a changed one at its previous state with its original author kept on the item, a removed one
 *   back under its id) and appends a `restored` entry whose `restores` is `n` and whose author is the
 *   restorer. The state it replaces is kept too, so a restore can be restored. An entry whose earlier
 *   state is past retention or redacted says `restorable: false`, and restoring it is `gone`.
 */

import { isJsonObject } from "./json.ts";

/** A channel's identity, as a request's `Sender`. `name`: the display name the channel gave at the time: shown, never checked. */
export type Principal = { channel: string; id: string; name?: string };

/**
 * Who made a change and from where. A type, not an interface: it crosses actors as JSON.
 * - `person`: a person, as a channel authenticated them; `conversation` is the key of the chat a
 *   command was typed in (`/rules add`), absent for a page.
 * - `agent`: an agent's tool, in the conversation it worked in (its key); `for` is the person whose
 *   message the run answered, when one did (`RUN_REQUESTS`' latest person sender).
 * - `operator`: a route behind `admin.auth` (the operator's id), or the dashboard's "/" (`dashboard`).
 * - `component`: trusted code acting on its own (memory-summaries, a membership sync, an import).
 */
export type Author =
  | { kind: "person"; principal: Principal; conversation?: string }
  | { kind: "agent"; agent: string; conversation: string; for?: Principal }
  | { kind: "operator"; id: string }
  | { kind: "component"; name: string };

/** What a change did to its item. */
export type ChangeAction = "added" | "changed" | "removed" | "restored";

/** The item a change is about: `kind` is the store's (`rule`, `note`, `document`, `file`...); `title` at most `CHANGE_TITLE_MAX` characters, one line. */
export type ChangeItem = { kind: string; id: string; title: string };

/** One entry of a store's append-only log for one owner. */
export type Change = {
  /** 1, 2, 3... per log, gapless, never reused nor rewritten. */
  n: number;
  /** Epoch ms, the store's clock. */
  at: number;
  by: Author;
  action: ChangeAction;
  item: ChangeItem;
  /** The item's version after the change, for versioned items. */
  version?: number;
  /** For `restored`: the change whose earlier state came back. */
  restores?: number;
  /** `false` once the state before it is past retention or redacted: its restore is `gone`. */
  restorable: boolean;
  /** An operator blanked its stored states (and its title); the entry stays. */
  redacted?: { at: number; by: Author };
};

/** A page of a log, newest first, and the `before` of the next (absent on the last page). */
export type ChangePage = { items: Change[]; next?: number };

/** What a page of a log asks for: entries with `n` below `before` (absent: the newest), at most `limit` (1 to `CHANGE_PAGE_MAX`). */
export type ChangePageRequest = { before?: number; limit: number };

/** The longest title an entry keeps, in characters. */
export const CHANGE_TITLE_MAX = 120;
/** How long entries, and the states they restore, are kept. */
export const CHANGE_RETENTION_DAYS = 365;
/** The most entries one page of a log answers. */
export const CHANGE_PAGE_MAX = 200;
/** The longest channel, id, agent, conversation key or name an author holds, in characters. */
export const AUTHOR_PART_MAX = 1024;
/** The longest display name a principal carries, in characters. */
export const PRINCIPAL_NAME_MAX = 120;

/** Input of the change vocabulary that is not valid (an author, a principal, a page request): what the parsers throw. Its message says what is wrong and never quotes the value. */
export class ChangeInputError extends TypeError {
  readonly code = "invalid";
  constructor(message: string) {
    super(message);
    this.name = "ChangeInputError";
  }
}

const part = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > AUTHOR_PART_MAX) throw new ChangeInputError(`${what} is a non-empty string of at most ${AUTHOR_PART_MAX} characters`);
  return value;
};

/** A principal that crossed as JSON, checked and copied (only its fields): what every actor runs on arrival. */
export function parsePrincipal(value: unknown, what = "principal"): Principal {
  if (!isJsonObject(value)) throw new ChangeInputError(`${what} is a JSON object`);
  const principal: Principal = { channel: part(value.channel, `${what}.channel`), id: part(value.id, `${what}.id`) };
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== "string" || value.name.length > PRINCIPAL_NAME_MAX || /[\r\n]/.test(value.name)) {
      throw new ChangeInputError(`${what}.name is one line of at most ${PRINCIPAL_NAME_MAX} characters`);
    }
    if (value.name.trim() !== "") principal.name = value.name.trim();
  }
  return principal;
}

/**
 * An author that crossed as JSON (an actor's message, a stored row), checked and copied with only its
 * fields: the check every actor runs before it records a change. Throws `ChangeInputError` otherwise.
 */
export function parseAuthor(value: unknown): Author {
  if (!isJsonObject(value)) throw new ChangeInputError("an author is a JSON object");
  switch (value.kind) {
    case "person": {
      const author: Author = { kind: "person", principal: parsePrincipal(value.principal, "author.principal") };
      if (value.conversation !== undefined && value.conversation !== null) author.conversation = part(value.conversation, "author.conversation");
      return author;
    }
    case "agent": {
      const author: Author = { kind: "agent", agent: part(value.agent, "author.agent"), conversation: part(value.conversation, "author.conversation") };
      if (value.for !== undefined && value.for !== null) author.for = parsePrincipal(value.for, "author.for");
      return author;
    }
    case "operator":
      return { kind: "operator", id: part(value.id, "author.id") };
    case "component":
      return { kind: "component", name: part(value.name, "author.name") };
    default:
      throw new ChangeInputError('author.kind is "person", "agent", "operator" or "component"');
  }
}

/** Whether two principals are the same identity (channel and id; the name is not part of it). */
export const samePrincipal = (a: Principal, b: Principal): boolean => a.channel === b.channel && a.id === b.id;

/**
 * One string per principal, never two principals' the same (the channel URI-encoded, so a channel with
 * `:` cannot collide): a row's key, a map's key.
 */
export const principalKey = (principal: Principal): string => `${encodeURIComponent(principal.channel)}:${principal.id}`;

/** A text as an entry's title: one line, its spaces folded, cut to `CHANGE_TITLE_MAX` characters (ending in "..."). */
export function changeTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= CHANGE_TITLE_MAX ? line : `${line.slice(0, CHANGE_TITLE_MAX - 3).trimEnd()}...`;
}

/** Whether `at` is past retention at `now`: its entry's earlier state may be dropped. */
export const pastRetention = (at: number, now: number): boolean => now - at > CHANGE_RETENTION_DAYS * 86_400_000;

/** A page request as it arrived (JSON), checked: `limit` 1 to `CHANGE_PAGE_MAX`, `before` a positive integer when given. */
export function parseChangePageRequest(value: unknown): ChangePageRequest {
  if (!isJsonObject(value)) throw new ChangeInputError("a page request is a JSON object");
  const { limit, before } = value;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CHANGE_PAGE_MAX) throw new ChangeInputError(`limit is an integer from 1 to ${CHANGE_PAGE_MAX}`);
  if (before === undefined || before === null) return { limit };
  if (typeof before !== "number" || !Number.isInteger(before) || before < 1) throw new ChangeInputError("before is a positive integer");
  return { before, limit };
}
