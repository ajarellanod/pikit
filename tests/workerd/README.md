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
| `test/provider-anthropic.workerd.ts` | `provider-anthropic` in a real object's App with `storage-do`, `runtime-pi` and `secrets-workers`: an agent answers through pi-ai's Anthropic SDK, loaded by its lazy API in workerd, from a fake Anthropic API behind `fetch`, with the key from the Worker's secrets (no `model.credentials`: keys only) |
| `test/provider-openai.workerd.ts` | `provider-openai` the same way: an agent answers through pi-ai's OpenAI SDK (the Responses API), loaded by its lazy API in workerd, from a fake Responses API behind `fetch`, with `OPENAI_API_KEY` from the Worker's secrets (no Sign in with ChatGPT on Cloudflare) |
| `test/provider-failover.workerd.ts` | `provider-failover` over `provider-openai` and `provider-anthropic` with `runtime-pi` in a real object: OpenAI's fake API refuses with a 429, the agent on `failover/main` answers through Anthropic's real SDK, and the next message goes to Anthropic alone (OpenAI cooling down) |
| `test/credentials-do.workerd.ts` | `credentials-do` on Cloudflare: an operator uploads a Claude subscription login whose token expired, through deployment-cloudflare's server, to the owner object (`credentials-do`, which starts with nothing stored); two conversations' `PlatformConversation` objects (storage-do, actors-do, provider-anthropic, runtime-pi) ask their model at once: one refresh under the owner's lock, through pi-ai's Anthropic flow against a fake OAuth endpoint behind `fetch`, both answer with the new token, the rotated tokens in the owner's SQLite; `401` for a non-operator, no secret in the list. (The lane's module runner resolves pi-ai's variable `import()`; the real bundle is `packages/pi-adapter/src/oauth-flows.test.ts`'s.) |
| `test/secrets-workers.workerd.ts` | `secrets` on `secrets-workers`, over the Worker's real `env` |
| `test/deployment-cloudflare.workerd.ts` | `deployment-cloudflare`'s entrypoint: its `Conversation` class (exported by `src/worker.ts`, over the small Apps of `src/deployment.ts`) and its Worker `fetch`: `/health`, `WORKERS_HOST`, `deliver` and the alarm reaching their handlers, eviction, a failed start resetting the object, an alarm whose start keeps failing kept by its guard alarm (workerd's own scheduler retrying it) |
| `test/google-chat.workerd.ts` | channel-google-chat on Cloudflare: its Worker half (with actors-do's mailbox) verifies Google's ID token with workerd's Web Crypto (a wrong audience 401, no object asked) and hands each event to its conversation's `PlatformConversation` object (storage-do, storage-kv-sql, actors-do, runtime-pi on the scripted model, conversations-kv, router-basic, tool-ask-user and the default export), which admits, creates Thinking… and edits it into the answer, and draws `ask_user`'s question as a card; the click goes to the object by `actor.mailbox.call` and its answer runs; Google a fake behind `fetch` |
| `test/direct-delivery.workerd.ts` | channel-telegram-webhook's answer delivery without an outbox (`startAnswerDelivery` sending directly), in a `PlatformConversation` object composed as the telegram-cloudflare preset's, Telegram a fake behind `fetch`: an answer whose send was refused waits for its retry across an eviction, and the next instance delivers it once |
| `test/admin-api.workerd.ts` | admin-api on Cloudflare: its object half in `PlatformConversation` objects running runtime-pi, conversations-kv and a channel's object half, its Worker half served by deployment-cloudflare's server; messages to two chats, then the list from the index object (newest first, qualified ids), one conversation and its transcript, its polled live events, a reset and the `409` on the one left behind, the composition, and an index object holding no conversation |
| `test/memory.workerd.ts` | memory-sql and memory-recall on Cloudflare: the `memory` suite from an App in an object of its own over storage-do and actors-do, each person's memory in the `PlatformConversation` object `memory:<person>` (its own SQLite); a call for another person refused there (`invalid`) across the RPC; a conversation's object (runtime-pi on provider-faux's `faux/scripted`, memory-recall) whose model calls `remember`: the fact lands in the person's object, the next request's `memory` section carries it, another chat has none |
| `test/settings.workerd.ts` | settings-store on Cloudflare: the `settings` suite on its table over `storage-do` in a real object; its object half in `PlatformConversation` objects running runtime-pi and router-basic (which declare their settings), its Worker half served by deployment-cloudflare's server: the sections and an operator's change through the settings object (`settings-store:settings`, its own SQLite), a refused value, and a conversation's next run with the operator's system prompt |
| `test/agents-live.workerd.ts` | agents-live and router-rules on Cloudflare: the `agent.directory` suite on agents-live over settings-store's table on `storage-do` in a real object; in `PlatformConversation` objects (runtime-pi, settings-store, agents-live, router-rules, router-basic), a live agent and a rule set through the Worker (refused ones too), a sender's message in a new chat routed to the live agent, which answers with its own prompt, and a rule naming no agent halting the message |
| `test/execution-do.workerd.ts` | pi-durable's `ExecutionEnv` suite on `execution-do`; pi-durable's own `write`, `read`, `edit` and `bash` tools on it through the `tool-*` components; the shell, `node` in QuickJS and its budget, the `.git` fence, and `git` clone, commit and push against a fake GitHub; `retentionDays` on deployment-cloudflare's real class with actors-do's `wakeups`: the object's alarm deletes the workspace a day after its last use (after an eviction too, root made again), and a use in between, stored across an eviction, moves the expiry |
| `test/execution-remote.workerd.ts` | pi-durable's `ExecutionEnv` suite on `execution-remote` in a real object, each case in an object of its own (`execution`'s sandbox, `o-<object id>`), through workerd's real `fetch` to a real execution-serve (server-bun, a `workspace` keyed by conversation and agent as execution-gondolin's is, over execution-local: real processes), which `test/sandbox-outbound.ts` runs as a Bun process of its own on 127.0.0.1 behind the outbound service; pi-durable's own tools through the `tool-*` components; the sandbox kept for a new App on the same object; two agents of one object (a delegated child of another agent) in two sandboxes, `o-<SHA-256 of object id and agent>` each, resolved on the host for their agent, a child of the same agent in its parent's; the Worker's App refused |
| `test/durable-execution.workerd.ts` | `execution-do`'s environment (`env.ts`) under pi-durable's `ExecutionEnv` suite and pi-durable's tools in a Harness turn, on a real object, after an eviction too |
| `test/actors-do.workerd.ts` | `wakeups` on `actors-do` over a real object's SQL (the alarm simulated on the suite's clock); `actor.mailbox` and `actor.inbox` from the Worker's App by real RPC to deployment-cloudflare's `Conversation` class (`PlatformConversation`); on that class, the real alarm (set, fired, after an eviction), the slice (and a handler asking again every 100 ms, on time, while another waits it out), the backoff, a request waiting for its handler, an object's own mailbox |
| `test/runtime-pi.workerd.ts` | `agent.runtime` on `runtime-pi` over `storage-do` in a real object, a worker that died mid-run included (a runtime closed while its tool runs); `runtime-pi` in a `PlatformConversation` object's App (pi-durable on `storage-do`, `actors-do`'s `actor.inbox` and `wakeups`, an actor that creates its conversation through `agent.conversations`): a message sent from the Worker's App by RPC answered by a run driven in the object's alarm; a run the object is evicted in the middle of, answered by the next instance; a model error's backoff as the object's alarm, the object evicted meanwhile |
| `test/tool-delegate.workerd.ts` | `tool-delegate` in a `PlatformConversation` object's App with `runtime-pi` driving its runs in wakeups: a task waited for, a child conversation in the same object's storage, and a task not waited for, whose answer a background task admits to the assistant's conversation |
| `test/tool-mcp.workerd.ts` | `@pikit/pi-adapter/mcp`'s transport on workerd's real `fetch` (JSON and server-sent event answers), and pi-mcp's own transport, which calls `fetch` without a receiver as workerd requires; `tool-mcp` in an App: tools described at start, calls, a reported failure as an error result, a forgotten session, a secret token; a start from the kept listing, and from the bundled seed (`seed.ts`) with nothing kept, with no request |
| `test/durable-storage.workerd.ts` | pi-durable 1.0's storage conformance on `openDurableStorage` (`@pikit/pi-adapter`) over `storage-do`; a pi-durable `Harness` over it: answered, reopened, after an eviction, a tool call, an interrupted run resumed, a run continuing across the object's events |
| `test/durable-wakeups.workerd.ts` | `nextWakeAt` and `driveSlice` (`@pikit/pi-adapter/wakeups`) on a real object: a run evicted during a model error's backoff is completed by the alarm `nextWakeAt` set |
| `test/repo-github-app.workerd.ts` | repo-github-app on Cloudflare: the `repo.github` suite on its Worker half over the real repo-github-app object (`repo-github-app:credentials`, its own SQLite); the connection through deployment-cloudflare's server (the manifest, GitHub's callback, the install) against a fake GitHub behind the isolate's `fetch`; the App's key sealed in the object's SQLite (AES-GCM, HKDF), tokens minted with an RS256 JWT signed by workerd's Web Crypto from GitHub's PKCS#1 key, the same token in the Worker and in a conversation's object (a real RPC), and none after disconnecting |
| `test/outbound-durable.workerd.ts` | `outbound-durable` in a `PlatformConversation` object's App (over `storage-do` and `actors-do`'s `wakeups`): a failed send retried by the object's alarm after an eviction, with no new message; a send cut by the slice's deadline sent again by the next alarm, after an eviction, as a possible duplicate |
| `test/channel-web.workerd.ts` | channel-web on Cloudflare through deployment-cloudflare's Worker `fetch` (`createWorkerHost`), its objects `PlatformConversation`s composed as a project's (storage-do, storage-kv-sql, actors-do, runtime-pi with provider-faux, conversations-kv, router-basic, outbound-durable, admin-auth-token, admin-api, channel-web): better-auth in the accounts actor (`channel-web:accounts`); sign-up and password sign-in, the `pikit_chat` cookies (`__Secure-` and `Secure` on https only, path `/chat/`), a message and its answer, the live view (`state`, `partial`, `message`), another user's every route on a chat `404`, an operator's follow-up (admin-api, the admin token) never in the user's messages or live view, the accounts' tables in the accounts actor only; an invitation's link setting a password, a ban refused once the signed cookie cache expired (`Date` faked past it); a fake `email.send` in the objects' App only: `GET /chat/api/config` says email is sent, a magic link signs in, a password sign-up verifies first, an invitation is emailed |
| `test/channel-http.workerd.ts` | channel-http on Cloudflare through deployment-cloudflare's Worker `fetch`, its Worker half calling `PlatformConversation` objects composed as a project's (storage-do, storage-kv-sql, actors-do, runtime-pi with provider-faux's `faux/scripted`, conversations-kv, router-basic, channel-http) by a real RPC: a message answered in the POST's response (the object waits inside the call while its alarm drives the run); a run held past `replyTimeoutMs` by a tool is `202`, the message admitted, `GET` finds it pending then answered; the same `messageId` again runs once; a request without the token or with a wrong one is `401` from the Worker and reaches no object |

Each case of a storage suite runs in a Durable Object of its own (`runInDurableObject` on a new id),
and its components get that object in `WORKERS_HOST` as `deployment-cloudflare`'s entrypoint
puts it (`test/host.ts`): the suites start their own apps, so the host is given with `withWorkersHost`
from `@pikit/contracts/cloudflare/testing`. A test in each file also starts an app with the host in
`app.start`'s context, the entrypoint's own way.

A worker killed mid-run cannot be a killed process here: `runtime-pi`'s suite closes a runtime over the
object while its tool runs instead (`createRuntimeFixture`'s `interrupted`, from
`@pikit/pi-adapter/testing/neutral`, the part of the adapter's test kit that runs in workerd), which
leaves the run open, driven by no one: what the next worker finds is what a reset object leaves. `git` reaches a fake GitHub through `fetch`,
which the test puts in place of the global one: the lane never touches the network. The MCP tests
keep workerd's own `fetch` (the point of them): `vitest.config.ts` makes `test/mcp-outbound.ts`
workerd's outbound service, where fake MCP servers answer in Node and any other address is refused;
requests to `sandbox.pikit.test` go to `test/sandbox-outbound.ts`, which forwards them to a sandbox
host it starts with Bun on loopback (so the lane needs `bun` on the `PATH`).

`actors-do`'s tests run on deployment-cloudflare's real `Conversation` class, a second time
(`PlatformConversation`, bound as `PLATFORM_CONVERSATION`, actors-do's `binding` in those
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
| A whole project's Worker, both Apps (storage-do, storage-kv-sql, actors-do, secrets-workers, provider-anthropic, runtime-pi, conversations-kv, router-basic, outbound-durable, admin-auth-token, admin-api) | 2,061 KiB | 384 KiB |
| The same with channel-web (better-auth 1.7.7 and its dependencies), measured October 14, 2026, not kept as an entry | 3,396 KiB | 649 KiB |

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
