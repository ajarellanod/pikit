/**
 * Outbound delivery: how an answer reaches a chat platform.
 *
 * - A channel knows its platform: it offers a `ChannelTransport` (split a text into pieces the
 *   platform takes, send one, classify a failure).
 * - `outbound.queue` knows delivery: it stores a message before sending it, sends each conversation's
 *   pieces in order, retries, and gives up (when, its provider says: `outbound-durable` only on a
 *   permanent failure or after 24 hours). `durable` means it survives the process.
 * - A channel attaches its transport to the queue while it runs (`attach` / `detach`). A keyed
 *   capability for transports would be a cycle: the queue would use the channels, and the channels
 *   the queue.
 * - A channel's answers reach either through `startAnswerDelivery` (`delivery.ts`): from
 *   `agent.submissions`' feed, enqueued when a queue is installed, else sent directly through the
 *   transport. What each path guarantees, and how they differ, is said once, in `delivery.ts`'s
 *   header ("Direct or queued").
 *
 * The guarantee is at-least-once. A piece whose send may have reached the platform (the process
 * died during it, a timeout) is sent again as a possible duplicate: an idempotent transport passes the
 * same key and the platform drops the copy; another marks it visibly. Losing an answer is worse
 * than receiving it twice.
 *
 * What an operator sees of it (the dashboard's Delivery, SPEC §5): `pending` lists the pieces not
 * settled yet (queued, being sent, waiting for a retry), and `receipts` the ones that settled. Where it
 * runs: in the App that holds the queue's records. On a server that is the one App and every piece; on
 * Cloudflare it is each conversation's Durable Object, which sees only its own.
 */

import type { ConversationRef } from "./agent.ts";
import type { Feed } from "./feed.ts";
import type { Page, PageRequest } from "./page.ts";
import type { MessagePart } from "./parts.ts";

/**
 * The key of a run's answer: `${conversationId}:${requestId}`, where `requestId` is the request that started
 * the run. Stable across retries and restarts, so a run resumed after a crash is not answered twice.
 *
 * One formula for everyone who names that answer: the channel that enqueues it (from `AgentResult`),
 * and whoever waits for its delivery, a tool included (from `CONVERSATION` and the request of the run
 * it runs in). Its receipts (`OutboundQueue.receipts`) carry
 * it as their `idempotencyKey`.
 */
export function answerKey(conversation: Pick<ConversationRef, "conversationId">, requestId: string): string {
  return `${conversation.conversationId}:${requestId}`;
}

/** One answer to deliver. */
export interface OutboundMessage {
  /** One per answer, stable across retries and restarts: `answerKey(...)` for a run's answer. Enqueued twice, sent once. */
  idempotencyKey: string;
  /** The channel instance whose transport sends it (`telegram`, `telegram:support`). */
  channel: string;
  /** The conversation it answers; only the channel that made the key reads it. */
  conversationKey: string;
  /** Markdown; empty when the message is only parts. */
  text: string;
  /**
   * What it carries besides its text, in order (`parts.ts`): the parts its transport draws go with its
   * last piece, every other one is folded into its text as its fallback (`messagePieces`).
   */
  parts?: readonly MessagePart[];
}

/** One piece of a message, as the transport sends it. */
export interface OutboundPiece {
  /** `${idempotencyKey}#${index}`: stable; an idempotent transport gives it to the platform as its key. */
  key: string;
  conversationKey: string;
  /** Empty only on a piece that carries parts and no text (a message of drawn parts alone). */
  text: string;
  /**
   * The message's parts this transport draws (`ChannelTransport.draws`), on its last piece only; the
   * others have none. The parts it does not draw are in the text, as their fallbacks.
   */
  parts?: readonly MessagePart[];
  /** It may have been sent before. A transport that is not idempotent marks it for the reader. */
  possibleDuplicate: boolean;
}

/** How a channel sends to its platform. */
export interface ChannelTransport {
  /** The platform drops a repeated send with the same key (Google Chat's `requestId`). */
  readonly idempotent: boolean;
  /**
   * The kinds of part it draws (`MessagePart.type`), which its `send` receives on a message's last
   * piece. Every other part reaches it folded into the text as its fallback. Absent: it draws none.
   */
  readonly draws?: readonly string[];
  /** `text` as pieces the platform accepts (length limits), in order. Never empty for a non-empty text. */
  split(text: string): string[];
  /**
   * Sends one piece; the platform's id for the message it created (what an edit or a delete needs).
   * A failure throws a `DeliveryError` that says what kind it is; any other error counts as
   * transient. `signal` aborts it when the queue or the channel stops.
   */
  send(piece: OutboundPiece, signal: AbortSignal): Promise<{ platformMessageId: string }>;
}

export type DeliveryErrorKind =
  /** Try again later: a network error, a 5xx. */
  | "transient"
  /** The platform asked to wait (`retryAfterMs`). Not a failure: it does not count as an attempt. */
  | "rate_limited"
  /** It will never work: the chat blocked the bot, the chat is gone, the request is invalid. */
  | "permanent";

/**
 * What a transport throws when a send fails. Its message is shown to an operator (`PendingPiece.lastError`,
 * an abandoned receipt's `reason`) and logged: the platform's words, never the piece's text or a credential.
 */
export class DeliveryError extends Error {
  readonly kind: DeliveryErrorKind;
  /** `rate_limited`: how long the platform asked to wait. */
  readonly retryAfterMs: number | undefined;
  /** The platform may have received it (a timeout after the request left): a retry is a possible duplicate. */
  readonly maybeSent: boolean;

  constructor(kind: DeliveryErrorKind, message: string, options: { retryAfterMs?: number; maybeSent?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DeliveryError";
    this.kind = kind;
    this.retryAfterMs = options.retryAfterMs;
    this.maybeSent = options.maybeSent ?? false;
  }
}

/** `outbound.queue`: stores answers before they are sent, and delivers them. */
export interface OutboundQueue {
  /**
   * Stores `message`, cut by its channel's transport as `messagePieces` cuts it (the parts it does not
   * draw folded into the text before the split, the ones it draws kept with the last piece, and sent
   * with it), and resolves once it is stored: delivery happens after. The same `idempotencyKey` again
   * changes nothing. Rejects when no transport is attached for `message.channel`.
   */
  enqueue(message: OutboundMessage): Promise<void>;
  /** A channel hands its transport while it runs; pending pieces for that channel start moving. */
  attach(channel: string, transport: ChannelTransport): void;
  /**
   * The channel stops: nothing more is sent through its transport. Resolves once its sends in flight
   * ended; `signal` (the channel's stop deadline) aborts them, and an aborted piece is sent again,
   * as a possible duplicate, once a transport is attached again.
   */
  detach(channel: string, signal?: AbortSignal): Promise<void>;
  /**
   * Every piece that settled, delivered or abandoned, in the order it settled (SPEC K3): one receipt
   * per piece, committed with its new state. Kept as long as the pieces are. What a component that
   * must not miss a delivery reads; `outbound.delivered` and `outbound.abandoned` are only notices.
   */
  readonly receipts: Feed<DeliveryReceipt>;
  /**
   * The pieces not settled yet, oldest stored first, a page at a time (`next` absent on the last page):
   * what an operator sees waiting. A view of now, not a feed: a piece that settles between two pages is
   * in neither, and is in `receipts` instead. Rejects a cursor this queue did not give.
   */
  pending(page: PageRequest): Promise<Page<PendingPiece>>;
}

/** One piece not settled yet. Never its text. */
export interface PendingPiece {
  /** The message's `idempotencyKey`: `answerKey(...)` for a run's answer. */
  idempotencyKey: string;
  /** Which of the message's pieces: 0 is the first. */
  index: number;
  channel: string;
  conversationKey: string;
  state:
    /** Stored, never tried yet. */
    | "queued"
    /** A send is in flight now. */
    | "sending"
    /** Tried before (it failed, was rate limited, or was cut short by a stop): waits to be sent again. */
    | "retrying";
  /** Sends tried, whatever came of them. */
  attempts: number;
  /**
   * Not tried before this time, on the app's clock: a retry's wait, a rate limit's. It may wait longer,
   * behind an earlier piece of its conversation or for its channel to attach a transport. Absent while sending.
   */
  nextAttemptAt?: number;
  /** Why its last try did not deliver it, short (`DeliveryError`'s kind and message); absent when none did. */
  lastError?: string;
  /** Its next send may repeat one that reached the platform: it goes out marked as a possible duplicate. */
  possibleDuplicate: boolean;
  /** When it was stored, on the app's clock. */
  storedAt: number;
}

/** What became of one piece. The answer it belongs to is `idempotencyKey`; its thread is in `conversationKey`. */
export interface DeliveryReceipt {
  /** The message's `idempotencyKey`: `answerKey(...)` for a run's answer. */
  idempotencyKey: string;
  /** Which of the message's pieces: 0 is the first. */
  index: number;
  channel: string;
  conversationKey: string;
  /** Sends tried, whatever came of them. */
  attempts: number;
  outcome:
    /** `platformMessageId` is what an edit, a delete or a reply to it needs. */
    | { kind: "delivered"; platformMessageId: string; possibleDuplicate: boolean }
    | { kind: "abandoned"; reason: string };
  /** When it settled, on the app's clock. */
  at: number;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "outbound.queue": OutboundQueue;
  }
}

declare module "@pikit/core" {
  interface AppEvents {
    /** A piece reached its platform. */
    "outbound.delivered": { channel: string; conversationKey: string; key: string; attempts: number; possibleDuplicate: boolean };
    /** A piece was given up: its error was permanent, or it was not delivered within the queue's maximum age. */
    "outbound.abandoned": { channel: string; conversationKey: string; key: string; attempts: number; reason: string };
  }
}
