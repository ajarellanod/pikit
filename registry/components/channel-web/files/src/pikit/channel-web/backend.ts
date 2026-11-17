/**
 * What the chat routes read and do, apart from where it is (`routes.ts` is written once, over this).
 * Every method takes a `ChatRef`, whose key the routes built with `keyOf` from the session's user: a
 * conversation of another user's is never named, and one this user does not have (never made, or
 * deleted from their list) is `not_found`, as is any whose row is not this user's.
 *
 * - **`createLocalBackend`**: the contracts of the App it runs in and the channel's store. On a server
 *   that is every conversation; in a Cloudflare Durable Object, that object's own (its answers to the
 *   Worker's calls, `calls.ts`).
 * - **`createRemoteBackend`** (`remote.ts`): the Worker's, a call to the conversation's object, and to
 *   the accounts actor for the list.
 *
 * **A message** goes through `admitInbound` (`inbound.normalize`, `route.resolve`, the conversation,
 * `dispatch`), its sender `{ channel: "web", id: <user id> }`, its images with it. Its other files
 * (`files`) are written to the conversation's workspace in `beforeDispatch` (`@pikit/pi-adapter`'s
 * `writeAttachments`, `LocalContracts.files`): `attachments/<request id>/<safe name>`, the same paths
 * when the page sends it again; the agent's text names them, or says why one was not kept (no
 * workspace). A write that fails refuses the message (nothing dispatched, nothing stored: `503`, the
 * page sends it again). Admitted (or a duplicate: a retry), it is stored as the user's, its files'
 * names alone, `pending` (held while a run goes, `store.ts`);
 * refused, nothing is stored and the refusal is the route's status. A new conversation is made by its
 * first message admitted: one whose first message is refused does not exist. A new conversation with
 * an `agent` (one the user picked, checked by the route) is made with it in the registry before
 * (`conversations.registry.resolve`): routing still allows or denies the message, and a key keeps the
 * agent it was made with.
 *
 * **A project** is the project store's (`projects`, `project-routes.ts`): the routes check who may make
 * a conversation in one and give its space (`FirstMessage.space`, `Project.space`), with which the
 * conversation is admitted, recorded with the key's first resolve, for good; one of no project is in
 * its user's personal space (`personalSpace`: their memory and saved files, shared by their chats of no
 * project). The index lists a project's conversations, every member's, and counts them
 * (`createIndex`); it carries over the projects this channel kept itself before (`migrateProjects`).
 *
 * **A command** typed in a chat (`LocalContracts.commands`, `commandOf`) claims its request id before it
 * runs (`claimCommand`), then goes through `admitInbound` with the commands: routed like any message,
 * run in its conversation, never dispatched nor stored in the transcript. Sent again with the same
 * request id it is a `duplicate` that says what came of it (or `unfinished`): it runs at most once.
 *
 * **The transcript and the live events** are what the store and the runtime hold, every entry and run
 * the user's (`entries.ts`, `live.ts`): the routes cut them by the operator's policy (`visibility.ts`).
 *
 * A refusal is an `ActorCallError` whose code the routes answer with (`routes.ts`); it crosses a call
 * from an object to the Worker whole.
 */

import type { AppContext } from "@pikit/core";
import { type AttachmentTargets, AttachmentTooLarge, collectAttachments, type CollectedAttachments, writeAttachments } from "@pikit/pi-adapter";
import {
  ActorCallError,
  admitInbound,
  type AgentObserver,
  type AgentRuntime,
  type AgentSubmissions,
  type CommandLookup,
  type CommandOutcome,
  commandOf,
  type ConversationRegistry,
  type InboundOutcome,
  type ProjectStore,
} from "@pikit/contracts";
import {
  type ChatCommandResult,
  type ChatConversation,
  type ChatEvent,
  type ChatFile,
  type ChatImage,
  type ChatPage,
  type ChatSendResponse,
  type ChatTranscriptEntry,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./api.ts";
import { base64Bytes, CHANNEL, filesBytesOf, filesProblem, firstTitle, imagesProblem, personalSpace, projectSpace } from "./chat.ts";
import { userEntryOf } from "./entries.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, ConversationRow, EntryRow, ListQuery, MessageState } from "./store.ts";

/** A user's conversation, as the routes name it: the key is `keyOf(userId, chatId)`. JSON. */
export type ChatRef = { userId: string; chatId: string; key: string };

/** A user's message, checked by the route. JSON. */
export type NewMessage = { text: string; images?: ChatImage[]; files?: ChatFile[]; requestId: string };

/**
 * A conversation's first message, the agent it is made with (one the route allowed) and the project it
 * is made in with that project's space (`Project.space`: the route checked the user is a member). JSON.
 */
export type FirstMessage = NewMessage & { agent?: string; project?: string; space?: string };

/** One of a project's conversations, any member's: whose it is. */
export type ProjectConversation = ChatConversation & { userId: string };

/** The users' index: their conversations' list, and every project's. On a server the App's store; on Cloudflare the accounts actor's. */
export interface ChatIndex {
  /** The user's conversations, newest activity first (with `q`, those whose title holds it; with `project`, that project's, `""`: of none: the route checked the user is a member). Throws `invalid_cursor`. */
  list(userId: string, query: ListQuery, ctx: AppContext): Promise<ChatPage<ChatConversation>>;
  /** Every user's conversations (not deleted) of project `id`, newest activity first: the route checked the caller is a member. Throws `invalid_cursor`. */
  projectConversations(id: string, page: { limit: number; cursor?: string }, ctx: AppContext): Promise<ChatPage<ProjectConversation>>;
  /** Whose the conversation `chatId` of project `id` is; `not_found` when it is no conversation of it (or a deleted one). */
  projectConversation(id: string, chatId: string, ctx: AppContext): Promise<{ userId: string }>;
  /** How many conversations (not deleted) each of the projects `ids` has. */
  projectChats(ids: readonly string[], ctx: AppContext): Promise<Record<string, number>>;
  /**
   * The projects this channel kept itself (its former table, `channel_web_projects`) carried over to the
   * project store, once: each with its id, its space (`web:<user>:project:<id>`, so its chats keep their
   * memory and files), its name and its user as owner, by a trusted call; then the table goes. Idempotent:
   * a project the store has already is left as it is. Without a project store, nothing moves. How many it made.
   */
  migrateProjects(ctx: AppContext): Promise<number>;
}

export interface ChatBackend extends ChatIndex {
  /**
   * A new conversation, with its first message (in its project's space, when it has one). Throws the
   * admission's refusals (`denied`, `rejected`, `no_route`), `invalid_request`, `too_large`.
   */
  start(ref: ChatRef, message: FirstMessage, ctx: AppContext): Promise<ChatSendResponse>;
  /** Throws `not_found`. */
  conversation(ref: ChatRef, ctx: AppContext): Promise<ChatConversation>;
  rename(ref: ChatRef, title: string, ctx: AppContext): Promise<ChatConversation>;
  /** Archives it (`true`: listed apart) or puts it back in the list (`false`). Throws `not_found`. */
  archive(ref: ChatRef, archived: boolean, ctx: AppContext): Promise<ChatConversation>;
  /** Out of the user's list, and gone for them: nothing of the runtime's is deleted. */
  hide(ref: ChatRef, ctx: AppContext): Promise<void>;
  /** Newest first, every message as stored (the routes cut them by the policy). Throws `not_found`, `invalid_cursor`. */
  transcript(ref: ChatRef, page: { limit: number; cursor?: string }, ctx: AppContext): Promise<ChatPage<ChatTranscriptEntry>>;
  /** Image `index` of the user's message `messageId` (its request id). Throws `not_found`. */
  image(ref: ChatRef, messageId: string, index: number, ctx: AppContext): Promise<ChatImage>;
  /** Throws `not_found` and the admission's refusals. */
  send(ref: ChatRef, message: NewMessage, ctx: AppContext): Promise<ChatSendResponse>;
  /** The live events (`live.ts`), a `live` with the whole value first, until `ctx` is cancelled. Throws `not_found` before the first. */
  live(ref: ChatRef, ctx: AppContext): Promise<AsyncIterable<ChatEvent>>;
  /** Stops the run going, if one does. Throws `not_found`. */
  abort(ref: ChatRef, ctx: AppContext): Promise<void>;
  /** The user's conversations leave the list (the user was removed). */
  forget(userId: string, ctx: AppContext): Promise<void>;
}

export type RefusalCode = "not_found" | "invalid_request" | "invalid_cursor" | "too_large" | "denied" | "rejected" | "no_route" | "not_empty" | "forbidden";

export const refusal = (code: RefusalCode, message: string): ActorCallError => new ActorCallError(code, message);
export const NOT_FOUND = "no such conversation";
export const NO_PROJECT = "no such project";

export interface LocalContracts {
  store: ChatStore;
  conversations(): ConversationRegistry;
  runtime(): AgentRuntime;
  observe(): AgentObserver;
  submissions(): AgentSubmissions;
  /** Where the conversations are, for the image limits (`imagesProblem`): `server`, or `durable` in a Durable Object (by `actor.inbox`'s scope). */
  limits(): "server" | "durable";
  /** A conversation's row changed: tell the users' index (on a server it is the same table: nothing to do). Never rejects. */
  changed(row: ConversationRow, ctx: AppContext): Promise<void>;
  /** A message was admitted: answers may be due soon. */
  wake(ctx: AppContext): Promise<void>;
  /** The commands users may type in a chat (`agent.command`, cut by the config's `commands`). Absent: none, every message goes to the agent. */
  commands?(): CommandLookup;
  /** Where a message's files are written (`workspace`, else `execution`). Absent, or neither installed: each is named to the agent as not kept. */
  files?(): AttachmentTargets;
  /** The App's project store, when there is one: the index's migration (`migrateProjects`). */
  projects?(): ProjectStore | undefined;
  /** The titles (`titles.ts`): a new conversation's first title, a user's rename. Absent: the row's title alone. */
  titles?: {
    creating(key: string, title: string): () => void;
    renaming(key: string): Promise<void>;
    renamed(key: string, title: string, ctx: AppContext): Promise<void>;
  };
}

/** A file the page sent, as the shared protocol takes it: its bytes are in the message already. */
const sourceOf = (file: ChatFile) => ({
  name: file.name,
  contentType: file.mimeType,
  async download(most: number) {
    if (base64Bytes(file.data) > most) throw new AttachmentTooLarge();
    return { bytes: Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)), contentType: file.mimeType };
  },
});

/** What a message without files (or a command) brings. */
const NO_FILES: CollectedAttachments = { images: [], text: "", files: [] };

const STATE_OF: Record<string, MessageState> = { completed: "answered", aborted: "aborted", failed: "failed" };
/** The state a run's end gives the user's messages it took. */
export const stateOf = (kind: string): MessageState => STATE_OF[kind] ?? "failed";

/** A row as the API says it. */
export const conversationOf = (row: ConversationRow, busy = row.busy): ChatConversation => ({
  id: row.chatId,
  title: row.title,
  busy,
  archived: row.archived,
  lastActivity: row.lastActivity,
  createdAt: row.createdAt,
  ...(row.agent !== "" && { agent: row.agent }),
  ...(row.project !== "" && { project: row.project }),
});

/** What a command came to, as the page is told it. */
const commandResultOf = (name: string, outcome: CommandOutcome): ChatCommandResult =>
  outcome.kind === "ran"
    ? { name, outcome: "ran", ...(outcome.text !== undefined && { text: outcome.text }) }
    : { name, outcome: "failed", text: outcome.kind === "failed" ? outcome.message : `/${name} is not a command here` };

/** The title of a conversation whose first message was a command: nothing of it names the conversation. */
export const COMMAND_TITLE = "New conversation";

/** Who carries the former projects over: trusted code, the channel itself. */
export const MIGRATION_CALLER = { kind: "component", name: "channel-web" } as const;

/**
 * The users' index over `store` (its list): a server's, and the accounts actor's on Cloudflare. `projects`
 * is the App's project store, when there is one (the migration's).
 */
export function createIndex(store: ChatStore, projects: () => ProjectStore | undefined = () => undefined): ChatIndex {
  return {
    async list(userId, query) {
      const listed = await store.list(userId, query);
      return { items: listed.items.map((row) => conversationOf(row)), ...(listed.next !== undefined && { next: listed.next }) };
    },
    async projectConversations(id, page) {
      const listed = await store.listProject(id, page);
      return { items: listed.items.map((row) => ({ ...conversationOf(row), userId: row.userId })), ...(listed.next !== undefined && { next: listed.next }) };
    },
    async projectConversation(id, chatId) {
      const row = await store.projectConversation(id, chatId);
      if (row === undefined) throw refusal("not_found", NOT_FOUND);
      return { userId: row.userId };
    },
    async projectChats(ids) {
      return store.projectChats(ids);
    },
    async migrateProjects(ctx) {
      const target = projects();
      if (target === undefined) return 0;
      let made = 0;
      for (const row of await store.formerProjects()) {
        // Already carried over (a run cut after its create): as it is.
        if ((await target.locate(row.id, ctx)) === undefined) {
          try {
            await target.create({ id: row.id, space: projectSpace(row.userId, row.id), name: row.name, owner: { channel: CHANNEL, id: row.userId } }, MIGRATION_CALLER, ctx);
            made++;
          } catch (error) {
            // Its space has a project already (made by another run, or adopted): the space is what counts.
            if ((error as { code?: unknown }).code !== "space_taken") throw error;
          }
        }
        await store.dropFormerProject(row.userId, row.id);
      }
      await store.dropFormerProjects();
      if (made > 0) ctx.logger.info("channel-web: its former projects were carried over to the project store", { projects: made });
      return made;
    },
  };
}

/** A stored entry as the transcript says it (`entries.ts`): a user's message with its images by URL, a run's message as it wrote it. */
export const transcriptEntryOf = (chatId: string, row: EntryRow): ChatTranscriptEntry =>
  row.kind === "user" ? userEntryOf(chatId, row) : { id: row.id, kind: "message", messages: [row.message] };

/** The backend over the contracts of the App it runs in. */
export function createLocalBackend(contracts: LocalContracts): ChatBackend {
  const { store } = contracts;

  /** The row of `ref`, this user's and not deleted, or `not_found`. */
  const owned = async (ref: ChatRef): Promise<ConversationRow> => {
    const row = await store.conversation(ref.key);
    if (row === undefined || row.hidden || row.userId !== ref.userId || row.chatId !== ref.chatId) throw refusal("not_found", NOT_FOUND);
    return row;
  };

  /** Whether a run goes in the key's current conversation, by the runtime; the row's when it cannot say. */
  const busyOf = async (row: ConversationRow, ctx: AppContext): Promise<boolean> => {
    const current = await contracts.conversations().get(row.key, ctx);
    const observed = current === undefined ? undefined : await contracts.observe().conversation(current.conversationId, ctx);
    return observed?.busy ?? row.busy;
  };

  /** The messages held behind a run that ended unheard: in the transcript now, and told to who follows it live. */
  const releaseHeld = async (ref: ChatRef): Promise<void> => {
    for (const released of await store.release(ref.key)) store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, released) });
  };

  const refused = (outcome: Exclude<InboundOutcome, { kind: "admitted" | "duplicate" }>): ActorCallError => {
    if (outcome.kind === "denied") return refusal("denied", outcome.reason ?? "this assistant does not take your messages");
    if (outcome.kind === "halted") return refusal("rejected", outcome.reason);
    return refusal("no_route", "no agent answers here: the App has no router");
  };

  /**
   * `message` through the inbound path into `ref`'s conversation (in `space`, its project's or its
   * user's own: recorded with the key's first resolve); stored once admitted. `create` makes the conversation's row
   * then (its first message's title). A command typed (`commands`) runs instead, once by its request id
   * (`ranCommand`).
   */
  const admit = async (ref: ChatRef, message: NewMessage, { create, project, space }: { create: boolean; project: string; space?: string }, ctx: AppContext): Promise<ChatSendResponse> => {
    const images = message.images ?? [];
    const wrong = imagesProblem(images, contracts.limits());
    if (wrong !== undefined) throw refusal(wrong.status === 413 ? "too_large" : "invalid_request", wrong.message);
    const files = message.files ?? [];
    const wrongFiles = filesProblem(files, contracts.limits());
    if (wrongFiles !== undefined) throw refusal(wrongFiles.status === 413 ? "too_large" : "invalid_request", wrongFiles.message);
    // Before the admission: what its run writes is always later.
    const at = ctx.clock.now();
    // A command claims its request id first: sent again, it does not run again.
    const allowed = contracts.commands?.();
    const typed = allowed === undefined ? undefined : commandOf(message.text, allowed);
    if (typed !== undefined && !(await store.claimCommand(ref.key, message.requestId, typed.name, at))) {
      const prior = (await store.command(ref.key, message.requestId)) ?? { name: typed.name, outcome: "unfinished" };
      return { requestId: message.requestId, admission: "duplicate", command: prior };
    }
    // Every file written to the workspace, none shown inline: the agent reads them with its tools. A command is its text alone.
    const targets = contracts.files?.();
    const attached =
      typed !== undefined || files.length === 0
        ? NO_FILES
        : await collectAttachments(
            files.map(sourceOf),
            {
              messageId: message.requestId,
              limits: { perMessage: MAX_FILES, bytesEach: MAX_FILE_BYTES, bytesTotal: filesBytesOf(contracts.limits()) },
              canWrite: targets !== undefined && (targets.workspace !== undefined || targets.execution !== undefined),
              label: "channel-web",
            },
            ctx,
            ctx.abortSignal ?? new AbortController().signal,
          );
    const title = firstTitle(message.text, images.length);
    // A new conversation's title is the App's too (`/name`), given while its first message is dispatched.
    const forget = create ? contracts.titles?.creating(ref.key, title) : undefined;
    let inbound: InboundOutcome;
    try {
      inbound = await admitInbound(
        ctx,
        {
          id: message.requestId,
          channel: CHANNEL,
          conversationId: `${ref.userId}:${ref.chatId}`,
          actor: { id: ref.userId },
          text: [message.text, attached.text].filter((piece) => piece !== "").join("\n\n"),
          ...(images.length > 0 && { images }),
        },
        {
          conversations: contracts.conversations(),
          runtime: contracts.runtime(),
          key: ref.key,
          // A new conversation's space (its project's); the registry keeps the one it recorded first.
          ...(space !== undefined && { space }),
          // Only when this message claimed its id as a command: a stage that made one of another message runs none.
          ...(typed !== undefined && allowed !== undefined && { commands: allowed }),
          ...(attached.files.length > 0 && targets !== undefined && { beforeDispatch: (conversation) => writeAttachments(attached.files, conversation, targets, ctx, "channel-web") }),
        },
      );
    } catch (error) {
      if (typed !== undefined) await store.unclaimCommand(ref.key, message.requestId);
      throw error;
    } finally {
      forget?.();
    }
    const outcome = inbound;
    if (outcome.kind === "command") return ranCommand(ref, message.requestId, outcome.name, outcome.outcome, { create, project, agent: outcome.conversation.agent, at }, ctx);
    // Nothing ran: the claim goes (a stage refused it, or made it a message for the agent).
    if (typed !== undefined) await store.unclaimCommand(ref.key, message.requestId);
    if (outcome.kind !== "admitted" && outcome.kind !== "duplicate") throw refused(outcome);
    const admitted = outcome.kind === "admitted";
    const conversationId = outcome.conversation.conversationId;
    if (create) {
      await store.create({ key: ref.key, userId: ref.userId, chatId: ref.chatId, agent: outcome.conversation.agent, project, title, createdAt: at, lastActivity: at, busy: admitted });
    }
    // Waiting behind a run going: out of the transcript until that run's messages are in it.
    const held = admitted && outcome.admission.kind === "queued";
    // A duplicate stores it too: a retry after a crash between the admission and this write.
    const fileNames = typed === undefined ? files.map((file) => file.name) : [];
    const stored = await store.addUser(ref.key, { id: message.requestId, text: message.text, ...(images.length > 0 && { images }), ...(fileNames.length > 0 && { fileNames }), at, state: "pending", conversation: conversationId, held });
    if (stored && !held) {
      store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, { id: message.requestId, text: message.text, imageTypes: images.map((image) => image.mimeType), ...(fileNames.length > 0 && { fileNames }), at, state: "pending" }) });
    }
    if (stored || admitted) {
      // The live view first, before telling the index (on Cloudflare a call to another object, while the
      // run, in this object's alarm, may already go on).
      let row = await store.change(ref.key, { activity: at, ...(admitted && { busy: true }) });
      if (admitted && row !== undefined) row = await endedEarly(ref, message.requestId, conversationId, row, ctx);
      if (row !== undefined) await contracts.changed(row, ctx);
    }
    // The run it waited behind ended while it was stored: nothing holds it now.
    if (held && (await contracts.observe().conversation(conversationId, ctx))?.busy === false) await releaseHeld(ref);
    if (admitted) await contracts.wake(ctx);
    return { requestId: message.requestId, admission: outcome.kind === "duplicate" ? "duplicate" : outcome.admission.kind };
  };

  /**
   * A command ran as request `requestId`: what came of it kept by that id (a duplicate answers it), and
   * a new conversation made, empty (it ran there: in its project's space). Nothing was dispatched, and
   * nothing of it is in the transcript.
   */
  const ranCommand = async (
    ref: ChatRef,
    requestId: string,
    name: string,
    outcome: CommandOutcome,
    made: { create: boolean; project: string; agent: string; at: number },
    ctx: AppContext,
  ): Promise<ChatSendResponse> => {
    const command = commandResultOf(name, outcome);
    if (made.create) {
      const { at } = made;
      const row = await store.create({ key: ref.key, userId: ref.userId, chatId: ref.chatId, agent: made.agent, project: made.project, title: COMMAND_TITLE, createdAt: at, lastActivity: at, busy: false });
      await contracts.changed(row, ctx);
    }
    await store.commandRan(ref.key, requestId, command);
    return { requestId, admission: "command", command };
  };

  /**
   * A run can end before its admission returns (Pi announces a quick run's `agent.started` and its end
   * as `dispatch` returns), so its end's `busy: false` and its message's state came before the row and
   * the message were written: they are set again from `agent.submissions`. Then, once more, from a run
   * started since (`startedBy`, set before its `busy: true` is written): whichever comes last, the row
   * says what goes.
   */
  const endedEarly = async (ref: ChatRef, requestId: string, conversationId: string, row: ConversationRow, ctx: AppContext): Promise<ConversationRow> => {
    if (store.startedBy(conversationId) !== undefined) return row;
    const status = await contracts.submissions().get({ conversationId }, requestId, ctx);
    if (status?.kind !== "settled") return row;
    if ((await store.settle(ref.key, [requestId], stateOf(status.run.kind))).length > 0) store.notify(ref.key, { type: "changed" });
    let now = (await store.change(ref.key, { busy: false })) ?? row;
    if (store.startedBy(conversationId) !== undefined) now = (await store.change(ref.key, { busy: true })) ?? now;
    return now;
  };

  /**
   * The page's pending messages whose run ended while no event reached this App (K3): their state
   * from `agent.submissions`, written back, and told to who follows the conversation live.
   */
  const reconcile = async (ref: ChatRef, items: EntryRow[], ctx: AppContext): Promise<EntryRow[]> => {
    const settled = new Map<string, MessageState>();
    for (const item of items) {
      if (item.kind !== "user" || item.state !== "pending" || item.conversation === undefined) continue;
      const status = await contracts.submissions().get({ conversationId: item.conversation }, item.id, ctx);
      if (status?.kind === "settled") settled.set(item.id, stateOf(status.run.kind));
    }
    if (settled.size === 0) return items;
    let moved = 0;
    for (const [id, state] of settled) moved += (await store.settle(ref.key, [id], state)).length;
    if (moved > 0) store.notify(ref.key, { type: "changed" });
    return items.map((item) => (item.kind === "user" && settled.has(item.id) ? { ...item, state: settled.get(item.id) as MessageState } : item));
  };

  return {
    ...createIndex(store, () => contracts.projects?.()),

    async start(ref, { agent, project: picked, space: given, ...message }, ctx) {
      const row = await store.conversation(ref.key);
      // A retry of the same first message (its chat id is the request id's): the same conversation, in its project.
      if (row !== undefined && (row.hidden || row.userId !== ref.userId)) throw refusal("not_found", NOT_FOUND);
      const project = row?.project ?? picked ?? "";
      // The project's space, as the route found it, or the user's own for a chat of no project: recorded with the key's first resolve, for good.
      const space = project === "" ? personalSpace(ref.userId) : project === picked ? given : undefined;
      // Made with the agent picked: admitInbound's resolve then finds it, whatever the router names.
      if (row === undefined && agent !== undefined) {
        await contracts.conversations().resolve(ref.key, agent, { channel: CHANNEL, ...(space !== undefined && { space }) }, ctx);
      }
      return admit(ref, message, { create: row === undefined, project, ...(space !== undefined && { space }) }, ctx);
    },

    async conversation(ref, ctx) {
      const row = await owned(ref);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async rename(ref, title, ctx) {
      await owned(ref);
      // The user's from now on: no model titles it again.
      await contracts.titles?.renaming(ref.key);
      const row = (await store.change(ref.key, { title })) as ConversationRow;
      await contracts.changed(row, ctx);
      await contracts.titles?.renamed(ref.key, title, ctx);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async archive(ref, archived, ctx) {
      await owned(ref);
      const row = (await store.change(ref.key, { archived })) as ConversationRow;
      await contracts.changed(row, ctx);
      return conversationOf(row, await busyOf(row, ctx));
    },

    async hide(ref, ctx) {
      await owned(ref);
      const row = await store.change(ref.key, { hidden: true });
      if (row !== undefined) await contracts.changed(row, ctx);
    },

    async transcript(ref, page, ctx) {
      const row = await owned(ref);
      // A message held behind a run whose end this App never heard: nothing runs now, so nothing holds it.
      if (page.cursor === undefined && !(await busyOf(row, ctx))) await releaseHeld(ref);
      const read = await store.entries(ref.key, page);
      const items = await reconcile(ref, read.items, ctx);
      return { items: items.map((item) => transcriptEntryOf(ref.chatId, item)), ...(read.next !== undefined && { next: read.next }) };
    },

    async image(ref, messageId, index) {
      await owned(ref);
      const found = await store.image(ref.key, messageId, index);
      if (found === undefined) throw refusal("not_found", "no such image");
      return found;
    },

    async send(ref, message, ctx) {
      const row = await owned(ref);
      return admit(ref, message, { create: false, project: row.project }, ctx);
    },

    async live(ref, ctx) {
      await owned(ref);
      const current = await contracts.conversations().get(ref.key, ctx);
      return liveEvents({ observe: contracts.observe(), store, key: ref.key, conversationId: current?.conversationId }, ctx);
    },

    async abort(ref, ctx) {
      await owned(ref);
      const current = await contracts.conversations().get(ref.key, ctx);
      if (current !== undefined) await contracts.runtime().abort(current, ctx);
    },

    async forget(userId) {
      await store.forget(userId);
    },
  };
}
