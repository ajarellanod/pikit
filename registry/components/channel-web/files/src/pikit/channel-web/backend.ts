/**
 * What the chat routes do in the App that holds a conversation, apart from where it is (`routes.ts` is
 * written once, over this). Every method takes a `ChatRef`, whose key the routes built with `keyOf`
 * after `conversations.directory` let the session's user see it (`access`), or for the user's own key
 * that has no activity the directory shows yet (a new chat): the backend trusts the ref, and a key
 * `conversations.registry` never resolved is `not_found`. Which conversations exist, their titles,
 * their state for everyone and for each viewer are the directory's, never the backend's.
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
 * first message admitted, its owner the user (`{ channel: "web", id }`, recorded with the key's first
 * resolve: the directory's `owner`), its first message's text its first title (`title(first)`, as the
 * user wrote it; the directory cleans it, a model's or a rename's wins): one whose first message is
 * refused does not exist. A new conversation with an `agent` (one the user picked, checked by the
 * route) is made with it in the registry before (`conversations.registry.resolve`): routing still
 * allows or denies the message, and a key keeps the agent it was made with.
 *
 * **A project** is the project store's (`projects`, `project-routes.ts`): the routes check who may make
 * a conversation in one and give its space (`FirstMessage.space`, `Project.space`), with which the
 * conversation is admitted, recorded with the key's first resolve, for good; one of no project is in
 * its user's personal space (`personalSpace`: their memory and saved files, shared by their chats of no
 * project). The directory lists a project's conversations to its members (the space's grants of
 * `conversation.audience`); the backend carries over the projects this channel kept itself before
 * (`migrateProjects`, `createMigration`).
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
  type ConversationDirectory,
  type ConversationRegistry,
  type InboundOutcome,
  type ProjectStore,
} from "@pikit/contracts";
import {
  type ChatCommandResult,
  type ChatEvent,
  type ChatFile,
  type ChatImage,
  type ChatPage,
  type ChatSendResponse,
  type ChatTranscriptEntry,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./api.ts";
import { base64Bytes, CHANNEL, filesBytesOf, filesProblem, imagesProblem, personalSpace, projectSpace } from "./chat.ts";
import { userEntryOf } from "./entries.ts";
import { liveEvents } from "./live.ts";
import type { ChatStore, EntryRow, MessageState } from "./store.ts";

/** A user's conversation, as the routes name it: the key is `keyOf(userId, chatId)`. JSON. */
export type ChatRef = { userId: string; chatId: string; key: string };

/** A user's message, checked by the route. JSON. */
export type NewMessage = { text: string; images?: ChatImage[]; files?: ChatFile[]; requestId: string };

/**
 * A conversation's first message, the agent it is made with (one the route allowed) and the space of
 * the project it is made in (`Project.space`: the route checked the user is a member; absent: the
 * user's personal space). JSON.
 */
export type FirstMessage = NewMessage & { agent?: string; space?: string };

/** What the App that holds a conversation knows of it (the registry's record, the runtime's run), for a chat the directory does not show yet. JSON. */
export type LocalChat = { agent: string; space?: string; busy: boolean };

/** What the accounts actor does on Cloudflare (a server: the App): the former projects' migration. */
export interface ChatMigration {
  /**
   * The projects this channel kept itself (its former table, `channel_web_projects`) carried over to the
   * project store, once: each with its id, its space (`web:<user>:project:<id>`, so its chats keep their
   * memory and files), its name and its user as owner, by a trusted call; then the table goes. Idempotent:
   * a project the store has already is left as it is. Without a project store, nothing moves. How many it made.
   */
  migrateProjects(ctx: AppContext): Promise<number>;
}

export interface ChatBackend extends ChatMigration {
  /**
   * A new conversation, with its first message (in its project's space, when it has one). Throws the
   * admission's refusals (`denied`, `rejected`, `no_route`), `invalid_request`, `too_large`.
   */
  start(ref: ChatRef, message: FirstMessage, ctx: AppContext): Promise<ChatSendResponse>;
  /** Its agent and space as the registry recorded them, and whether a run goes. Throws `not_found` for a key never resolved. */
  conversation(ref: ChatRef, ctx: AppContext): Promise<LocalChat>;
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
}

export type RefusalCode = "not_found" | "invalid_request" | "invalid_cursor" | "too_large" | "denied" | "rejected" | "no_route" | "not_empty" | "forbidden";

export const refusal = (code: RefusalCode, message: string): ActorCallError => new ActorCallError(code, message);
export const NOT_FOUND = "no such conversation";
export const NO_PROJECT = "no such project";

export interface LocalContracts {
  store: ChatStore;
  conversations(): ConversationRegistry;
  /** Where a new conversation's first title goes (`title(first)`). */
  directory(): ConversationDirectory;
  runtime(): AgentRuntime;
  observe(): AgentObserver;
  submissions(): AgentSubmissions;
  /** Where the conversations are, for the image limits (`imagesProblem`): `server`, or `durable` in a Durable Object (by `actor.inbox`'s scope). */
  limits(): "server" | "durable";
  /** A message was admitted: answers may be due soon. */
  wake(ctx: AppContext): Promise<void>;
  /** The commands users may type in a chat (`agent.command`, cut by the config's `commands`). Absent: none, every message goes to the agent. */
  commands?(): CommandLookup;
  /** Where a message's files are written (`workspace`, else `execution`). Absent, or neither installed: each is named to the agent as not kept. */
  files?(): AttachmentTargets;
  /** The App's project store, when there is one: the migration (`migrateProjects`). */
  projects?(): ProjectStore | undefined;
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

/** What a command came to, as the page is told it. */
const commandResultOf = (name: string, outcome: CommandOutcome): ChatCommandResult =>
  outcome.kind === "ran"
    ? { name, outcome: "ran", ...(outcome.text !== undefined && { text: outcome.text }) }
    : { name, outcome: "failed", text: outcome.kind === "failed" ? outcome.message : `/${name} is not a command here` };

/** Who carries the former projects over: trusted code, the channel itself. */
export const MIGRATION_CALLER = { kind: "component", name: "channel-web" } as const;

/** The former projects' migration over `store`: a server's, and the accounts actor's on Cloudflare. `projects` is the App's project store, when there is one. */
export function createMigration(store: ChatStore, projects: () => ProjectStore | undefined = () => undefined): ChatMigration {
  return {
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

  /**
   * The key's conversation as the registry recorded it, or `not_found` for a key never resolved (no
   * chat of this user's) or started over since (`startOver`: deleted for everyone, reset).
   */
  const known = async (ref: ChatRef, ctx: AppContext) => {
    const current = await contracts.conversations().get(ref.key, ctx);
    if (current === undefined || (await store.startedOver(ref.key)) === current.conversationId) throw refusal("not_found", NOT_FOUND);
    return current;
  };

  /** Whether a run goes in conversation `conversationId`, by the runtime. */
  const busyOf = async (conversationId: string, ctx: AppContext): Promise<boolean> => (await contracts.observe().conversation(conversationId, ctx))?.busy === true;

  /** The messages held behind a run that ended unheard: in the transcript now, and told to who follows it live. */
  const releaseHeld = async (ref: ChatRef): Promise<void> => {
    for (const released of await store.release(ref.key)) store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, released) });
  };

  const refused = (outcome: Exclude<InboundOutcome, { kind: "admitted" | "duplicate" }>): ActorCallError => {
    if (outcome.kind === "denied") return refusal("denied", outcome.reason ?? "this assistant does not take your messages");
    if (outcome.kind === "halted") return refusal("rejected", outcome.reason);
    return refusal("no_route", "no agent answers here: the App has no router");
  };

  /** The conversation's owner, given with the key's first resolve: its user. */
  const ownerOf = (ref: ChatRef) => ({ channel: CHANNEL, id: ref.userId });

  /**
   * `message` through the inbound path into `ref`'s conversation (in `space`, its project's or its
   * user's own, and its owner the user: recorded with the key's first resolve); stored once admitted. A
   * command typed (`commands`) runs instead, once by its request id. `first`: the conversation's first
   * message, whose text is its first title (`title(first)`).
   */
  const admit = async (ref: ChatRef, message: NewMessage, { first, space }: { first: boolean; space?: string }, ctx: AppContext): Promise<ChatSendResponse> => {
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
          // A new conversation's space (its project's, else its user's) and owner; the registry keeps the ones it recorded first.
          ...(space !== undefined && { space }),
          owner: ownerOf(ref),
          // Only when this message claimed its id as a command: a stage that made one of another message runs none.
          ...(typed !== undefined && allowed !== undefined && { commands: allowed }),
          ...(attached.files.length > 0 && targets !== undefined && { beforeDispatch: (conversation) => writeAttachments(attached.files, conversation, targets, ctx, "channel-web") }),
        },
      );
    } catch (error) {
      if (typed !== undefined) await store.unclaimCommand(ref.key, message.requestId);
      throw error;
    }
    const outcome = inbound;
    // A chat again, if its key had started over (deleted for everyone): its first message made it.
    if (first && (outcome.kind === "command" || outcome.kind === "admitted" || outcome.kind === "duplicate")) await store.started(ref.key);
    if (outcome.kind === "command") {
      // Nothing dispatched, nothing in the transcript: what came of it kept by its request id (a duplicate answers it).
      const command = commandResultOf(outcome.name, outcome.outcome);
      await store.commandRan(ref.key, message.requestId, command);
      return { requestId: message.requestId, admission: "command", command };
    }
    // Nothing ran: the claim goes (a stage refused it, or made it a message for the agent).
    if (typed !== undefined) await store.unclaimCommand(ref.key, message.requestId);
    if (outcome.kind !== "admitted" && outcome.kind !== "duplicate") throw refused(outcome);
    const admitted = outcome.kind === "admitted";
    const conversationId = outcome.conversation.conversationId;
    // Its first title, as the user wrote it (a retry too: the directory keeps the highest source).
    if (first) await firstTitle({ key: ref.key, conversationId }, message.text, ctx);
    // Waiting behind a run going: out of the transcript until that run's messages are in it.
    const held = admitted && outcome.admission.kind === "queued";
    // A duplicate stores it too: a retry after a crash between the admission and this write.
    const fileNames = typed === undefined ? files.map((file) => file.name) : [];
    const stored = await store.addUser(ref.key, { id: message.requestId, text: message.text, ...(images.length > 0 && { images }), ...(fileNames.length > 0 && { fileNames }), at, state: "pending", conversation: conversationId, held });
    if (stored && !held) {
      store.notify(ref.key, { type: "entry", entry: userEntryOf(ref.chatId, { id: message.requestId, text: message.text, imageTypes: images.map((image) => image.mimeType), ...(fileNames.length > 0 && { fileNames }), at, state: "pending" }) });
    }
    if (admitted) await endedEarly(ref, message.requestId, conversationId, ctx);
    // The run it waited behind ended while it was stored: nothing holds it now.
    if (held && !(await busyOf(conversationId, ctx))) await releaseHeld(ref);
    if (admitted) await contracts.wake(ctx);
    return { requestId: message.requestId, admission: outcome.kind === "duplicate" ? "duplicate" : outcome.admission.kind };
  };

  /** `text` (a first message) as the conversation's first title; a failure is logged (the model titles it later), never the message's. */
  const firstTitle = async (ref: { key: string; conversationId: string }, text: string, ctx: AppContext): Promise<void> => {
    if (text.trim() === "") return;
    try {
      await contracts.directory().title(ref, { text, source: "first" }, ctx);
    } catch (error) {
      ctx.logger.warn("channel-web: a conversation's first title was not given to the directory; a model titles it after its first answer", {
        conversation: ref.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * A run can end before its admission returns (Pi announces a quick run's `agent.started` and its end
   * as `dispatch` returns), so its end's state for its message came before the message was written: it
   * is set again from `agent.submissions`, unless a run goes now (`startedBy`).
   */
  const endedEarly = async (ref: ChatRef, requestId: string, conversationId: string, ctx: AppContext): Promise<void> => {
    if (store.startedBy(conversationId) !== undefined) return;
    const status = await contracts.submissions().get({ conversationId }, requestId, ctx);
    if (status?.kind !== "settled") return;
    if ((await store.settle(ref.key, [requestId], stateOf(status.run.kind))).length > 0) store.notify(ref.key, { type: "changed" });
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
    ...createMigration(store, () => contracts.projects?.()),

    async start(ref, { agent, space: given, ...message }, ctx) {
      const current = await contracts.conversations().get(ref.key, ctx);
      // The project's space, as the route found it, or the user's own for a chat of no project: recorded with the key's first resolve, for good.
      const space = given ?? personalSpace(ref.userId);
      // Made with the agent picked: admitInbound's resolve then finds it, whatever the router names.
      if (current === undefined && agent !== undefined) await contracts.conversations().resolve(ref.key, agent, { channel: CHANNEL, space, owner: ownerOf(ref) }, ctx);
      return admit(ref, message, { first: true, space }, ctx);
    },

    async conversation(ref, ctx) {
      const current = await known(ref, ctx);
      return { agent: current.agent, ...(current.space !== undefined && { space: current.space }), busy: await busyOf(current.conversationId, ctx) };
    },

    async transcript(ref, page, ctx) {
      const current = await known(ref, ctx);
      // A message held behind a run whose end this App never heard: nothing runs now, so nothing holds it.
      if (page.cursor === undefined && !(await busyOf(current.conversationId, ctx))) await releaseHeld(ref);
      const read = await store.entries(ref.key, page);
      const items = await reconcile(ref, read.items, ctx);
      return { items: items.map((item) => transcriptEntryOf(ref.chatId, item)), ...(read.next !== undefined && { next: read.next }) };
    },

    async image(ref, messageId, index, ctx) {
      await known(ref, ctx);
      const found = await store.image(ref.key, messageId, index);
      if (found === undefined) throw refusal("not_found", "no such image");
      return found;
    },

    async send(ref, message, ctx) {
      await known(ref, ctx);
      return admit(ref, message, { first: false }, ctx);
    },

    async live(ref, ctx) {
      const current = await known(ref, ctx);
      return liveEvents({ observe: contracts.observe(), store, key: ref.key, conversationId: current.conversationId }, ctx);
    },

    async abort(ref, ctx) {
      const current = await known(ref, ctx);
      await contracts.runtime().abort(current, ctx);
    },
  };
}
