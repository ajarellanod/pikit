# mailbox-local

Lets a channel hand a message to the actor that owns its conversation, on a server, where that actor
is your app itself. It provides `actor.mailbox` (SPEC §4.1, C2) over the `actor.inbox` handlers of the
same app.

```sh
pikit add mailbox-local
```

On Cloudflare the same contract is an RPC to the Durable Object that owns the conversation (a
Cloudflare provider, not this component), so a channel written against `actor.mailbox` runs on both.

## Using it

The actor's side handles one type of message; the channel's side sends it:

```ts
// The actor: resolve once the message is durable, before the slow work.
pikit.provideKeyed("actor.inbox", "telegram.update", async (key, message, ctx) => {
  await admit(key, message, ctx);      // e.g. dispatch to the runtime, which records it
});

// The channel's ingress, in a request handler:
const mailbox = pikit.use("actor.mailbox");
await mailbox.get().send(`telegram:${chatId}`, "telegram.update", update, ctx);
return new Response("ok");             // only now acknowledge Telegram
```

- **`send` resolves when the handler resolved**, and rejects when it rejected, when no handler is
  provided for the type (the error lists the types that are), when the key is empty, when the
  message is not JSON, or when `ctx` is cancelled first. On a rejection, do not acknowledge your
  platform: it delivers again.
- **Delivery is at-least-once.** A handler may get a message it already holds (its commit succeeded,
  the answer was lost): recognise it by an id inside the message.
- **The handler gets a JSON copy** of the message and **its own context**: the start context's
  values, cancelled only when the app stops. A sender whose request went away stops waiting; the
  handler finishes anyway.
- **No order, no queue.** Sends may run at the same time, even for one key; a message lives only in
  the call.

A component cannot both provide an `actor.inbox` handler and use `actor.mailbox`: the mailbox depends
on every handler, so that is a dependency cycle. A channel's ingress sends and its actor half handles,
as two components.

## What it does

Nothing but the call: `send` checks the key and the type, copies the message through JSON, and calls
the handler. `stop` cancels the handlers still running and waits for them, within the stop's deadline;
a `send` after it is refused.

## Removing it

`pikit remove mailbox-local` refuses while a component requires `actor.mailbox`. It keeps no state.

## Tests

Copied with the component, they run in your project: the `actor.mailbox` conformance suite (the send
resolves only with its handler, types, JSON copies, rejections, missing handlers, the handler's own
context, concurrent sends), the lifecycle suite, and what a stop does to running handlers.
