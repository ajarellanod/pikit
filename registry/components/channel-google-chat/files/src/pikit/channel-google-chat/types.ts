// Owner: skeleton (shared). The interfaces between this component's modules; change one only with every module that uses it.
/**
 * Who calls whom:
 *
 *   route.ts (ingress)  ──verify (token.ts)──key (key.ts)──▶  EventSink
 *     EventSink, on a server: in process, index.ts's `receive`/`clickOf`
 *     EventSink, on Cloudflare: actor.mailbox (`google-chat.event` send, `google-chat.click` call) to
 *       the conversation's object, whose actor.inbox handlers are the same `receive`/`clickOf`
 *   receive ──▶ handler.ts (admission): EventHandler (attachments.ts, quote.ts, key.ts's AnswerTargets)
 *   clickOf ──▶ click.ts (questions): ClickHandler (QuestionRecords)
 *   startAnswerDelivery ──▶ transport.ts (ChannelTransport: format.ts, ids.ts, question-cards.ts)
 *   agent.started / agent.partial / agent.settled ──▶ placeholder.ts (Placeholders)
 *   every call to Google ──▶ api.ts (ChatApi, with auth.ts's AccessTokens)
 *
 * **`storage.kv`**: one namespace, the component's (`NAME`), shared. Each module writes under its own
 * prefix, and only there: `answers-cursor`, `piece:`, `answer:` (startAnswerDelivery's own),
 * `thread:` (key.ts, AnswerTargets), `space:` (key.ts, the threading state cache), `placeholder:` /
 * `placeholders` (placeholder.ts), `question:` (click.ts, QuestionRecords), `attachment:` (attachments.ts,
 * if it needs any).
 */

import type { AppContext, Clock } from "@pikit/core";
import type { AgentResult, AgentRuntime, ConversationRef, ConversationRegistry, KeyValueStore, QuestionPart } from "@pikit/contracts";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import type { AddOnEvent, AddOnResponse, CardWithId, ChatMessage, ChatSpace } from "./event.ts";
import type { ConversationMode, Credentials, Instance } from "./instance.ts";

/** The `actor.mailbox` type of an event the Worker hands to a conversation's object (`send`). */
export const EVENT_TYPE = "google-chat.event";
/** The `actor.mailbox` type of a click the Worker asks a conversation's object to answer (`call`). */
export const CLICK_TYPE = "google-chat.click";

// ---------------------------------------------------------------------------------------------------
// Google's REST API (api.ts, auth.ts)

/** An access token for the Chat API, as the service account (`chat.bot` scope), kept until it expires. */
export interface AccessTokens {
  /** A token valid for a minute at least; signs and exchanges a new JWT when the one kept expires. Rejects with a `ChatApiError`. */
  token(signal?: AbortSignal): Promise<string>;
}

export interface CreateMessageOptions {
  /** The thread to answer in (`spaces/AAA/threads/BBB`), sent with `messageReplyOption: REPLY_MESSAGE_OR_FAIL`; absent: the top of the chat. */
  thread?: string;
  /** Google's `requestId`: a repeat with the same one returns the first message (`ids.ts`). */
  requestId?: string;
  /** Google's `messageId` (`client-…`): the message's name is `<space>/messages/<messageId>`; a second create with it is refused (`ALREADY_EXISTS`). */
  messageId?: string;
}

/** The fields `updateMessage` changes (its `updateMask`). */
export type MessageField = "text" | "cardsV2";

/**
 * The Chat REST API, as the app's service account. Every method rejects with a `ChatApiError` (an
 * HTTP error with Google's status, a network error, a timeout), never another error.
 */
export interface ChatApi {
  /** `spaces.messages.create` in `space` (`spaces/AAA`). */
  createMessage(space: string, message: ChatMessage, options: CreateMessageOptions, signal?: AbortSignal): Promise<ChatMessage>;
  /** `spaces.messages.patch` of `name` (`spaces/AAA/messages/BBB`, or `…/messages/client-…`): the fields in `fields` only. */
  updateMessage(name: string, message: ChatMessage, fields: readonly MessageField[], signal?: AbortSignal): Promise<ChatMessage>;
  /** `spaces.messages.delete` of `name`. */
  deleteMessage(name: string, signal?: AbortSignal): Promise<void>;
  /** `spaces.messages.get` of `name`: a message the app may read (its own, a quoted one). */
  getMessage(name: string, signal?: AbortSignal): Promise<ChatMessage>;
  /** `spaces.get` of `name` (`spaces/AAA`). */
  getSpace(name: string, signal?: AbortSignal): Promise<ChatSpace>;
  /**
   * `media.download` of an attachment's `attachmentDataRef.resourceName`: its bytes and type. Rejects
   * (status 413, `maybeSent: false`) as soon as more than `maxBytes` arrive, without reading the rest.
   */
  downloadMedia(resourceName: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string | undefined }>;
}

/** Why a call to Google failed. Its message is Google's words, never a credential or a message's text. */
export class ChatApiError extends Error {
  /** The HTTP status; 0 for a network error or a timeout. */
  readonly status: number;
  /** Google's `error.status` (`ALREADY_EXISTS`, `NOT_FOUND`, `PERMISSION_DENIED`), when it said one. */
  readonly code: string | undefined;
  /** A 429's `Retry-After`, in ms. */
  readonly retryAfterMs: number | undefined;
  /** The request may have reached Google (a timeout or a connection cut after it left). */
  readonly maybeSent: boolean;

  constructor(status: number, message: string, options: { code?: string; retryAfterMs?: number; maybeSent?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatApiError";
    this.status = status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.maybeSent = options.maybeSent ?? false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Ingress (route.ts, token.ts)

/** The claims of Google's ID token this channel checks. */
export interface IdTokenClaims {
  iss: string;
  aud: string;
  email: string;
  email_verified: boolean;
  exp: number;
  iat?: number;
  sub?: string;
}

/** What a verification says: the claims, or why the token is refused (logged, never sent back). */
export type Verification = { ok: true; claims: IdTokenClaims } | { ok: false; reason: string };

/** Checks an event's bearer token (token.ts). */
export interface IdTokenVerifier {
  /** `authorization` is the request's `Authorization` header (`Bearer <token>`), or `null`. Never throws for a bad token: `ok: false`. Rejects only when Google's keys cannot be fetched. */
  verify(authorization: string | null, signal?: AbortSignal): Promise<Verification>;
}

/** Google's signing keys (the JWKs at `jwksUrl`), fetched once and kept as their `Cache-Control` says; shared by every instance. */
export interface Jwks {
  /** The RS256 public key with `kid`, fetching the set again when it does not have it (at most once a minute). `undefined` when Google has none. */
  key(kid: string, signal?: AbortSignal): Promise<CryptoKey | undefined>;
}

/** Where the route hands what it verified and keyed: the handler in process (a server), or the conversation's object (`actor.mailbox`). */
export interface EventSink {
  /** A message, an add, a removal: resolves once handled (a message admitted). Rejects: the route answers 500, and Google sends it again. */
  event(key: string, event: AddOnEvent, ctx: AppContext): Promise<void>;
  /** A click or a form: the response Google shows (a card updated, a dialog). */
  click(key: string, event: AddOnEvent, ctx: AppContext): Promise<AddOnResponse>;
}

/**
 * The key of an event's conversation (key.ts), or `undefined` for an event that has none to hand to (a
 * payload this channel drops). Reads the `conversations` setting through `ModeOf`.
 */
export type KeyOf = (event: AddOnEvent, ctx: AppContext) => Promise<string | undefined>;

/** How `space` of the instance makes conversations now (the setting, else the config): index.ts reads it for key.ts. */
export type ModeOf = (space: string, ctx: AppContext) => Promise<ConversationMode>;

/** Whether a space has threads: the event's `spaceThreadingState`, else `spaces.get`'s, kept (key.ts). */
export interface SpaceThreading {
  /** `false` for `UNTHREADED_MESSAGES`; `true` otherwise, also when Google cannot be asked (logged). */
  threaded(space: ChatSpace, ctx: AppContext): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------
// Admission (handler.ts, key.ts, attachments.ts, quote.ts)

/** Where an answer goes: its space, and its thread (absent: the top of the chat, an unthreaded one). */
export interface AnswerTarget {
  space: string;
  thread?: string;
}

/**
 * Where each answer goes, by its key (`answerKey(conversation, requestId)`): a thread's conversation
 * says it in its key; a whole chat's keeps it in `storage.kv` (`thread:<answer key>`), written when the
 * message is admitted (key.ts).
 */
export interface AnswerTargets {
  /** Records the thread of the message whose answer is `answerKey` (absent: the top of the chat). Idempotent. */
  remember(answerKey: string, thread: string | undefined): Promise<void>;
  /** Where `answerKey`'s answer in the conversation `conversationKey` goes; `undefined` when the key is not this channel's. */
  of(conversationKey: string, answerKey: string): Promise<AnswerTarget | undefined>;
}

/** What became of one event in the handler: a message admitted, one already there, or anything else handled (an add, `/new`, a reply). */
export type HandledEvent = "admitted" | "duplicate" | "done";

/** Handles a message, an add or a removal of its conversation `key` (handler.ts). Resolves once a message is admitted (P5); rejects when it could not be. */
export type EventHandler = (key: string, event: AddOnEvent, ctx: AppContext) => Promise<HandledEvent>;

/** What the handler and the click handler read and write, per instance. */
export interface AdmissionDeps {
  instance: Instance;
  credentials: Credentials;
  api: ChatApi;
  targets: AnswerTargets;
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** The component's namespace of `storage.kv` (prefixes above). */
  store: KeyValueStore;
  /** Where other files go, when installed: the conversation's workspace, else `execution`, else nowhere (named as not read). */
  workspace: WorkspaceProvider | undefined;
  execution: ExecutionEnv | undefined;
  clock: Clock;
}

// ---------------------------------------------------------------------------------------------------
// Questions (question-cards.ts, click.ts)

/** One question the transport drew, by its id (`question:<id>` in `storage.kv`). */
export interface QuestionRecord {
  question: QuestionPart;
  /** The card's message (`spaces/AAA/messages/…`): what a click's response updates. */
  message: string;
  conversationKey: string;
  /** Once answered: who (`users/…`), when, and what was admitted. */
  answered?: { by: string; at: number; text: string };
}

export interface QuestionRecords {
  /** Records a question the transport sent as a card (`sent` again for the same id replaces nothing answered). */
  sent(record: Omit<QuestionRecord, "answered">): Promise<void>;
  get(questionId: string): Promise<QuestionRecord | undefined>;
  /** Marks it answered; `true` for the one call that did (each question is answered once). */
  answer(questionId: string, answered: NonNullable<QuestionRecord["answered"]>): Promise<boolean>;
}

/** Draws a question as a card whose buttons call `endpoint` (the app's endpoint URL, the audience) back (question-cards.ts). */
export type QuestionDrawer = (question: QuestionPart, endpoint: string) => CardWithId;

/** Answers a click or a form of its conversation `key` (click.ts): the response Google shows. */
export type ClickHandler = (key: string, event: AddOnEvent, ctx: AppContext) => Promise<AddOnResponse>;

// ---------------------------------------------------------------------------------------------------
// The placeholder (placeholder.ts)

/** A placeholder the channel created, kept until its answer replaced it or it was deleted. */
export interface PlaceholderMark {
  answerKey: string;
  /** The conversation's key: whose instance the placeholder is (the marks are shared by every instance). */
  conversationKey: string;
  conversationId: string;
  requestId: string;
  /** Its message: `spaces/AAA/messages/client-…`. */
  message: string;
  at: number;
}

/** The marks of the placeholders created and not settled (`placeholder:` in `storage.kv`): what the start-up sweep reads. */
export interface PlaceholderMarks {
  add(mark: PlaceholderMark): Promise<void>;
  remove(answerKey: string): Promise<void>;
  list(): Promise<PlaceholderMark[]>;
}

/** "Thinking…" where the answer goes, the answer as it is written, and what is left of it when nothing is sent. One per instance. */
export interface Placeholders {
  /** `agent.started` of a conversation of this instance (index.ts filters: never a dashboard request). */
  started(event: { conversation: ConversationRef; requestId: string; resumed: boolean }, ctx: AppContext): Promise<void>;
  /** `agent.partial`: the answer so far, shown at most every `previewEveryMs`. */
  partial(event: { conversation: ConversationRef; requestId: string; text: string }, ctx: AppContext): Promise<void>;
  /** `agent.settled` / `agent.failed`: a run with nothing to send deletes its placeholder; otherwise answer delivery replaces it. */
  settled(result: AgentResult, ctx: AppContext): Promise<void>;
  /** At start (a wakeup): deletes the placeholders whose request settled with nothing left to send. */
  sweep(ctx: AppContext): Promise<void>;
}
