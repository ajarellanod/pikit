/**
 * What the admin API's routes read and do (`routes.ts` is written once, over this), on both targets:
 * the conversation directory (`conversations.directory`) as an operator sees it, and where each
 * conversation is (`host.ts`: a server's own App, or on Cloudflare the Worker's calls to its object).
 *
 * - **The list is the directory's**: `list({ kind: "operator", id }, …)`, the most recently active first,
 *   paged by its cursor, searched by its `q` (the title, the key); then each entry's conversation where
 *   it is, for what the directory does not hold (busy, usage, who it is with). An entry whose
 *   conversation is not there (the runtime no longer has it, an object that does not answer) is left out
 *   of the page, logged. A page holds at most `pageMax` (each read is a call on Cloudflare).
 * - **One conversation** is the directory's entry (its title, state, this operator's "hidden") with the
 *   conversation where it is; a conversation the directory does not hold yet (no activity: a reset's new
 *   one) is read all the same, without them.
 * - **For everyone and for me**: a rename is the directory's `rename`; "Archive for everyone", "Delete for
 *   everyone" and back are its `setState` (a delete of a key's current conversation resets the key, so
 *   its next message starts a new one); "Hide for me" is its `mine`, this operator's only.
 * - **A new conversation** of the dashboard's own is made where it is, owned by its operator; its first
 *   message is its first title (`title`, source `first`), as the operator wrote it.
 * - **Every other read and action** is the host's.
 *
 * The directory's refusals (`DirectoryError`) are the API's: `not_found`, `forbidden`, `invalid`
 * (`invalid_request`), `invalid_cursor`, `limit` (`invalid_request`).
 *
 * **Ids.** A conversation is named `<conversation key>~<the runtime's id>` (`qualify`), split on the
 * last `~` (the runtime's ids hold none): the directory's ref, and on Cloudflare where its object is
 * (each numbers its own conversations from `1`). A client treats every id as opaque.
 */

import type { AppContext } from "@pikit/core";
import {
  type ConversationDirectory,
  DIRECTORY_PAGE_DEFAULT,
  type DirectoryEntry,
  DirectoryError,
  type EntryRef,
  type EntryState,
  type PageRequest,
  type Viewer,
} from "@pikit/contracts";
import type {
  ApiAbortResponse,
  ApiAgents,
  ApiApp,
  ApiCommandResponse,
  ApiCommands,
  ApiConversation,
  ApiEvent,
  ApiListState,
  ApiPage,
  ApiResetResponse,
  ApiSendResponse,
  ApiStartResponse,
  ApiStateResponse,
  ApiTranscriptEntry,
  ApiUsage,
} from "./api.ts";
import { type ConversationHost, type HostRef, type Message, NOT_FOUND, type NewConversation, refusal } from "./host.ts";

export { DASHBOARD_CHANNEL, type Message, NOT_FOUND, type NewConversation, refusal } from "./host.ts";

/** Which conversations a list shows: one bucket (`listed` by default), and those a search finds. */
export interface ConversationFilter {
  state?: ApiListState;
  q?: string;
}

/** What an action did, and to which key (for the operator's log line). */
export type Sent = ApiSendResponse & { key: string };
export type Aborted = ApiAbortResponse & { key: string };
export type Commanded = ApiCommandResponse & { key: string };

export interface AdminBackend {
  app(ctx: AppContext): Promise<ApiApp>;
  agents(ctx: AppContext): Promise<ApiAgents>;
  /** A page of the bucket asked, as `operator` sees it. Throws `invalid_cursor` for a cursor it did not give. */
  conversations(page: PageRequest, operator: string, ctx: AppContext, filter?: ConversationFilter): Promise<ApiPage<ApiConversation>>;
  /** Throws `not_found`. */
  conversation(id: string, operator: string, ctx: AppContext): Promise<ApiConversation>;
  /** Its title for everyone, `title` cleaned. Throws `invalid_request` (nothing left once cleaned), `not_found`. */
  rename(id: string, title: string, operator: string, ctx: AppContext): Promise<ApiConversation>;
  /** Its state for everyone: archived, deleted, or listed again. Throws `not_found`. */
  setState(id: string, state: EntryState, operator: string, ctx: AppContext): Promise<ApiStateResponse>;
  /** Hidden for `operator`, or shown again. Throws `not_found`. */
  hide(id: string, hidden: boolean, operator: string, ctx: AppContext): Promise<ApiStateResponse>;
  /** A conversation of the dashboard's own, with its first message. Throws `unknown_agent`, `invalid_request`. */
  start(conversation: NewConversation, ctx: AppContext): Promise<ApiStartResponse>;
  transcript(id: string, page: PageRequest, ctx: AppContext): Promise<ApiPage<ApiTranscriptEntry>>;
  live(id: string, ctx: AppContext): Promise<AsyncIterable<ApiEvent>>;
  usage(id: string, ctx: AppContext): Promise<ApiUsage>;
  /** The actions reach only a key's current conversation (`host.ts`). */
  send(id: string, message: Message, ctx: AppContext): Promise<Sent>;
  abort(id: string, ctx: AppContext): Promise<Aborted>;
  reset(id: string, ctx: AppContext): Promise<ApiResetResponse>;
  commands(ctx: AppContext): Promise<ApiCommands>;
  command(id: string, name: string, args: string, ctx: AppContext): Promise<Commanded>;
}

/** Splits a qualified id on its last `~`. */
const QUALIFIED = /^(.+)~([^~]+)$/s;

/** The API's id of `key`'s conversation `local` (`telegram:1~2`). */
export function qualify(key: string, local: string): string {
  return `${key}~${local}`;
}

/** The key and the runtime's id a qualified id names; `undefined` when it is not one. */
export function unqualify(id: string): { key: string; local: string } | undefined {
  const match = QUALIFIED.exec(id);
  return match === null ? undefined : { key: match[1] as string, local: match[2] as string };
}

/** The directory's refusal as the API's: its code, the same message. Any other error as it is. */
function fromDirectory(error: unknown): unknown {
  if (!(error instanceof DirectoryError)) return error;
  const code = ({ not_found: "not_found", forbidden: "forbidden", invalid: "invalid_request", invalid_cursor: "invalid_cursor", limit: "invalid_request" } as const)[error.code];
  return refusal(code, error.message);
}

export interface AdminBackendOptions {
  /** Where the conversations are. */
  host(): ConversationHost;
  directory(): ConversationDirectory;
  /** The most conversations a page reads (`DIRECTORY_PAGE_MAX` at most). */
  pageMax: number;
}

export function createAdminBackend(options: AdminBackendOptions): AdminBackend {
  const host = () => options.host();
  const viewer = (operator: string): Viewer => ({ kind: "operator", id: operator });
  /** A directory call, its refusals the API's. */
  const directory = async <T>(call: (directory: ConversationDirectory) => Promise<T>): Promise<T> => {
    try {
      return await call(options.directory());
    } catch (error) {
      throw fromDirectory(error);
    }
  };

  /** The conversation `id` names; a malformed id names none. */
  const target = (id: string): HostRef => {
    const found = unqualify(id);
    if (found === undefined) throw refusal("not_found", NOT_FOUND);
    return { key: found.key, conversationId: found.local };
  };

  /** The conversation where it is, named for the routes, with what the directory holds of it. */
  const shown = (ref: HostRef, conversation: ApiConversation, entry: DirectoryEntry | undefined): ApiConversation => ({
    ...conversation,
    conversationId: qualify(ref.key, ref.conversationId),
    ...(conversation.currentId !== undefined && { currentId: qualify(ref.key, conversation.currentId) }),
    ...(entry !== undefined && {
      // 0: no activity yet (a reset's new one), the runtime's newest message stands.
      ...(entry.lastActivity > 0 && { lastActivity: entry.lastActivity }),
      state: entry.state,
      hidden: entry.mine?.hidden === true,
      ...(entry.title !== undefined && { title: entry.title }),
    }),
  });

  const stateOf = (entry: DirectoryEntry): ApiStateResponse => ({ conversationId: qualify(entry.key, entry.conversationId), state: entry.state, hidden: entry.mine?.hidden === true });

  /** The conversation where it is, with the directory's entry (`undefined` when it holds none yet). */
  const read = async (ref: HostRef, operator: string, ctx: AppContext): Promise<ApiConversation> => {
    const [conversation, entry] = await Promise.all([host().conversation(ref, ctx), directory((each) => each.access(viewer(operator), ref, ctx))]);
    return shown(ref, conversation, entry);
  };

  return {
    app: (ctx) => host().app(ctx),

    agents: (ctx) => host().agents(ctx),

    commands: (ctx) => host().commands(ctx),

    async conversations(page, operator, ctx, { state = "listed", q } = {}) {
      const limit = Math.min(page.limit ?? DIRECTORY_PAGE_DEFAULT, options.pageMax);
      const listed = await directory((each) => each.list(viewer(operator), { limit, state, ...(q !== undefined && { q }), ...(page.cursor !== undefined && { cursor: page.cursor }) }, ctx));
      const found = await Promise.all(
        listed.items.map(async (entry) => {
          const ref: EntryRef = { key: entry.key, conversationId: entry.conversationId };
          try {
            return shown(ref, await host().conversation(ref, ctx), entry);
          } catch (error) {
            ctx.logger.warn("admin-api: a listed conversation could not be read where it is; it is left out of the list", {
              conversation: entry.key,
              error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }
        }),
      );
      return { items: found.filter((each) => each !== undefined), ...(listed.next !== undefined && { next: listed.next }) };
    },

    conversation: (id, operator, ctx) => read(target(id), operator, ctx),

    async rename(id, title, operator, ctx) {
      const ref = target(id);
      const entry = await directory((each) => each.rename(viewer(operator), ref, title, ctx));
      return shown(ref, await host().conversation(ref, ctx), entry);
    },

    setState: async (id, state, operator, ctx) => stateOf(await directory((each) => each.setState(viewer(operator), target(id), state, ctx))),

    hide: async (id, hidden, operator, ctx) => stateOf(await directory((each) => each.mine(viewer(operator), target(id), { hidden }, ctx))),

    async start(message, ctx) {
      const started = await host().start(message, ctx);
      // Its first title: the operator's words, as written (not the note the agent reads before them).
      if (started.admission !== "duplicate") {
        await directory((each) => each.title({ key: started.key, conversationId: started.conversationId }, { text: message.text, source: "first" }, ctx)).catch((error: unknown) =>
          ctx.logger.warn("admin-api: the directory did not take a new conversation's first title; a model titles it", {
            conversation: started.key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return { ...started, conversationId: qualify(started.key, started.conversationId) };
    },

    transcript: (id, page, ctx) => host().transcript(target(id), page, ctx),

    live: (id, ctx) => host().live(target(id), ctx),

    usage: (id, ctx) => host().usage(target(id), ctx),

    async send(id, message, ctx) {
      const ref = target(id);
      const sent = await host().send(ref, message, ctx);
      return { key: ref.key, requestId: sent.requestId, admission: sent.admission };
    },

    async abort(id, ctx) {
      const ref = target(id);
      await host().abort(ref, ctx);
      return { key: ref.key, conversationId: id };
    },

    async reset(id, ctx) {
      const ref = target(id);
      const reset = await host().reset(ref, ctx);
      return { key: ref.key, previousConversationId: qualify(ref.key, reset.previousConversationId), conversationId: qualify(ref.key, reset.conversationId) };
    },

    async command(id, name, args, ctx) {
      const ref = target(id);
      const answer = await host().command(ref, name, args, ctx);
      return { key: ref.key, ...(typeof answer.text === "string" && { text: answer.text }) };
    },
  };
}
