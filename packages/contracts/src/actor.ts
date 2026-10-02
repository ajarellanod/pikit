/**
 * `actor.mailbox` and `actor.inbox` (SPEC §4.1, C2): how a channel reaches the actor that owns a
 * conversation without knowing where that actor runs. The channel sends; the actor handles.
 *
 * - **An actor is named by a key** (a conversation key, `"telegram:123"`). On a server every key's
 *   actor is the App itself (`mailbox-local`); on Cloudflare it is the Durable Object
 *   `idFromName(key)`, reached by RPC. The sender never names a process or an object.
 * - **A message has a type**, and the actor handles it with the handler registered for that type:
 *   the component that handles it `use`s `actor.inbox` and, in its `start`, calls
 *   `handle("telegram.update", handler)`. A type has one handler: registering it twice throws.
 *   Handlers are dropped when the App stops; the next App registers them again.
 * - **A message is JSON** (`JsonValue`). The handler gets a copy, as it would across an RPC: changing
 *   it changes nothing the sender holds, and a value that is not JSON (`undefined`, a function) is
 *   refused.
 *
 * What `send` promises is the channel's acknowledgement point: it resolves once the actor holds the
 * message durably (its handler resolved), and rejects otherwise, so the channel does not acknowledge
 * its platform and the platform delivers again. A rejection does not mean nothing happened: the
 * handler may have committed the message and failed to answer. Delivery is therefore at-least-once,
 * and a handler recognises a message it already holds (by an id inside the message: Telegram's
 * `update_id`, an HTTP `messageId`). A message whose type has no handler is rejected too, and nothing
 * is delivered: the platform delivers it again, and by then the actor's `start` has registered it.
 *
 * **A call asks the actor for an answer** (`call`, handled by `answer(type, handler)`): what the
 * Worker cannot read itself on Cloudflare, where a conversation's state is its Durable Object's (a
 * dashboard listing it, a person's memory, an approval's decision). The answer is JSON too, a copy. A
 * call is not a delivery: nothing is acknowledged by it and nothing retries it, so a handler that
 * changes state makes the change idempotent (its caller may call again after a rejection). Its
 * failures are typed (`ActorCallError`, with a `code`), so a caller can tell an actor that said no from
 * one it could not reach. Types of messages and of calls are apart: `handle` and `answer` may both
 * register a type, and `call` reaches only `answer`'s handler.
 *
 * Why handlers are registered by method, as `wakeups`' are, and not provided as a keyed capability:
 * a keyed capability makes its user depend on every provider, so the mailbox would start after every
 * handler's component and depend on everything that component uses. An actor's handler admits the
 * message to the runtime, and the runtime drives its runs with `wakeups`, which on Cloudflare the
 * same component as the mailbox provides (`platform-cloudflare`): a keyed `actor.inbox` made that a
 * dependency cycle. Registered by method, the provider depends on no handler: a handler's component
 * uses `actor.inbox` like any capability, and may also use `wakeups`, `actor.mailbox` or the runtime.
 *
 * Pi first: one Pi process runs a session; which process or object runs which conversation, and how
 * a message gets there, is what pikit adds (P1).
 */

import type { AppContext } from "@pikit/core";
import type { JsonValue } from "./json.ts";

export interface ActorMailbox {
  /**
   * Delivers `message` of `type` to the actor that owns `key`, and resolves once that actor's
   * `actor.inbox` handler for `type` resolved, that is once the actor holds it durably.
   *
   * Rejects, so the caller does not acknowledge its platform, when:
   * - no handler is registered for `type` where the actor runs (the error names the type and says
   *   which component to install);
   * - `key` is empty, or `message` is not JSON (nothing is delivered);
   * - the handler rejects, or the actor cannot be reached;
   * - `ctx` is cancelled before the handler resolved. The caller stops waiting; the handler, which
   *   has its own context, may still finish.
   *
   * Sends are not ordered and may be handled concurrently, even for one key: an actor that needs an
   * order keeps it in its own state.
   */
  send(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<void>;
  /**
   * Asks the actor that owns `key` for an answer: calls its `answer` handler for `type` with a copy
   * of `message`, and resolves with a copy of what the handler resolved with.
   *
   * Rejects with an `ActorCallError` whose `code` says why:
   * - `invalid`: `key` is empty, or `message` is not JSON (nothing is called);
   * - `no_handler`: no `answer` handler is registered for `type` where the actor runs (the message
   *   names the type);
   * - `cancelled`: `ctx` was cancelled first (a deadline: `withAbortSignal(AbortSignal.timeout(ms), …)`).
   *   The caller stops waiting; the handler, which has its own context, may still finish;
   * - `unreachable`: the actor could not be reached (its object failed to start, the network);
   * - the code of an `ActorCallError` the handler threw (its own refusal: `not_found`), or `failed`
   *   for any other error it threw or an answer that is not JSON. The message is the handler's.
   *
   * Not at-least-once and not deduplicated: a call that rejected may or may not have run.
   */
  call(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<JsonValue>;
}

/** The actor's side: where the handler of each type of message is registered. */
export interface ActorInbox {
  /**
   * Registers `handler` for the messages of `type`, until the App stops. Call it in the `start` of
   * the component that handles them. Throws when `type` already has a handler in this App (one
   * handler per type, the error names it) or is empty.
   */
  handle(type: string, handler: ActorInboxHandler): void;
  /**
   * Registers `handler` to answer the calls of `type` (`ActorMailbox.call`), until the App stops. Call
   * it in the `start` of the component that answers them. Throws when `type` already has an answer
   * handler in this App (the error names it) or is empty. Apart from `handle`'s: a type may have both.
   */
  answer(type: string, handler: ActorCallHandler): void;
}

/**
 * Handles one type of message for the actor `key`. Resolve once the message is durable (committed
 * to the actor's storage, admitted by its runtime); do the slow work (a run) after, not before, so
 * the sender's platform is acknowledged promptly. Reject when it could not be kept: the sender's
 * platform delivers again. Handle a message you already hold as a success.
 *
 * `ctx` is the handler's own: it carries the actor App's values, and its cancellation fires when the
 * actor's App stops, never when the sender stops waiting.
 */
export type ActorInboxHandler = (key: string, message: JsonValue, ctx: AppContext) => Promise<void>;

/**
 * Answers one type of call for the actor `key`: resolve with a JSON value. Throw an `ActorCallError`
 * to refuse with a code of yours (`not_found`); any other error reaches the caller as `failed`, with
 * its message. `ctx` is the handler's own, as `ActorInboxHandler`'s.
 */
export type ActorCallHandler = (key: string, message: JsonValue, ctx: AppContext) => Promise<JsonValue>;

/** Why a call failed: what `ActorMailbox.call` rejects with, and what a handler throws to refuse. */
export type ActorCallErrorCode = "invalid" | "no_handler" | "cancelled" | "unreachable" | "failed" | (string & {});

/**
 * A failed `call`. Only `code` and `message` cross to the caller (on Cloudflare, an RPC): a cause or
 * a stack stays where it was thrown.
 */
export class ActorCallError extends Error {
  readonly code: ActorCallErrorCode;

  constructor(code: ActorCallErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ActorCallError";
    this.code = code;
  }
}

/** What crosses from the actor to the caller of `call`: its answer, or why it has none. */
export type ActorCallOutcome = { ok: true; answer: JsonValue } | { ok: false; code: string; message: string };

/**
 * Runs `handler` for one call and says what came of it, as an outcome that crosses an RPC whole: the
 * answer as a JSON copy, a thrown `ActorCallError`'s code, `failed` otherwise. For providers, on the
 * actor's side.
 */
export async function answerCall(handler: ActorCallHandler, key: string, message: JsonValue, ctx: AppContext): Promise<ActorCallOutcome> {
  let answer: JsonValue;
  try {
    answer = await handler(key, message, ctx);
  } catch (error) {
    if (error instanceof ActorCallError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const text = JSON.stringify(answer) as string | undefined;
  if (text === undefined) return { ok: false, code: "failed", message: "the handler answered with something that is not JSON (undefined or a function)" };
  return { ok: true, answer: JSON.parse(text) as JsonValue };
}

/** The caller's side of `answerCall`: the answer, or the `ActorCallError` it stands for. For providers. */
export function callResult(outcome: ActorCallOutcome): JsonValue {
  if (outcome.ok) return outcome.answer;
  throw new ActorCallError(outcome.code, outcome.message);
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "actor.mailbox": ActorMailbox;
    "actor.inbox": ActorInbox;
  }
}
