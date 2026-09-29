# wakeups-timers

Wakes your components at the time they ask for, on a server: in-process timers on the app's clock.
It provides `wakeups` (SPEC §4.1, C3) and runs the handlers your components register with it.

```sh
pikit add wakeups-timers
```

On Cloudflare the same contract is kept in the Durable Object's SQL and multiplexed over its one
alarm (a Cloudflare provider, not this component), so a component written against `wakeups` runs on
both.

## Using it

The component that owns the work registers a handler named after itself in its `start`, and asks
for it to run:

```ts
const wakeups = pikit.use("wakeups");

// in start:
wakeups.get().handle("my-outbox", async (ctx) => {
  // Read your own durable state and do what is due. Honour ctx.abortSignal: when it fires,
  // stop at a consistent point and, if work remains, ask again at once:
  //   await wakeups.get().at("my-outbox", ctx.clock.now(), ctx);
});
await wakeups.get().at("my-outbox", ctx.clock.now() + 30_000, ctx);   // replaces an earlier request

// later:
await wakeups.get().cancel("my-outbox", ctx);
```

- **A name has one owner.** Registering it twice throws. Handlers are dropped at `stop`; the next
  app's `start` registers them again.
- **A request may come before its handler.** `at` and `cancel` accept a name nobody handles yet; a
  request that comes due waits and runs as soon as its handler is registered. Only a time that is not
  a finite number, or an empty name, is refused.

- **Never early, maybe late, at least once.** A handler runs at or after its time, may run twice for
  one request, and reads what to do from its own state: a request carries nothing but a time.
- **One run per name at a time.** A request that comes due while its handler runs waits for it; one
  made during the run (the handler asking again) stands after it.
- **A handler that rejects runs again** after 1 s, 5 s, 30 s, then every 60 s until it resolves, and
  each failure is logged as a warning with its count. It never gives up: nothing else would wake that
  work. If the failed run asked again sooner, that stands; if it cancelled its name, there is no retry.
- **Ask again at start.** Requests live in memory: a restart or a crash forgets them all (K6). Each
  component asks, in its `start`, for what its own durable state still needs.

## Config

```ts
"wakeups-timers": {
  sliceMs: 30_000,   // optional: cancel a running handler's context 30 s after its run began
}
```

Without `sliceMs`, a handler's context is cancelled only when the app stops. With it, handlers are cut
as Cloudflare's provider cuts them, so you can check on a server that yours stop and ask again. The
loop keeps the slice deadlines, so no timer is left behind for them.

## What it does

One loop, a map of name → handler and a map of name → time. The loop runs every handler whose time
has come, cuts the runs whose slice ended, then sleeps until the next time or deadline, one second at
most (a clock that jumped is noticed, and a stop leaves no timer longer than that), or until `handle`,
`at` or `cancel` changes something. Each run gets the start context's values and is cancelled when the app stops, or at
the slice deadline. `stop` ends the loop, cancels running handlers and waits for them within its
deadline, and drops the handlers.

## Removing it

`pikit remove wakeups-timers` refuses while a component requires `wakeups`. It keeps no state.

## Tests

Copied with the component, they run in your project: the `wakeups` conformance suite on a manual
clock (times to the millisecond, replacing, cancelling, one owner per name, requests that wait for
their handler, the declared backoff, asking again, one run per name, the handler's own context, stop),
again with a slice deadline, the lifecycle suite, its warnings, its config, a restart that forgets
every request, and no timer longer than a second.
