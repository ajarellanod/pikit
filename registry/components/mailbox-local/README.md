# mailbox-local

Lets a channel hand a message to the actor that owns its conversation, on a server, where that actor
is your app itself. It provides `actor.mailbox` and `actor.inbox` (SPEC §4.1, C2): the handlers your
components register with `actor.inbox` receive what the channels send through `actor.mailbox`, in the
same app.

```sh
pikit add mailbox-local
```

On Cloudflare the same contract is an RPC to the Durable Object that owns the conversation (a
Cloudflare provider, not this component), so a channel written against `actor.mailbox` runs on both.

## Using it

The actor's side registers a handler for one type of message in its `start`; the channel's side
sends it:

```ts
// The actor: resolve once the message is durable, before the slow work.
const inbox = pikit.use("actor.inbox");
// in start:
inbox.get().handle("telegram.update", async (key, message, ctx) => {
  await admit(key, message, ctx);      // e.g. dispatch to the runtime, which records it
});

// The channel's ingress, in a request handler:
const mailbox = pikit.use("actor.mailbox");
await mailbox.get().send(`telegram:${chatId}`, "telegram.update", update, ctx);
return new Response("ok");             // only now acknowledge Telegram
```

- **`send` resolves when the handler resolved**, and rejects when it rejected, when no handler is
  registered for the type (the error lists the types that are), when the key is empty, when the
  message is not JSON, or when `ctx` is cancelled first. On a rejection, do not acknowledge your
  platform: it delivers again.
- **Delivery is at-least-once.** A handler may get a message it already holds (its commit succeeded,
  the answer was lost): recognise it by an id inside the message.
- **The handler gets a JSON copy** of the message and **its own context**: the start context's
  values, cancelled only when the app stops. A sender whose request went away stops waiting; the
  handler finishes anyway.
- **No order, no queue.** Sends may run at the same time, even for one key; a message lives only in
  the call.
- **A type has one handler.** Registering it twice throws, naming it. Handlers are dropped at `stop`;
  the next app's components register theirs again in their `start`.

**Calls ask an actor for an answer.** The actor registers `answer(type, handler)`; a caller (a
dashboard reading a conversation's state) gets what the handler resolved with:

```ts
inbox.get().answer("memory.recall", async (key, message, ctx) => ({ facts: await recall(key, message) }));
const answer = await mailbox.get().call(`telegram:${chatId}`, "memory.recall", { about: "travel" }, ctx);
```

The answer is a JSON copy. A failure is an `ActorCallError` with a `code`: `invalid`, `no_handler`,
`cancelled` (bound a call with `withAbortSignal(AbortSignal.timeout(ms), ctx)`), the code of an
`ActorCallError` the handler threw (`not_found`), or `failed`. A call is not a delivery: nothing
retries it, so a handler that changes state makes the change idempotent. Message and call types are
apart: a type may have both a `handle` and an `answer` handler.

Handlers are registered, not provided, so this component depends on none of them: a component may
handle messages and also send them, wake itself with `wakeups`, or use the runtime, with no
dependency cycle.

## What it does

Nothing but the call: `send` checks the key and the type, copies the message through JSON, and calls
the handler. `stop` cancels the handlers still running and waits for them, within the stop's deadline;
a `send` after it is refused.

## Removing it

`pikit remove mailbox-local` refuses while a component requires `actor.mailbox` or `actor.inbox`. It
keeps no state.

## Tests

Copied with the component, they run in your project: the `actor.mailbox` and `actor.inbox`
conformance suite (the send resolves only with its handler, types, one handler per type, JSON copies,
rejections, missing handlers, the handler's own context, concurrent sends, a handler that sends; calls:
answers as copies, typed refusals, cancellation, calls apart from messages, a handler that calls), again
with `wakeups` in the app (an actor that wakes itself), the lifecycle suite, what a stop does to
running handlers, and handlers registered again by the next app.
