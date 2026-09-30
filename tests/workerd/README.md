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
| `test/deployment-cloudflare.workerd.ts` | `deployment-cloudflare`'s entrypoint: its `Conversation` class (exported by `src/worker.ts`, over the small Apps of `src/deployment.ts`) and its Worker `fetch`: `/health`, `WORKERS_HOST`, `deliver` and the alarm reaching their handlers, eviction, a failed start resetting the object |
| `test/sessions-sql.workerd.ts` | Pi's own `SessionRepo` and `Storage` suites on `sessions-sql` over `storage-do` (the Durable Object session backend passes Pi's session conformance, SPEC §4); `agent.runtime` on `runtime-pi` over those sessions, a worker killed mid-run included |
| `test/execution-do.workerd.ts` | Pi's `ExecutionEnv` suite on `execution-do`; Pi's own `write`, `read`, `edit` and `bash` tools on it through the `tool-*` components; the shell, `node` in QuickJS and its budget, the `.git` fence, and `git` clone, commit and push against a fake GitHub |
| `test/platform-cloudflare.workerd.ts` | `wakeups` on `platform-cloudflare` over a real object's SQL (the alarm simulated on the suite's clock); `actor.mailbox` and `actor.inbox` from the Worker's App by real RPC to deployment-cloudflare's `Conversation` class (`PlatformConversation`); on that class, the real alarm (set, fired, after an eviction), the slice (and a handler asking again every 100 ms, on time, while another waits it out), the backoff, a request waiting for its handler, an object's own mailbox |
| `test/runtime-pi.workerd.ts` | `runtime-pi` in a `PlatformConversation` object's App (sessions on `sessions-sql` over `storage-do`, `platform-cloudflare`'s `actor.inbox` and `wakeups`, an actor that handles and wakes): a message sent from the Worker's App by RPC is answered by a run driven in the object's alarm |
| `test/tool-mcp.workerd.ts` | `@pikit/pi-adapter/mcp`'s transport on workerd's real `fetch` (JSON and server-sent event answers), and Pi's gap it closes (pi-mcp's own transport fails with "Illegal invocation"); `tool-mcp` in an App: tools described at start, calls, a reported failure, a forgotten session, a secret token; a start from the kept listing, and from the bundled seed (`seed.ts`) with nothing kept, with no request |

Each case of a storage suite runs in a Durable Object of its own (`runInDurableObject` on a new id),
and its components get that object in `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint
puts it (`test/host.ts`): the suites start their own apps, so the host is given with `withWorkersHost`
from `@pikit/contracts/testing`. A test in each file also starts an app with the host in
`app.start`'s context, the entrypoint's own way.

A worker killed mid-run cannot be a killed process here: `runtime-pi`'s suite leaves the run open in
the object instead, an app never stopped whose tool never returns (`interruptInProcess`, from
`@pikit/pi-adapter/testing/neutral`, the part of the adapter's test kit that runs in workerd). What
the next worker finds is what a reset object leaves. `git` reaches a fake GitHub through `fetch`,
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
storage-do, sessions-sql, runtime-pi, execution-do and Pi's four tools. It has its own config,
`wrangler.bundle.jsonc`, which binds only its `TestObject`: `wrangler.jsonc` binds the suites'
classes, which it does not export. Measured on September 29, 2026 (wrangler 4.143.0, Pi 0.99.0):

| Worker | Uncompressed | gzip |
|---|---|---|
| The lane's own Worker (`src/worker.ts`: deployment-cloudflare's `Conversation` over the suites' Apps) | 501 KiB | 78 KiB |
| The conversation's stack without execution-do | 1,195 KiB | 219 KiB |
| The same with execution-do (`src/bundle.ts`) | 4,188 KiB | 1,005 KiB |

execution-do adds about 786 KiB gzip: just-bash, isomorphic-git and QuickJS's WebAssembly (503 KB,
226 KiB gzip). The budget is 10 MB compressed (SPEC §4). `wrangler.jsonc` carries the rule that
bundles that WebAssembly as a compiled module (execution-do's README, "On Cloudflare").

`tool-mcp` added to `src/bundle.ts` adds 48 KiB, 11 KiB gzip (measured the same day, then taken out):
Pi's MCP client and its HTTP transport; its stdio transport and OAuth callback server are tree-shaken
away, so the bundle gains no Node module.

## Adding a suite

A new Cloudflare component, or a neutral one that should run there: add a `test/<name>.workerd.ts`
that runs its conformance suites with `inObject` (for storage) or directly, and a row above.
