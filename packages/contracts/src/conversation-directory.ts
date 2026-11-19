/**
 * `conversations.directory`: which conversations exist and how they are listed, the same for every view
 * (features/completed/conversation-directory.md). One entry per conversation (a key and its runtime conversation)
 * with its channel, agent, space, owner, one title whoever looks, when it was made and last active,
 * whether a run goes, and its state for everyone (`listed`, `archived`, `deleted`); per viewer, their own
 * state (hidden for me, read up to, their own name for it). Views (admin-api's list, channel-web's chats)
 * read it through a `Viewer` they authenticated; nobody keeps an index of their own.
 *
 *   const directory = pikit.use("conversations.directory");
 *   const page = await directory.list({ kind: "people", principals }, { channels: ["web"], owned: true }, ctx);
 *   const entry = await directory.access({ kind: "people", principals }, { key }, ctx); // undefined: 404
 *
 * What the directory holds is recorded by its provider from the runtime's events in each conversation's
 * App (`agent.dispatched` with its `sender`, `agent.started`, `agent.settled`, `agent.failed`,
 * `conversation.reset`), the place (channel, space, owner) read from `conversations.registry` when it
 * first sees a key, and a backfill from `agent.observe` at each App's start: no method adds an entry.
 * Not here: transcripts, usage (`agent.observe`), who a conversation is with (`conversation.describe`).
 *
 * What every provider guarantees (`createConversationDirectoryConformance` in `@pikit/contracts/testing`
 * checks it):
 * - **Who looks** (`Viewer`, checked on arrival with `parseViewer`, `invalid` otherwise): an `operator`
 *   (`admin.auth`'s) and a `component` (trusted code) see every conversation; a `people` viewer (1 to
 *   `VIEWER_PRINCIPALS_MAX` principals of one person, never of the `dashboard` or `delegate` channel, the
 *   first the one the view authenticated) sees a conversation when it is its key's current one, not
 *   delegated, not deleted, has activity people may see, and is theirs: its `owner` is among their
 *   principals, or its space is one a grant of `conversation.audience` names (`audienceGrants`, run by the
 *   provider: for a list within each stage's list bound, for `access` and every act checked fresh for
 *   that one space). A conversation a viewer may not see is `not_found` for every method, the same as one
 *   that does not exist.
 * - **One activity, two orders.** Every admitted message (not a duplicate) and every run's end is
 *   activity, at the provider's clock (`ctx.clock`). Activity of an operator's request (a `dashboard:`
 *   request id, `isDashboardRequest`) and the end of a run only such requests took
 *   (`answersOnlyTheDashboard`) is the operators' only: it moves the entry's `lastActivity` for
 *   operators and components, never for people (no reordering, no unread, no unarchive, no unhide). A
 *   list is ordered by the `lastActivity` its viewer sees, newest first, then key, then conversation id
 *   (`compareDirectoryOrder`), paged by a keyset cursor (`directoryCursor`): a page never repeats nor
 *   skips an entry that did not change, and a cursor gives nothing its viewer may not list. Every list
 *   holds only conversations with activity its viewer sees (`lastActivity > 0`).
 * - **One title** (`title`, `titleSource`): `first` (a channel's first message as its person wrote it) <
 *   `model` (the titler) < `rename` (a view's `rename`). `title` writes a `first` or `model` title unless
 *   one of a higher source is there (an equal one is replaced); `rename` always writes (`titleApplies`).
 *   Every title is `cleanTitle`'d; a text that cleans to nothing is no title (`title` writes nothing,
 *   `rename` is `invalid`). A title given before the conversation is recorded applies when it is. A reset's
 *   new conversation has its own title. A viewer's own `name` never changes the title, and only that
 *   viewer sees it or searches by it.
 * - **Per viewer** (`mine`; the operators' and people's, keyed by `viewerKey`; components have none:
 *   `invalid`): any viewer who sees a conversation hides it, names it and marks it read, for themselves
 *   only. "Hide for me" lasts until activity the viewer sees comes after it (the operator's decision of
 *   2026-11-19): the conversation is back in that viewer's list. A read mark only moves forward, and never
 *   past the provider's now. `unread` counts the activity the viewer sees after their mark by anyone not
 *   among their principals (an agent's answer included, their own messages never), at most `UNREAD_MAX`.
 * - **For everyone** (`rename`, `setState`, what `may` says; the operator's decisions of 2026-11-19):
 *   operators, components and the conversation's owner rename, archive and delete it; the owner of its
 *   space (an `owner` grant: a project's owner) renames and archives it, never deletes it (`forbidden`);
 *   a member does none of these (`forbidden`). Archived and deleted are seen the same in every view.
 *   An archived conversation is `listed` again once activity people may see comes after it was archived
 *   (`stateAt`, `stateBy` cleared); a deleted one stays deleted whatever comes. Deleting a key's current
 *   conversation also resets its key (`conversations.registry.reset`) before `setState` resolves, so the
 *   platform's next message starts a new conversation; people never see the deleted one again (it is no
 *   longer current), operators and components may set it back. A repeat (the state it has) changes nothing.
 * - **Buckets.** For a viewer each conversation is in exactly one `DirectoryListState` (`listStateOf`):
 *   `deleted` (operators' and components' only: people asking for it are `forbidden`), else `hidden`
 *   (hidden for me), else its state for everyone (`listed`, `archived`). A list gives one bucket, `listed`
 *   by default; `access` answers any bucket but `deleted` to people.
 * - **Idempotent recording.** What the provider records is field-wise idempotent: a late or repeated
 *   update changes nothing (activity is a maximum, `busy` and `agent` follow the newest update of a
 *   conversation, `current` only goes false, titles follow their precedence). A restart loses nothing
 *   committed.
 * - **Bounds**: a page of 1 to `DIRECTORY_PAGE_MAX` (default `DIRECTORY_PAGE_DEFAULT`); `q` at most
 *   `DIRECTORY_SEARCH_MAX` characters, matched as text (`%`, `_`, `\` are literal), lowercased, over the
 *   title and the viewer's own name (operators also the key); `count` of 1 to `DIRECTORY_COUNT_MAX`
 *   spaces; past `AUDIENCE_MAX` grants a people viewer's call is `limit` (never a silent cut). Malformed
 *   input is `invalid` (`parseDirectoryQuery`), a cursor not of this order `invalid_cursor`.
 *
 * Errors: `DirectoryError` (`code`: `not_found`, `forbidden`, `invalid`, `invalid_cursor`, `limit`).
 *
 * Provider: conversations-directory (features/completed/conversation-directory.md). Users: admin-api,
 * channel-web, channel-google-chat (its first message's title). One provider: `experimental`.
 */

import type { AppContext } from "@pikit/core";
import { type Author, type Principal, principalKey, samePrincipal } from "./change.ts";
import { isJsonObject } from "./json.ts";
import type { Page } from "./page.ts";

/** A conversation: a key and its runtime conversation (on Cloudflare an object's id is unique only with its key). */
export type EntryRef = { key: string; conversationId: string };

/**
 * Who looks. Built by the view from what it authenticated (a session, `admin.auth`), never from a
 * page's words. A type: it crosses actors as JSON (`parseViewer` on arrival).
 * - `operator`: `admin.auth`'s operator: every conversation; its own state under `viewerKey`.
 * - `people`: one person, `principals[0]` the identity the view authenticated (whose state it is), the
 *   rest the same person's other identities (`principals.of`).
 * - `component`: trusted code: every conversation, no state of its own.
 */
export type Viewer = { kind: "operator"; id: string } | { kind: "people"; principals: Principal[] } | { kind: "component"; name: string };

/** Where a title comes from, lowest first: a higher one is never replaced by a lower one. */
export type TitleSource = "first" | "model" | "rename";
export const TITLE_SOURCES: readonly TitleSource[] = ["first", "model", "rename"];

/** A conversation's state for everyone. */
export type EntryState = "listed" | "archived" | "deleted";

/** Which list a conversation is in for one viewer (`listStateOf`): exactly one. */
export type DirectoryListState = "listed" | "archived" | "hidden" | "deleted";

/**
 * Why this viewer sees it: an operator or a component; for people, the conversation's `owner`, the
 * owner of its space (an `owner` grant), or a member of it (a `member` grant). The best one counts.
 */
export type DirectoryRole = "operator" | "component" | "owner" | "space-owner" | "member";

/** What this viewer may do for everyone (`permissionsOf(role)`). Every viewer who sees it hides, names and marks it for themselves. */
export type DirectoryPermissions = { rename: boolean; archive: boolean; delete: boolean };

/** One viewer's own state of a conversation. */
export type ViewerState = {
  /** Hidden for this viewer: hidden, and no activity this viewer sees came after. */
  hidden: boolean;
  /** When the viewer hid it (kept while `hidden`). */
  hiddenAt?: number;
  /** The viewer's read mark: activity up to it is read. */
  readAt?: number;
  /** The viewer's own name for it: seen and searched by this viewer only. */
  name?: string;
  /** Activity this viewer sees after `readAt` by anyone not among their principals, at most `UNREAD_MAX`. */
  unread: number;
};

/** A conversation as one viewer sees it. */
export type DirectoryEntry = EntryRef & {
  channel: string;
  agent: string;
  /** Its space (`ConversationRef.space`), when its channel gave one. */
  space?: string;
  /** Who it belongs to, as its channel gave it at admission (`conversations.registry`'s record): a web user, the operator who started it. */
  owner?: Principal;
  /** It is its key's current conversation: a reset leaves the previous one `false`, for good. */
  current: boolean;
  /** When the directory first recorded it. */
  createdAt: number;
  /** Its newest activity this viewer sees (for people, never an operator's); 0: none yet. */
  lastActivity: number;
  /** A run goes. */
  busy: boolean;
  title?: string;
  titleSource?: TitleSource;
  state: EntryState;
  /** When its state was set, and by whom (absent while `listed` by default or again after activity). */
  stateAt?: number;
  stateBy?: Author;
  /** This viewer's own state (operators and people; absent for components). */
  mine?: ViewerState;
  role: DirectoryRole;
  may: DirectoryPermissions;
};

/** What a list asks for. */
export type DirectoryQuery = {
  /** 1 to `DIRECTORY_PAGE_MAX`; default `DIRECTORY_PAGE_DEFAULT`. */
  limit?: number;
  /** The `next` of the previous page (`directoryCursor`). */
  cursor?: string;
  /** The bucket listed; default `listed`. `deleted` is operators' and components' (people: `forbidden`). */
  state?: DirectoryListState;
  /** Text searched (see the header); empty: none. */
  q?: string;
  /** Only the conversations of this space. */
  space?: string;
  /** Only the conversations of these channels (`ConversationRef.channel`); absent: every channel. */
  channels?: string[];
  /** `true`: only those the viewer owns (people: owner among their principals; an operator: `{ channel: "dashboard", id }`). Components: `invalid`. */
  owned?: boolean;
};

/** A change of one viewer's own state: `hidden` (true hides now, false shows), `readUpTo` (a time, moved forward only), `name` (`null` clears). */
export type ViewerChange = { hidden?: boolean; readUpTo?: number; name?: string | null };

/** The `conversations.directory` capability. Every method's `ctx` is the App's. */
export interface ConversationDirectory {
  /** One page of the bucket asked, as `viewer` sees it (see the header). */
  list(viewer: Viewer, query: DirectoryQuery, ctx: AppContext): Promise<Page<DirectoryEntry>>;
  /** How many conversations each space lists for `viewer` (`list(viewer, { space })` in all), for every space asked (0 for none). */
  count(viewer: Viewer, spaces: readonly string[], ctx: AppContext): Promise<Record<string, number>>;
  /**
   * The entry when `viewer` may see it now (a people viewer's grant checked fresh), else `undefined`. With
   * no `conversationId`, the key's current conversation. Answers people any bucket but `deleted`.
   */
  access(viewer: Viewer, ref: { key: string; conversationId?: string }, ctx: AppContext): Promise<DirectoryEntry | undefined>;
  /** Renames it for everyone (`may.rename`): source `rename`. `invalid` when `title` cleans to nothing. */
  rename(viewer: Viewer, ref: EntryRef, title: string, ctx: AppContext): Promise<DirectoryEntry>;
  /** Its state for everyone: `archived` and back (`may.archive`), `deleted` and back (`may.delete`; resets the key, see the header). */
  setState(viewer: Viewer, ref: EntryRef, state: EntryState, ctx: AppContext): Promise<DirectoryEntry>;
  /** The viewer's own state (operators and people who see it). */
  mine(viewer: Viewer, ref: EntryRef, change: ViewerChange, ctx: AppContext): Promise<DirectoryEntry>;
  /** Trusted code (a channel's first message as its person wrote it, the titler's answer): written unless a title of a higher source is there. */
  title(ref: EntryRef, title: { text: string; source: "first" | "model" }, ctx: AppContext): Promise<void>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "conversations.directory": ConversationDirectory;
  }
}

/** Why a call rejected: see the header. */
export type DirectoryErrorCode = "not_found" | "forbidden" | "invalid" | "invalid_cursor" | "limit";

export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;
  constructor(code: DirectoryErrorCode, message: string) {
    super(message);
    this.name = "DirectoryError";
    this.code = code;
  }
}

/** The longest title (`cleanTitle`) and viewer's name, in characters. */
export const TITLE_MAX = 60;
/** The most `unread` says. */
export const UNREAD_MAX = 99;
/** The most grants a people viewer's call takes (`audienceGrants`): past it, `limit`. */
export const AUDIENCE_MAX = 2_000;
/** The most entries a page holds, and how many by default. */
export const DIRECTORY_PAGE_MAX = 100;
export const DIRECTORY_PAGE_DEFAULT = 50;
/** The longest `q`, in characters. */
export const DIRECTORY_SEARCH_MAX = 200;
/** The most spaces one `count` asks for. */
export const DIRECTORY_COUNT_MAX = 100;
/** The most principals a people viewer has. */
export const VIEWER_PRINCIPALS_MAX = 20;
/** Channels whose principals are never people: the dashboard's operators, delegated tasks. */
export const NOT_PEOPLE_CHANNELS: readonly string[] = ["dashboard", "delegate"];
/** The longest id, name, key or space a directory call takes, in characters. */
const PART_MAX = 1024;

const LIST_STATES: readonly DirectoryListState[] = ["listed", "archived", "hidden", "deleted"];
const ENTRY_STATES: readonly EntryState[] = ["listed", "archived", "deleted"];

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > PART_MAX) throw new DirectoryError("invalid", `${what} is a non-empty string of at most ${PART_MAX} characters`);
  return value;
};

/** A principal of a people viewer, checked and copied (only its fields). */
function viewerPrincipal(value: unknown, what: string): Principal {
  if (!isJsonObject(value)) throw new DirectoryError("invalid", `${what} is a JSON object`);
  const principal: Principal = { channel: text(value.channel, `${what}.channel`), id: text(value.id, `${what}.id`) };
  if (NOT_PEOPLE_CHANNELS.includes(principal.channel)) throw new DirectoryError("invalid", `${what}.channel is never ${NOT_PEOPLE_CHANNELS.join(" or ")} for people`);
  if (typeof value.name === "string" && value.name.trim() !== "" && value.name.length <= 120 && !/[\r\n]/.test(value.name)) principal.name = value.name.trim();
  return principal;
}

/** A viewer as it arrived (JSON), checked and copied: what every provider runs first. Throws `DirectoryError` `invalid`, never quoting the value. */
export function parseViewer(value: unknown): Viewer {
  if (!isJsonObject(value)) throw new DirectoryError("invalid", "a viewer is a JSON object");
  switch (value.kind) {
    case "operator":
      return { kind: "operator", id: text(value.id, "viewer.id") };
    case "component":
      return { kind: "component", name: text(value.name, "viewer.name") };
    case "people": {
      const { principals } = value;
      if (!Array.isArray(principals) || principals.length === 0 || principals.length > VIEWER_PRINCIPALS_MAX) {
        throw new DirectoryError("invalid", `viewer.principals is a list of 1 to ${VIEWER_PRINCIPALS_MAX} principals`);
      }
      return { kind: "people", principals: principals.map((each) => viewerPrincipal(each, "viewer.principals[]")) };
    }
    default:
      throw new DirectoryError("invalid", 'viewer.kind is "operator", "people" or "component"');
  }
}

/** The principal an operator is as an owner and in activity: `{ channel: "dashboard", id }` (admin-api's own conversations). */
export const operatorPrincipal = (id: string): Principal => ({ channel: "dashboard", id });

/** The principals `viewer` is: a person's, an operator's one (`operatorPrincipal`), none for a component. */
export function viewerPrincipals(viewer: Viewer): readonly Principal[] {
  if (viewer.kind === "people") return viewer.principals;
  return viewer.kind === "operator" ? [operatorPrincipal(viewer.id)] : [];
}

/** Whose per-viewer state this viewer's is: `principalKey` of a person's first principal or of `operatorPrincipal`; `undefined` for a component. */
export function viewerKey(viewer: Viewer): string | undefined {
  const [first] = viewerPrincipals(viewer);
  return first === undefined ? undefined : principalKey(first);
}

/** Whether `owner` is `viewer` (`DirectoryQuery.owned`, the `owner` role). */
export const viewerOwns = (viewer: Viewer, owner: Principal | undefined): boolean => owner !== undefined && viewerPrincipals(viewer).some((each) => samePrincipal(each, owner));

/** The author a state change by `viewer` records (`DirectoryEntry.stateBy`). */
export function viewerAuthor(viewer: Viewer): Author {
  switch (viewer.kind) {
    case "operator":
      return { kind: "operator", id: viewer.id };
    case "component":
      return { kind: "component", name: viewer.name };
    case "people": {
      const [principal] = viewer.principals;
      if (principal === undefined) throw new DirectoryError("invalid", "a people viewer has at least one principal");
      return { kind: "person", principal };
    }
  }
}

/** What `role` may do for everyone: the operator's decision of 2026-11-19 (a space's owner archives, never deletes). */
export function permissionsOf(role: DirectoryRole): DirectoryPermissions {
  switch (role) {
    case "operator":
    case "component":
    case "owner":
      return { rename: true, archive: true, delete: true };
    case "space-owner":
      return { rename: true, archive: true, delete: false };
    case "member":
      return { rename: false, archive: false, delete: false };
  }
}

/** Whether a title of `next` source is written over one of `current` (none: always): `rename` always, else an equal or higher source. */
export const titleApplies = (current: TitleSource | undefined, next: TitleSource): boolean =>
  next === "rename" || current === undefined || TITLE_SOURCES.indexOf(next) >= TITLE_SOURCES.indexOf(current);

/** Whether a viewer who hid at `hiddenAt` still has it hidden, with `activity` the newest they see: no activity after the hiding. */
export const stillHidden = (hiddenAt: number | undefined, activity: number): boolean => hiddenAt !== undefined && activity <= hiddenAt;

/** The one list a conversation is in for a viewer. */
export const listStateOf = (entry: { state: EntryState; mine?: { hidden: boolean } }): DirectoryListState =>
  entry.state === "deleted" ? "deleted" : entry.mine?.hidden === true ? "hidden" : entry.state;

/** `query` as it arrived (JSON), checked and copied with its defaults (`limit`, `state`, `q` trimmed): what every provider runs first. Throws `DirectoryError` `invalid`. */
export function parseDirectoryQuery(value: unknown): DirectoryQuery & { limit: number; state: DirectoryListState } {
  if (!isJsonObject(value)) throw new DirectoryError("invalid", "a directory query is a JSON object");
  const { limit = DIRECTORY_PAGE_DEFAULT, cursor, state = "listed", q, space, channels, owned } = value as Record<string, unknown>;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > DIRECTORY_PAGE_MAX) throw new DirectoryError("invalid", `limit is an integer from 1 to ${DIRECTORY_PAGE_MAX}`);
  if (typeof state !== "string" || !LIST_STATES.includes(state as DirectoryListState)) throw new DirectoryError("invalid", `state is one of ${LIST_STATES.join(", ")}`);
  const query: DirectoryQuery & { limit: number; state: DirectoryListState } = { limit, state: state as DirectoryListState };
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== "string") throw new DirectoryError("invalid_cursor", "a cursor is a string a page gave");
    query.cursor = cursor;
  }
  if (q !== undefined && q !== null) {
    if (typeof q !== "string" || q.length > DIRECTORY_SEARCH_MAX) throw new DirectoryError("invalid", `q is a string of at most ${DIRECTORY_SEARCH_MAX} characters`);
    if (q.trim() !== "") query.q = q.trim();
  }
  if (space !== undefined && space !== null) query.space = text(space, "space");
  if (channels !== undefined && channels !== null) {
    if (!Array.isArray(channels) || channels.length === 0 || channels.length > 20) throw new DirectoryError("invalid", "channels is a list of 1 to 20 channels");
    query.channels = channels.map((each) => text(each, "channels[]"));
  }
  if (owned !== undefined && owned !== null) {
    if (typeof owned !== "boolean") throw new DirectoryError("invalid", "owned is a boolean");
    query.owned = owned;
  }
  return query;
}

/** Whether `state` is a state for everyone. */
export const isEntryState = (state: unknown): state is EntryState => typeof state === "string" && ENTRY_STATES.includes(state as EntryState);

/** Compares two texts by code point (the order of their UTF-8 bytes: SQLite's `BINARY`). */
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const diff = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** A list's position: the activity its viewer sees, the key, the conversation id. */
export type DirectoryPosition = { lastActivity: number; key: string; conversationId: string };

/**
 * A list's order: newest `lastActivity` first, then the greater key, then the greater conversation id
 * (by code point: SQL's `ORDER BY activity DESC, key DESC, conversation DESC` with `BINARY`). Negative
 * when `a` comes first.
 */
export function compareDirectoryOrder(a: DirectoryPosition, b: DirectoryPosition): number {
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  return byCodePoint(b.key, a.key) || byCodePoint(b.conversationId, a.conversationId);
}

/** The cursor of the page after `position` (the last entry of a page): `<lastActivity>:<key>:<conversationId>`, the parts URI-encoded. */
export const directoryCursor = (position: DirectoryPosition): string =>
  `${position.lastActivity}:${encodeURIComponent(position.key)}:${encodeURIComponent(position.conversationId)}`;

/** The position `cursor` names. Throws `DirectoryError` `invalid_cursor` for anything `directoryCursor` did not make. */
export function parseDirectoryCursor(cursor: string): DirectoryPosition {
  const parts = cursor.split(":");
  const [at, key, conversationId] = parts;
  if (parts.length !== 3 || at === undefined || key === undefined || conversationId === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(at)) {
    throw new DirectoryError("invalid_cursor", "not a cursor of this directory");
  }
  try {
    const position = { lastActivity: Number(at), key: decodeURIComponent(key), conversationId: decodeURIComponent(conversationId) };
    if (position.key === "" || position.conversationId === "") throw new Error("empty");
    return position;
  } catch {
    throw new DirectoryError("invalid_cursor", "not a cursor of this directory");
  }
}

/** Whether `position` comes after `cursor`'s in a list: what the next page holds. */
export const afterCursor = (position: DirectoryPosition, cursor: DirectoryPosition): boolean => compareDirectoryOrder(cursor, position) < 0;

/** `q` as a `LIKE` pattern (with `ESCAPE '\'`): lowercased, its `%`, `_` and `\` literal, inside `%...%`. */
export const likePattern = (q: string): string => `%${q.toLowerCase().replace(/[\\%_]/g, (each) => `\\${each}`)}%`;

/** Whether `q` (trimmed, lowercased) is in one of `texts`, as text: what `likePattern` matches. */
export const matchesSearch = (q: string, texts: readonly (string | undefined)[]): boolean => {
  const needle = q.trim().toLowerCase();
  return needle === "" || texts.some((each) => each !== undefined && each.toLowerCase().includes(needle));
};

// Titles: admin-api's and channel-web's rules, made one.

const ELLIPSIS = String.fromCharCode(0x2026);
const chars = (...codes: number[]): string => String.fromCharCode(...codes);
/** Characters never shown: controls, and the bidirectional overrides and isolates that reorder text. */
const HIDDEN = new RegExp(`[\\p{Cc}${chars(0x202a)}-${chars(0x202e)}${chars(0x2066)}-${chars(0x2069)}]`, "gu");
/** Typographic quotes and brackets a title may be wrapped in: single and double curly quotes, guillemets, CJK corner brackets. */
const QUOTES = chars(0x2018, 0x2019, 0x201c, 0x201d, 0xab, 0xbb, 0x300c, 0x300d);
/** Labels a model may put before a title ("Title: ", "Titre - "), in a few languages: taken off. */
const TITLE_LABEL = new RegExp(`^(?:title|name|subject|topic|t${chars(0xed)}tulo|titulo|titre|titel|titolo|nombre|nom)(?:\\s*:\\s*|\\s+[-${chars(0x2013, 0x2014)}]\\s+)`, "i");
/** Quotes and markdown a title is wrapped in. */
const TITLE_WRAP = new RegExp(`^[\\s"'\`*_#>${QUOTES}-]+|[\\s"'\`*_${QUOTES}]+$`, "g");
/** What a title never ends with. */
const TRAILING = /[.,;:\s]+$/u;

/**
 * A conversation's title from a text (a first message, a model's answer, a rename), or `undefined`
 * when nothing is left: its first line with words, without a label ("Title:"), quotes or markdown
 * around it, hidden characters taken out, spaces collapsed, no `.`, `,`, `;` or `:` at its end, its first
 * letter a capital, at most `TITLE_MAX` characters (cut at a word when one is near, with an ellipsis).
 */
export function cleanTitle(text: string): string | undefined {
  const line = text
    .split(/\r?\n|\r/)
    .map((each) => each.replace(HIDDEN, " ").replace(TITLE_WRAP, "").replace(TITLE_LABEL, "").replace(TITLE_WRAP, "").replace(/\s+/g, " ").trim())
    .find((each) => /[\p{L}\p{N}]/u.test(each));
  if (line === undefined) return undefined;
  let title = line.replace(TRAILING, "");
  const points = [...title];
  if (points.length > TITLE_MAX) {
    const cut = points.slice(0, TITLE_MAX - 1).join("");
    const space = cut.lastIndexOf(" ");
    title = `${(space >= TITLE_MAX / 3 ? cut.slice(0, space) : cut).replace(TRAILING, "")}${ELLIPSIS}`;
  }
  return title === "" ? undefined : title.charAt(0).toLocaleUpperCase() + title.slice(1);
}
