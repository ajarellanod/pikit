/**
 * Outbound delivery (SPEC §5, "Outbound delivery"): how an answer reaches a chat platform.
 *
 * - A channel knows its platform: it offers a `ChannelTransport` (split a text into pieces the
 *   platform takes, send one, classify a failure).
 * - `outbound.queue` knows delivery: it stores a message before sending it, sends each conversation's
 *   pieces in order, retries, and gives up. `durable` means it survives the process.
 * - A channel attaches its transport to the queue while it runs (`attach` / `detach`). A keyed
 *   capability for transports would be a cycle: the queue would use the channels, and the channels
 *   the queue. Without a queue, a channel sends through its own transport directly, best effort.
 *
 * The guarantee is at-least-once. A piece whose send may have reached the platform (the process
 * died during it, a timeout) is sent again as a possible duplicate: an idempotent transport passes the
 * same key and the platform drops the copy; another marks it visibly. Losing an answer is worse
 * than receiving it twice.
 */

/** One answer to deliver. */
export interface OutboundMessage {
  /** One per answer, stable across retries and restarts: `${sessionId}:${runId}`. Enqueued twice, sent once. */
  idempotencyKey: string;
  /** The channel instance whose transport sends it (`telegram`, `telegram:support`). */
  channel: string;
  /** The conversation it answers; only the channel that made the key reads it. */
  conversationKey: string;
  text: string;
}

/** One piece of a message, as the transport sends it. */
export interface OutboundPiece {
  /** `${idempotencyKey}#${index}`: stable; an idempotent transport gives it to the platform as its key. */
  key: string;
  conversationKey: string;
  text: string;
  /** It may have been sent before. A transport that is not idempotent marks it for the reader. */
  possibleDuplicate: boolean;
}

/** How a channel sends to its platform. */
export interface ChannelTransport {
  /** The platform drops a repeated send with the same key (Google Chat's `requestId`). */
  readonly idempotent: boolean;
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

/** What a transport throws when a send fails. */
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
   * Stores `message`, split by its channel's transport, and resolves once it is stored: delivery
   * happens after. The same `idempotencyKey` again changes nothing. Rejects when no transport is
   * attached for `message.channel`.
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
}

declare module "../capabilities.ts" {
  interface AppCapabilities {
    "outbound.queue": OutboundQueue;
  }
}

declare module "../events.ts" {
  interface AppEvents {
    /** A piece reached its platform. */
    "outbound.delivered": { channel: string; conversationKey: string; key: string; attempts: number; possibleDuplicate: boolean };
    /** A piece was given up: its error was permanent, it failed too often, or it waited too long. */
    "outbound.abandoned": { channel: string; conversationKey: string; key: string; attempts: number; reason: string };
  }
}
