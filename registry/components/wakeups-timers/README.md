# wakeups-timers

Wakes your components at the time they ask for, on a server: in-process timers on the app's clock.
It provides `wakeups` (SPEC §4.1, C3) and runs the `wakeup` handlers of the same app.

```sh
pikit add wakeups-timers
```

On Cloudflare the same contract is kept in the Durable Object's SQL and multiplexed over its one
alarm (a Cloudflare provider, not this component), so a component written against `wakeups` runs on
both.

## Using it

A component names a handler after itself, and asks for it to run:

```ts
pikit.provideKeyed("wakeup", "my-outbox", async (ctx) => {
  // Read your own durable state and do what is due. Honour ctx.abortSignal: when it fires,
  // stop at a consistent point and, if work remains, ask again at once:
  //   await wakeups.at("my-outbox", ctx.clock.now(), ctx);
});

// From start or later, in the component that uses `wakeups`:
await wakeups.get().at("my-outbox", ctx.clock.now() + 30_000, ctx);   // replaces an earlier request
await wakeups.get().cancel("my-outbox", ctx);
```

- **Never early, maybe late, at least once.** A handler runs at or after its time, may run twice for
  one request, and reads what to do from its own state: a request carries nothing but a time.
- **One run per name at a time.** A request that comes due while its handler runs waits for it; one
  made during the run (the handler asking again) stands after it.
- **A handler that rejects runs again** after 1 s, 5 s, 30 s, then every 60 s until it resolves, and
  each failure is logged as a warning with its count. It never gives up: nothing else would wake that
  work. If the failed run asked again sooner, that stands; if it cancelled its name, there is no retry.
- **Ask again at start.** Requests live in memory: a restart or a crash forgets them all (K6). Each
  component asks, in its `start`, for what its own durable state still needs.

A component cannot both provide a `wakeup` handler and use `wakeups`: the provider depends on every
handler it calls, so that is a dependency cycle. Today the handler and the component that asks are two
components defined in one module, sharing what they need (this component's tests do that).

## Config

```ts
"wakeups-timers": {
  sliceMs: 30_000,   // optional: cancel a running handler's context 30 s after its run began
}
```

Without `sliceMs`, a handler's context is cancelled only when the app stops. With it, handlers are cut
as Cloudflare's provider cuts them, so you can check on a server that yours stop and ask again.

## What it does

One loop and a map of name → time. The loop runs every handler whose time has come, then sleeps until
the next is due, one second at most (a clock that jumped is noticed), or until `at` or `cancel`
changes something. Each run gets the start context's values and is cancelled when the app stops, or at
the slice deadline. `stop` ends the loop, cancels running handlers and waits for them within its
deadline.

## Removing it

`pikit remove wakeups-timers` refuses while a component requires `wakeups`. It keeps no state.

## Tests

Copied with the component, they run in your project: the `wakeups` conformance suite on a manual
clock (times to the millisecond, replacing, cancelling, the declared backoff, asking again, one run
per name, the handler's own context, stop), again with a slice deadline, the lifecycle suite, its
warnings, its config, and a restart that forgets every request.
