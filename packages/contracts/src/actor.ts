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
 * **A stream asks the actor for answers as they come** (`stream`, handled by `answerStream(type,
 * handler)`): what the actor learns over time (a conversation's live events, read by the dashboard on
 * the Worker). It is a call whose answer is a sequence: refused as a call is, before the first value;
 * then each value, a JSON copy, in order, at the caller's pace; then its end, or an error with a code.
 * The caller closes it when it stops reading, and that closes the handler's. On Cloudflare it is one
 * RPC that returns a byte stream (`answerStream` and `streamResult` encode it), so a stream open keeps
 * the actor's object in memory: callers close the ones nobody reads.
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

import { type AppContext, withAbortSignal } from "@pikit/core";
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
  /**
   * Asks the actor that owns `key` for a stream of answers: calls its `answerStream` handler for
   * `type` with a copy of `message`, and resolves once the handler resolved with its stream. Rejects
   * as `call` does, with the same codes, and nothing is streamed.
   *
   * Then iterating it yields a JSON copy of each value the handler's stream yields, in order, read
   * only as the caller reads (an endless stream is never read to its end), and ends when that stream
   * ends. It throws an `ActorCallError`, and ends, when:
   * - the handler's stream threw: its `ActorCallError`'s code, or `failed` for any other error or a
   *   value that is not JSON;
   * - the actor stopped or could not be reached any more (`unreachable`): its App stopped, its
   *   object was evicted, the network;
   * - `ctx` was cancelled (`cancelled`).
   *
   * Closing it (`return()`, a `break` out of `for await`), or cancelling `ctx`, closes the handler's
   * stream (its `return()`) and cancels the handler's context. A caller closes a stream it no longer
   * reads: an open one keeps its actor's object in memory on Cloudflare.
   */
  stream(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<AsyncIterable<JsonValue>>;
}

/** The actor's side: where the handler of each type of message is registered. */
export interface ActorInbox {
  /**
   * Whose actor this App is: every key's (`"all"`: one App, so its storage holds every conversation;
   * `mailbox-local`), or one key's (`"one"`: an App per key, each with storage of its own; a Durable
   * Object, `platform-cloudflare`). A component whose state is shared by every key reads it, never
   * the target: with `"one"` that state lives in another actor, reached through `actor.mailbox`.
   */
  readonly scope: ActorScope;
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
  /**
   * Registers `handler` to answer the streams of `type` (`ActorMailbox.stream`), until the App stops.
   * Call it in `start`. Throws when `type` already has a stream handler in this App (the error names
   * it) or is empty. Apart from `handle`'s and `answer`'s: a type may have all three.
   */
  answerStream(type: string, handler: ActorStreamHandler): void;
}

/** Whose actor an App is (`ActorInbox.scope`). */
export type ActorScope = "all" | "one";

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

/**
 * Answers one type of stream for the actor `key`: resolve with the stream (an async generator), or
 * throw an `ActorCallError` to refuse before it starts, as an `ActorCallHandler` does. The stream may
 * throw one too, which ends it with that code. `ctx` is the handler's own, cancelled when the caller
 * closes the stream or the actor's App stops: an endless stream ends then.
 */
export type ActorStreamHandler = (key: string, message: JsonValue, ctx: AppContext) => Promise<AsyncIterable<JsonValue>>;

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

/**
 * What crosses from the actor to the caller of `stream`: its refusal, or a byte stream of frames, one
 * JSON object per line: `{"value": …}` for each value, then `{"end": true}` or
 * `{"error": {"code", "message"}}`; `{"beat": true}` while the actor waits for a value, which the
 * caller skips. A body that stops without one of the last two was cut off (`unreachable`). Bytes, so
 * that it crosses a Workers RPC (which carries only byte streams).
 */
export type ActorStreamOutcome = { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; code: string; message: string };

/**
 * Runs `handler` for one stream and says what came of it, as an outcome that crosses an RPC whole.
 * For providers, on the actor's side; `ctx` is the handlers' context (cancelled when the App stops).
 *
 * The handler gets a context of its own, cancelled when the body is cancelled (the caller closed it)
 * or `ctx` is. Its stream is read one value per pull of the body, so only as the caller reads. When
 * either context is cancelled while it waits for a value, the body ends at once (`unreachable` when
 * the App stops) and the handler's stream is closed, whether or not it heeds its context.
 *
 * `beatMs`: while it waits for the handler's next value, a beat frame every `beatMs`. A transport
 * that notices a caller gone only when it writes (a Workers RPC stream) notices it at the next beat,
 * and cancels the body: without beats an idle stream nobody reads would stay open until its next
 * value. Its provider's policy; none when absent (in one process, a cancel arrives at once).
 */
export async function answerStream(
  handler: ActorStreamHandler,
  key: string,
  message: JsonValue,
  ctx: AppContext,
  options: { beatMs?: number } = {},
): Promise<ActorStreamOutcome> {
  const closing = new AbortController();
  const own = ctx.derive((inner) => withAbortSignal(closing.signal, inner));
  let iterator: AsyncIterator<JsonValue>;
  try {
    iterator = (await handler(key, message, own))[Symbol.asyncIterator]();
  } catch (error) {
    closing.abort(error);
    if (error instanceof ActorCallError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const encoder = new TextEncoder();
  let closed = false;
  /** Closes the handler's side once: its context, then its stream. */
  const close = (reason: unknown): void => {
    if (closed) return;
    closed = true;
    if (!closing.signal.aborted) closing.abort(reason);
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {});
  };
  const stopped = own.abortSignal as AbortSignal;
  // A byte stream (`type: "bytes"`), which Bun's types do not describe: its controller is typed by what is used.
  const source = {
    type: "bytes",
    async pull(controller: { enqueue(chunk: Uint8Array): void; close(): void }) {
      let frame: string;
      let last = true;
      const beats =
        options.beatMs === undefined
          ? undefined
          : setInterval(() => {
              try {
                controller.enqueue(encoder.encode('{"beat":true}\n'));
              } catch {
                // Cancelled meanwhile.
              }
            }, options.beatMs);
      try {
        const next = await untilAborted(iterator.next(), stopped).finally(() => clearInterval(beats));
        if (next === ABORTED) frame = JSON.stringify({ error: { code: "unreachable", message: "the actor's App stopped, which ended the stream" } });
        else if (next.done === true) frame = '{"end":true}';
        else {
          const text = JSON.stringify(next.value) as string | undefined;
          if (text === undefined) frame = JSON.stringify({ error: { code: "failed", message: "the stream yielded something that is not JSON (undefined or a function)" } });
          else {
            frame = `{"value":${text}}`;
            last = false;
          }
        }
      } catch (error) {
        const code = error instanceof ActorCallError ? error.code : "failed";
        frame = JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      try {
        controller.enqueue(encoder.encode(`${frame}\n`));
        if (last) controller.close();
      } catch {
        // Cancelled meanwhile: nobody reads it any more.
      }
      if (last) close(new Error("the stream ended"));
    },
    cancel(reason: unknown) {
      close(reason ?? new Error("the caller closed the stream"));
    },
  };
  const body = new ReadableStream<Uint8Array>(source as unknown as ConstructorParameters<typeof ReadableStream<Uint8Array>>[0]);
  return { ok: true, body };
}

/**
 * The caller's side of `answerStream`: the values of its body, or the `ActorCallError` its refusal
 * stands for. `signal` is the caller's: once it aborts, the iteration throws `cancelled` and the body
 * is cancelled. Closing the iteration cancels the body too. For providers.
 */
export function streamResult(outcome: ActorStreamOutcome, signal: AbortSignal | undefined): AsyncIterable<JsonValue> {
  if (!outcome.ok) throw new ActorCallError(outcome.code, outcome.message);
  const reader = outcome.body.getReader();
  const decoder = new TextDecoder();
  /** Values decoded and not yet taken. */
  const ready: JsonValue[] = [];
  let buffered = "";
  /** How it ended: done, or with an error to throw once the values before it are taken. */
  let ending: { error?: ActorCallError } | undefined;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  };
  const onAbort = (): void => release();
  signal?.addEventListener("abort", onAbort, { once: true });
  const aborted = (): boolean => signal?.aborted === true;
  const cancelled = (): ActorCallError => new ActorCallError("cancelled", "the stream was cancelled by its caller", { cause: signal?.reason });

  /** Reads the body until a value is ready or it ended. */
  const fill = async (): Promise<void> => {
    while (ready.length === 0 && ending === undefined) {
      if (aborted()) {
        ending = { error: cancelled() };
        break;
      }
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        ending = { error: aborted() ? cancelled() : new ActorCallError("unreachable", `the actor's stream broke off: ${error instanceof Error ? error.message : String(error)}`) };
        break;
      }
      if (aborted()) {
        ending = { error: cancelled() };
        break;
      }
      if (released) {
        ending = {};
        break;
      }
      if (read.done === true) {
        ending = { error: new ActorCallError("unreachable", "the actor's stream was cut off before its end") };
        break;
      }
      buffered += decoder.decode(read.value, { stream: true });
      for (let newline = buffered.indexOf("\n"); newline >= 0 && ending === undefined; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let frame: { value?: JsonValue; end?: true; beat?: true; error?: { code: string; message: string } };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          ending = { error: new ActorCallError("failed", "the actor's stream sent a frame that is not JSON") };
          break;
        }
        if ("value" in frame) ready.push(frame.value as JsonValue);
        else if (frame.error !== undefined) ending = { error: new ActorCallError(frame.error.code, frame.error.message) };
        else if (frame.end === true) ending = {};
        // A beat: the actor is there, waiting for a value.
      }
    }
    if (ending !== undefined && ready.length === 0) release();
  };

  const iterator: AsyncIterableIterator<JsonValue> = {
    async next() {
      if (ready.length === 0 && ending === undefined && !released) await fill();
      if (ready.length > 0) return { done: false, value: ready.shift() as JsonValue };
      release();
      const error = ending?.error;
      ending = {};
      if (error !== undefined) throw error;
      return { done: true, value: undefined };
    },
    async return() {
      ready.length = 0;
      ending = {};
      release();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

const ABORTED = Symbol("aborted");

/** `work`, or `ABORTED` as soon as `signal` aborts. `work` goes on either way. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const abort = () => resolve(ABORTED);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "actor.mailbox": ActorMailbox;
    "actor.inbox": ActorInbox;
  }
}
