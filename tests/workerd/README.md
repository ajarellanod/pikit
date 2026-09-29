# The workerd lane

The Cloudflare components' suites, run inside workerd (Cloudflare's runtime, locally, no account),
on a real SQLite-backed Durable Object (SPEC §4, C5). `bun test` runs the same components against
doubles; this lane is the proof on the runtime they ship to.

```sh
bun run test:workerd     # from the repository root: `wrangler types`, the typecheck, then the suites
```

It runs offline. It needs Node >= 22 on the `PATH` (Vitest and wrangler run on Node) as well as Bun,
which installs it (`bun install` at the root: this directory is a workspace).

## What runs

| File | Suites |
|---|---|
| `test/storage-do.workerd.ts` | `storage.sql` on `storage-do`; `storage.kv` on `storage-kv-sql` over `storage-do`; the start as `deployment-cloudflare` does it; the SQL limits `storage-do`'s README states |
| `test/submissions-sql.workerd.ts` | `agent.submissions` with its `answers` feed, pruning and restarts, on `submissions-sql` over `storage-do` |
| `test/secrets-cloudflare.workerd.ts` | `secrets` on `secrets-cloudflare`, over the Worker's real `env` |
| `test/platform-cloudflare.workerd.ts` | `wakeups` on `platform-cloudflare` over a real object's SQL (the alarm simulated on the suite's clock); `actor.mailbox` from the Worker's App by real RPC to `ConversationDouble`s; the real alarm (set, fired, after an eviction), the slice, the backoff, a request waiting for its handler, an object's own mailbox |
| `test/runtime-pi.workerd.ts` | `runtime-pi` in a conversation object's App (sessions on `sessions-sql` over `storage-do`, `platform-cloudflare`'s `actor.inbox` and `wakeups`, an actor that handles and wakes): a message sent from the Worker's App by RPC is answered by a run driven in the object's alarm |

Each case of a storage suite runs in a Durable Object of its own (`runInDurableObject` on a new id),
and its components get that object in `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint will
put it (`test/host.ts`): the suites start their own apps, so the host is given with `withWorkersHost`
from `@pikit/contracts/testing`. A test in each file also starts an app with the host in
`app.start`'s context, the entrypoint's own way.

`ConversationDouble` (bound as `CONVERSATION`) stands in for `deployment-cloudflare`'s conversation
object, with its interface: an App per object with the object in `WORKERS_HOST`, `alarm()` calling
the `onAlarm` handler and the RPC `deliver(type, key, message)` the `onDeliver` handler. A test says
what that App is made of with `composeObjects` (tests and objects share one isolate). An RPC method
that throws is logged by workerd as an uncaught exception even though its caller gets the rejection:
those lines are expected in the mailbox suite's rejection cases.

## How

- **Vitest with `@cloudflare/vitest-plugin`** (Cloudflare's Workers integration, formerly
  `@cloudflare/vitest-pool-workers`), `wrangler.jsonc` for the Worker: two classes, `TestObject` and
  `ConversationDouble`, in `new_sqlite_classes`. Versions are pinned exactly in `package.json`; the
  plugin pins its wrangler and miniflare.
- **Files end in `.workerd.ts`**, not `.test.ts`, so the root `bun test` never picks them up.
- **The components are imported from `registry/`**, as TypeScript source; Vite compiles them.
- **The typecheck** compiles the lane, and every file it imports (components, contracts, kernel),
  against Workers' runtime types from `wrangler types` (`worker-configuration.d.ts`, generated, not
  committed): a component that reached for a Bun or Node global would fail here.

## Adding a suite

A new Cloudflare component, or a neutral one that should run there: add a `test/<name>.workerd.ts`
that runs its conformance suites with `inObject` (for storage) or directly, and a row above.
