/**
 * `conversations.directory` as every App gives it (`directoryOver`): the contract's checks run first
 * (`parseViewer`, `parseDirectoryQuery`), a people viewer's grants are computed here, in the calling
 * App (`audienceGrants`: the Worker's on Cloudflare, where the membership providers' stages are), and
 * the directory answers (`Backend`): the App's own (`localBackend`, a server's) or the index object's
 * through `actor.mailbox` (`remoteBackend`, on Cloudflare, from the Worker and from each conversation's
 * object alike).
 *
 * A list takes the grants within each provider's list bound (`audienceGrants(ctx, principals)`);
 * `access` and every act ask the directory first with none, and only when the conversation is of a
 * space that is not the viewer's own does it answer `needs`: the grants of that one space are then
 * checked fresh (`audienceGrants(ctx, principals, space)`) and it is asked again. A viewer's own
 * conversation costs one call.
 */

import type { AppContext } from "@pikit/core";
import {
  ActorCallError,
  type ActorMailbox,
  audienceGrants,
  type ConversationDirectory,
  DIRECTORY_COUNT_MAX,
  type DirectoryEntry,
  DirectoryError,
  type DirectoryErrorCode,
  type EntryRef,
  type EntryState,
  isEntryState,
  type JsonValue,
  type Page,
  parseDirectoryCursor,
  parseDirectoryQuery,
  parseViewer,
  type Viewer,
  type ViewerChange,
} from "@pikit/contracts";
import type { DirectoryStore, Grant, Outcome, ParsedQuery } from "./directory.ts";

/** The actor that keeps the directory on Cloudflare: an object of the conversations' class, never a conversation. */
export const INDEX_KEY = "conversations-directory:index";

/** The calls the directory's actor answers, and the one each conversation's App answers (`reset`). */
export const CALL = {
  list: "conversations-directory.list",
  count: "conversations-directory.count",
  access: "conversations-directory.access",
  rename: "conversations-directory.rename",
  setState: "conversations-directory.set-state",
  mine: "conversations-directory.mine",
  title: "conversations-directory.title",
  /** To a conversation's App: reset its key when the conversation named is still its current one. */
  reset: "conversations-directory.reset",
} as const;

/** The message each conversation's App sends the directory: `{ updates }` (`update.ts`). */
export const SEEN = "conversations-directory.seen";

/** What answers a directory call: the directory's rows, wherever they are. */
export interface Backend {
  list(viewer: Viewer, query: ParsedQuery, grants: readonly Grant[], ctx: AppContext): Promise<Page<DirectoryEntry>>;
  count(viewer: Viewer, spaces: readonly string[], grants: readonly Grant[], ctx: AppContext): Promise<Record<string, number>>;
  access(viewer: Viewer, ref: { key: string; conversationId?: string }, grants: readonly Grant[] | undefined, ctx: AppContext): Promise<Outcome>;
  rename(viewer: Viewer, ref: EntryRef, title: string, grants: readonly Grant[] | undefined, ctx: AppContext): Promise<Outcome>;
  setState(viewer: Viewer, ref: EntryRef, state: EntryState, grants: readonly Grant[] | undefined, ctx: AppContext): Promise<Outcome>;
  mine(viewer: Viewer, ref: EntryRef, change: ViewerChange, grants: readonly Grant[] | undefined, ctx: AppContext): Promise<Outcome>;
  title(ref: EntryRef, title: { text: string; source: "first" | "model" }, ctx: AppContext): Promise<void>;
}

/** The directory in this App (a server's). */
export function localBackend(store: DirectoryStore): Backend {
  return {
    list: (viewer, query, grants) => store.list(viewer, query, grants),
    count: (viewer, spaces, grants) => store.count(viewer, spaces, grants),
    access: (viewer, ref, grants) => store.access(viewer, ref, grants),
    rename: (viewer, ref, title, grants) => store.rename(viewer, ref, title, grants),
    setState: (viewer, ref, state, grants, ctx) => store.setState(viewer, ref, state, grants, ctx),
    mine: (viewer, ref, change, grants) => store.mine(viewer, ref, change, grants),
    title: (ref, title) => store.title(ref, title),
  };
}

const CODES: ReadonlySet<string> = new Set<DirectoryErrorCode>(["not_found", "forbidden", "invalid", "invalid_cursor", "limit"]);

/** A refusal the directory made across a call, thrown again as its `DirectoryError`. */
export const directoryErrorOf = (error: unknown): unknown =>
  error instanceof ActorCallError && CODES.has(error.code) ? new DirectoryError(error.code as DirectoryErrorCode, error.message) : error;

/** `value` as the JSON a call carries (absent fields dropped). */
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

/** The directory in the index object, through `actor.mailbox` (Cloudflare). */
export function remoteBackend(mailbox: () => ActorMailbox): Backend {
  const ask = async <T>(type: string, message: Record<string, unknown>, ctx: AppContext): Promise<T> => {
    try {
      return (await mailbox().call(INDEX_KEY, type, json(message), ctx)) as T;
    } catch (error) {
      throw directoryErrorOf(error);
    }
  };
  return {
    list: (viewer, query, grants, ctx) => ask(CALL.list, { viewer, query, grants }, ctx),
    count: (viewer, spaces, grants, ctx) => ask(CALL.count, { viewer, spaces, grants }, ctx),
    access: (viewer, ref, grants, ctx) => ask(CALL.access, { viewer, ref, ...(grants !== undefined && { grants }) }, ctx),
    rename: (viewer, ref, title, grants, ctx) => ask(CALL.rename, { viewer, ref, title, ...(grants !== undefined && { grants }) }, ctx),
    setState: (viewer, ref, state, grants, ctx) => ask(CALL.setState, { viewer, ref, state, ...(grants !== undefined && { grants }) }, ctx),
    mine: (viewer, ref, change, grants, ctx) => ask(CALL.mine, { viewer, ref, change, ...(grants !== undefined && { grants }) }, ctx),
    title: async (ref, title, ctx) => void (await ask(CALL.title, { ref, title }, ctx)),
  };
}

const PART_MAX = 1024;
const textOf = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "" || value.length > PART_MAX) throw new DirectoryError("invalid", `${what} is a non-empty string of at most ${PART_MAX} characters`);
  return value;
};

/** A ref as it arrived, checked and copied: a key and a conversation id. */
export function parseRef(value: unknown): EntryRef {
  const { key, conversationId } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return { key: textOf(key, "ref.key"), conversationId: textOf(conversationId, "ref.conversationId") };
}

/** A ref of `access`: a key, and maybe a conversation id. */
export function parseKeyRef(value: unknown): { key: string; conversationId?: string } {
  const { key, conversationId } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return { key: textOf(key, "ref.key"), ...(conversationId !== undefined && conversationId !== null && { conversationId: textOf(conversationId, "ref.conversationId") }) };
}

/** `spaces` of a `count`, checked. */
export function parseSpaces(spaces: unknown): string[] {
  if (!Array.isArray(spaces) || spaces.length === 0 || spaces.length > DIRECTORY_COUNT_MAX) throw new DirectoryError("invalid", `count takes 1 to ${DIRECTORY_COUNT_MAX} spaces`);
  return spaces.map((space) => textOf(space, "spaces[]"));
}

/** A list's query, checked, with what only the viewer decides: people never list deleted ones, a component owns nothing. */
export function listQuery(viewer: Viewer, raw: unknown): ParsedQuery {
  const query = parseDirectoryQuery(raw);
  if (query.state === "deleted" && viewer.kind === "people") throw new DirectoryError("forbidden", "people never list deleted conversations");
  if (query.owned === true && viewer.kind === "component") throw new DirectoryError("invalid", "a component owns nothing");
  if (query.cursor !== undefined) parseDirectoryCursor(query.cursor);
  return query;
}

/** `audienceGrants`' answer as the directory takes it. */
const grantsOf = async (ctx: AppContext, viewer: Viewer, space?: string): Promise<Grant[]> =>
  viewer.kind !== "people" ? [] : (await audienceGrants(ctx, viewer.principals, space)).map(({ space: granted, role }) => ({ space: granted, role }));

export interface ClientHooks {
  /** A `first` title was given for `ref` (a channel's first message): what the titler of this App titles from. */
  first?(ref: EntryRef, text: string, ctx: AppContext): Promise<void>;
}

/** `conversations.directory` over `backend()`. */
export function directoryOver(backend: () => Backend, hooks: ClientHooks = {}): ConversationDirectory {
  /** Asks with no grants, then, when the directory needs a space's, with that space's checked fresh. */
  const withGrants = async (viewer: Viewer, ctx: AppContext, ask: (grants: readonly Grant[] | undefined) => Promise<Outcome>): Promise<DirectoryEntry | undefined> => {
    const first = await ask(undefined);
    if (first.needs === undefined) return first.entry;
    const again = await ask(await grantsOf(ctx, viewer, first.needs));
    return again.needs === undefined ? again.entry : undefined;
  };
  const act = async (viewer: Viewer, ctx: AppContext, ask: (grants: readonly Grant[] | undefined) => Promise<Outcome>): Promise<DirectoryEntry> => {
    const entry = await withGrants(viewer, ctx, ask);
    if (entry === undefined) throw new DirectoryError("not_found", "no such conversation");
    return entry;
  };

  return {
    async list(rawViewer, rawQuery, ctx) {
      const viewer = parseViewer(rawViewer);
      const query = listQuery(viewer, rawQuery);
      return backend().list(viewer, query, await grantsOf(ctx, viewer), ctx);
    },
    async count(rawViewer, rawSpaces, ctx) {
      const viewer = parseViewer(rawViewer);
      const spaces = parseSpaces(rawSpaces);
      return backend().count(viewer, spaces, await grantsOf(ctx, viewer), ctx);
    },
    async access(rawViewer, rawRef, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = parseKeyRef(rawRef);
      return withGrants(viewer, ctx, (grants) => backend().access(viewer, ref, grants, ctx));
    },
    async rename(rawViewer, rawRef, title, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = parseRef(rawRef);
      if (typeof title !== "string") throw new DirectoryError("invalid", "a title is a string");
      return act(viewer, ctx, (grants) => backend().rename(viewer, ref, title, grants, ctx));
    },
    async setState(rawViewer, rawRef, state, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = parseRef(rawRef);
      if (!isEntryState(state)) throw new DirectoryError("invalid", "a state is listed, archived or deleted");
      return act(viewer, ctx, (grants) => backend().setState(viewer, ref, state, grants, ctx));
    },
    async mine(rawViewer, rawRef, change, ctx) {
      const viewer = parseViewer(rawViewer);
      const ref = parseRef(rawRef);
      if (viewer.kind === "component") throw new DirectoryError("invalid", "a component has no state of its own");
      return act(viewer, ctx, (grants) => backend().mine(viewer, ref, change ?? {}, grants, ctx));
    },
    async title(rawRef, title, ctx) {
      const ref = parseRef(rawRef);
      if ((title?.source !== "first" && title?.source !== "model") || typeof title.text !== "string") throw new DirectoryError("invalid", "a title is { text, source: first or model }");
      await backend().title(ref, { text: title.text, source: title.source }, ctx);
      if (title.source === "first") await hooks.first?.(ref, title.text, ctx);
    },
  };
}
