/**
 * mailbox-local: `actor.mailbox` and `actor.inbox` on a server, where every actor is this App (SPEC
 * §4.1, C2).
 *
 * The components that handle messages register a handler per type with `actor.inbox`'s
 * `handle(type, handler)`, in their `start`; a type has one handler, and handlers are dropped at
 * `stop`. `send(key, type, message, ctx)` calls the handler registered for `type` and resolves when it
 * does: once the actor holds the message durably, the channel acknowledges its platform. On Cloudflare
 * the same `send` is an RPC to the Durable Object that owns `key`; the channel does not change.
 *
 * - **Registered, not provided.** This component depends on no handler, so a component may both
 *   handle messages and send them, or wake itself with `wakeups`: no dependency cycle.
 * - **The handler gets a copy** of the message, made through JSON, as an RPC would: what is not JSON
 *   is refused here, not only on Cloudflare.
 * - **The handler gets its own context**: the start context's values, cancelled when the app stops,
 *   never by the sender. A sender that stops waiting (its request went away) gets a rejection, and the
 *   handler finishes anyway.
 * - **Nothing is queued.** A message lives only in the call: when `send` rejects, the channel does not
 *   acknowledge it, and its platform delivers it again. Delivery is at-least-once, so handlers
 *   recognise a message they already hold.
 *
 * Targets: `server`. It imports nothing platform-specific, but on Cloudflare the actors live in other
 * objects, and the Cloudflare provider reaches them.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { ActorInboxHandler, JsonValue } from "@pikit/contracts";

export default defineComponent({
  name: "mailbox-local",
  setup(pikit) {
    /** The handler of each message type, registered by the actors' components in their start. */
    const registered = new Map<string, ActorInboxHandler>();
    /** While the app runs: the handlers' context, and what `stop` cancels and waits for. */
    let running: { handlers: AppContext; stop: AbortController; inFlight: Set<Promise<void>> } | undefined;

    pikit.provide("actor.inbox", {
      handle(type, handler) {
        if (typeof type !== "string" || type === "") throw new TypeError("mailbox-local: a message type is a non-empty string, prefixed with the component that handles it");
        if (registered.has(type)) throw new Error(`mailbox-local: the message type "${type}" already has a handler; a type has one handler in an app`);
        registered.set(type, handler);
      },
    });

    pikit.provide("actor.mailbox", {
      async send(key, type, message, ctx) {
        if (running === undefined) throw new Error("mailbox-local: actor.mailbox was used while the app is not running; send from start or later");
        if (typeof key !== "string" || key === "") throw new TypeError(`mailbox-local: the key of a "${type}" message must be a non-empty string`);
        const handler = registered.get(type);
        if (handler === undefined) {
          const known = [...registered.keys()];
          throw new Error(
            `mailbox-local: no actor.inbox handler for the type "${type}" (handled: ${known.length > 0 ? known.join(", ") : "none"}); ` +
              "install the component that handles it, or check the type the sender names",
          );
        }
        const copy = copyOf(message, type);
        ctx.abortSignal?.throwIfAborted();

        const { handlers, inFlight } = running;
        const handled = Promise.resolve().then(() => handler(key, copy, handlers));
        // `stop` waits for what is in flight; a settled call leaves the set.
        const settled = handled.catch(() => {});
        inFlight.add(settled);
        void settled.then(() => inFlight.delete(settled));
        return untilCancelled(handled, ctx.abortSignal);
      },
    });

    return {
      start(ctx) {
        const stop = new AbortController();
        // The start context's values (the platform's, on some targets), with the app's stop as its
        // only cancellation: start's own deadline must not cut a handler that runs later.
        const handlers = ctx.derive((inner) => ({ abortSignal: stop.signal, value: (key) => inner.value(key), toString: () => `${inner}.Inbox` }));
        running = { handlers, stop, inFlight: new Set() };
      },
      async stop(ctx) {
        const stopping = running;
        running = undefined;
        if (stopping === undefined) return;
        // Handlers see their context cancelled and finish at a consistent point; their senders get
        // an answer either way. The wait is bounded by the stop's own deadline.
        stopping.stop.abort(new Error("mailbox-local: the app is stopping"));
        await untilCancelled(Promise.all(stopping.inFlight).then(() => {}), ctx.abortSignal).catch(() => {});
        // The next app's components register theirs again.
        registered.clear();
      },
    };
  },
});

/** A JSON copy of `message`, or a TypeError naming the type when it is not JSON. */
function copyOf(message: JsonValue, type: string): JsonValue {
  const text = JSON.stringify(message) as string | undefined;
  if (text === undefined) throw new TypeError(`mailbox-local: a "${type}" message must be JSON (not undefined or a function)`);
  return JSON.parse(text) as JsonValue;
}

/** `work`, or a rejection with `signal`'s reason as soon as it is cancelled. `work` goes on either way. */
function untilCancelled(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return work;
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
