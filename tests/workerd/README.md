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
| `test/runtime-answers.workerd.ts` | runtime-pi's `agent.submissions` in an object: its `answers` log under the feed suite (pruning, restarts) over `storage-do`; in a `PlatformConversation` object, a run settled in pi-durable whose log a crash refused (a SQLite trigger), the object evicted between two alarms, logged and announced once by the next instance, and a redelivery adding nothing |
| `test/provider-anthropic.workerd.ts` | `provider-anthropic` in a real object's App with `storage-do`, `runtime-pi` and `secrets-cloudflare`: an agent answers through pi-ai's Anthropic SDK, loaded by its lazy API in workerd, from a fake Anthropic API behind `fetch`, with the key from the Worker's secrets; no OAuth on this target |
| `test/secrets-cloudflare.workerd.ts` | `secrets` on `secrets-cloudflare`, over the Worker's real `env` |
| `test/deployment-cloudflare.workerd.ts` | `deployment-cloudflare`'s entrypoint: its `Conversation` class (exported by `src/worker.ts`, over the small Apps of `src/deployment.ts`) and its Worker `fetch`: `/health`, `WORKERS_HOST`, `deliver` and the alarm reaching their handlers, eviction, a failed start resetting the object, an alarm whose start keeps failing kept by its guard alarm (workerd's own scheduler retrying it) |
| `test/direct-delivery.workerd.ts` | channel-telegram-webhook's answer delivery without an outbox (`startAnswerDelivery` sending directly), in a `PlatformConversation` object composed as the telegram-cloudflare preset's, Telegram a fake behind `fetch`: an answer whose send was refused waits for its retry across an eviction, and the next instance delivers it once |
| `test/execution-do.workerd.ts` | pi-durable's `ExecutionEnv` suite on `execution-do`; pi-durable's own `write`, `read`, `edit` and `bash` tools on it through the `tool-*` components; the shell, `node` in QuickJS and its budget, the `.git` fence, and `git` clone, commit and push against a fake GitHub |
| `test/durable-execution.workerd.ts` | `execution-do`'s environment (`env.ts`) under pi-durable's `ExecutionEnv` suite and pi-durable's tools in a Harness turn, on a real object, after an eviction too |
| `test/platform-cloudflare.workerd.ts` | `wakeups` on `platform-cloudflare` over a real object's SQL (the alarm simulated on the suite's clock); `actor.mailbox` and `actor.inbox` from the Worker's App by real RPC to deployment-cloudflare's `Conversation` class (`PlatformConversation`); on that class, the real alarm (set, fired, after an eviction), the slice (and a handler asking again every 100 ms, on time, while another waits it out), the backoff, a request waiting for its handler, an object's own mailbox |
| `test/runtime-pi.workerd.ts` | `agent.runtime` on `runtime-pi` over `storage-do` in a real object, a worker that died mid-run included (a runtime closed while its tool runs); `runtime-pi` in a `PlatformConversation` object's App (pi-durable on `storage-do`, `platform-cloudflare`'s `actor.inbox` and `wakeups`, an actor that creates its conversation through `agent.conversations`): a message sent from the Worker's App by RPC answered by a run driven in the object's alarm; a run the object is evicted in the middle of, answered by the next instance; a model error's backoff as the object's alarm, the object evicted meanwhile |
| `test/tool-mcp.workerd.ts` | `@pikit/pi-adapter/mcp`'s transport on workerd's real `fetch` (JSON and server-sent event answers), and pi-mcp's own transport, which calls `fetch` without a receiver as workerd requires; `tool-mcp` in an App: tools described at start, calls, a reported failure as an error result, a forgotten session, a secret token; a start from the kept listing, and from the bundled seed (`seed.ts`) with nothing kept, with no request |
| `test/durable-storage.workerd.ts` | pi-durable 1.0's storage conformance on `openDurableStorage` (`@pikit/pi-adapter`) over `storage-do`; a pi-durable `Harness` over it: answered, reopened, after an eviction, a tool call, an interrupted run resumed, a run continuing across the object's events |
| `test/durable-wakeups.workerd.ts` | `nextWakeAt` and `driveSlice` (`@pikit/pi-adapter/wakeups`) on a real object: a run evicted during a model error's backoff is completed by the alarm `nextWakeAt` set |
| `test/outbound-durable.workerd.ts` | `outbound-durable` in a `PlatformConversation` object's App (over `storage-do` and `platform-cloudflare`'s `wakeups`): a failed send retried by the object's alarm after an eviction, with no new message; a send cut by the slice's deadline sent again by the next alarm, after an eviction, as a possible duplicate |

Each case of a storage suite runs in a Durable Object of its own (`runInDurableObject` on a new id),
and its components get that object in `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint
puts it (`test/host.ts`): the suites start their own apps, so the host is given with `withWorkersHost`
from `@pikit/contracts/testing`. A test in each file also starts an app with the host in
`app.start`'s context, the entrypoint's own way.

A worker killed mid-run cannot be a killed process here: `runtime-pi`'s suite closes a runtime over the
object while its tool runs instead (`createRuntimeFixture`'s `interrupted`, from
`@pikit/pi-adapter/testing/neutral`, the part of the adapter's test kit that runs in workerd), which
leaves the run open, driven by no one: what the next worker finds is what a reset object leaves. `git` reaches a fake GitHub through `fetch`,
which the test puts in place of the global one: the lane never touches the network. The MCP tests
keep workerd's own `fetch` (the point of them): `vitest.config.ts` makes `test/mcp-outbound.ts`
workerd's outbound service, where fake MCP servers answer in Node and any other address is refused.

`platform-cloudflare`'s tests run on deployment-cloudflare's real `Conversation` class, a second time
(`PlatformConversation`, bound as `PLATFORM_CONVERSATION`, platform-cloudflare's `binding` in those
tests), over an object App each test composes (`composeObjects`, `src/platform.ts`: the tests and the
objects share one isolate). An object composes its App once and never stops it, as on Cloudflare, so
`resetObjects` (`test/host.ts`) resets every object's instance after each test (`abortAllDurableObjects`:
storage stays; an eviction would wait for references a rejected RPC keeps). Where a test needs time to pass,
it fakes `Date` (the apps' clock), never the timers. An RPC method that throws is logged by workerd as
an uncaught exception even though its caller gets the rejection: those lines are expected in the
mailbox suite's rejection cases.

## How

- **Vitest with `@cloudflare/vitest-plugin`** (Cloudflare's Workers integration, formerly
  `@cloudflare/vitest-pool-workers`), `wrangler.jsonc` for the Worker: three classes in
  `new_sqlite_classes`, `TestObject`, `Conversation` and `PlatformConversation` (the last two both
  deployment-cloudflare's). Versions are pinned exactly in `package.json`; the
  plugin pins its wrangler and miniflare.
- **Files end in `.workerd.ts`**, not `.test.ts`, so the root `bun test` never picks them up.
- **The components are imported from `registry/`**, as TypeScript source; Vite compiles them.
- **The typecheck** compiles the lane, and every file it imports (components, contracts, kernel),
  against Workers' runtime types from `wrangler types` (`worker-configuration.d.ts`, generated, not
  committed): a component that reached for a Bun or Node global would fail here.

## Bundle size

```sh
bun run --cwd tests/workerd bundle    # wrangler deploy --dry-run of src/bundle.ts, into dist/
```

`src/bundle.ts` is what a conversation's object bundles when its agent works in `execution-do`:
storage-do, runtime-pi (pi-durable), execution-do and pi-durable's four tools. It has its own config,
`wrangler.bundle.jsonc`, which binds only its `TestObject`: `wrangler.jsonc` binds the suites'
classes, which it does not export. Measured with wrangler 4.143.0 and pi-durable 1.0:

| Worker | Uncompressed | gzip |
|---|---|---|
| The lane's own Worker (`src/worker.ts`: deployment-cloudflare's `Conversation` over the suites' Apps) | 501 KiB | 78 KiB |
| The conversation's stack without execution-do (storage-do and runtime-pi) | 996 KiB | 179 KiB |
| The same with execution-do and the four tools (`src/bundle.ts`) | 4,045 KiB | 980 KiB |

execution-do adds about 800 KiB gzip: just-bash, isomorphic-git and QuickJS's WebAssembly (503 KB,
226 KiB gzip). CI's workerd job measures a whole project's Worker, the telegram-cloudflare preset's
(`bun scripts/bundle-size.ts`: 6,086 KiB, 1,318 KiB gzip on October 5, 2026), and fails it over
Cloudflare's limit, 64 MiB uncompressed (there is no compressed limit). What a larger bundle meets
first is the Worker's 1 s startup limit, which no step measures. `wrangler.jsonc` carries the rule that
bundles that WebAssembly as a compiled module (execution-do's README, "On Cloudflare").

`tool-mcp` added to `src/bundle.ts` adds 48 KiB, 11 KiB gzip (measured on September 29, 2026, then taken out):
Pi's MCP client and its HTTP transport; its stdio transport and OAuth callback server are tree-shaken
away, so the bundle gains no Node module.

## Adding a suite

A new Cloudflare component, or a neutral one that should run there: add a `test/<name>.workerd.ts`
that runs its conformance suites with `inObject` (for storage) or directly, and a row above.
