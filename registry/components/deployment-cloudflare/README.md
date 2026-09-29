# deployment-cloudflare

Runs a pikit project on Cloudflare Workers and Durable Objects: the Worker and its `Conversation`
objects running the project's two Apps, `wrangler.jsonc`, and the commands
`pikit up | down | logs | status | dev` delegate to (SPEC §4.1: C1, C4, C5, C8).

- **Provides:** nothing. It is not an app component and is not listed in `pikit.config.ts`: it runs
  the Apps rather than running inside them.
- **Requires:** nothing. It runs whatever `pikit.config.ts` composes: its default export in each
  Durable Object, and `export const worker` in the Worker.
- **Target:** `cloudflare`. Only `entrypoint.ts` imports `cloudflare:workers`; only `commands.ts`,
  which runs on your machine, imports `node:*`.
- **Installs to:** `src/pikit/deployment-cloudflare/`, plus `wrangler.jsonc` at the project's root.
- **npm dependencies:** `@pikit/contracts`. The project's `wrangler` (a dev dependency that
  `pikit new --target cloudflare` adds), which runs on Node ≥ 22.
- **Environment:** none of its own. `.env` holds the app's secrets: `pikit up` uploads them with each
  version, and `pikit dev` gives them to the local Worker.

## Your Telegram bot on Cloudflare

```sh
pikit new my-bot --target cloudflare --preset telegram-cloudflare
cd my-bot
pikit configure
pikit up
```

- **`new`** writes the bot: a Worker that receives Telegram's updates, and one Durable Object per chat
  running the agent (`channel-telegram-webhook`, `runtime-pi`, OpenRouter's models, a workspace and a
  shell in the object with `execution-do`, web fetch and search), each half in its App of
  `pikit.config.ts`. The agent, `src/agents/assistant/agent.ts`, uses `openrouter/z-ai/glm-5.3-flash`
  and names every installed tool.
- **`configure`** asks, in order: the bot's token (from @BotFather, checked with Telegram), who may
  talk to it (send the bot a message; it reads it and asks you to allow the sender), the webhook's
  secret (generated), the Brave Search key (optional: Enter skips, and only web search needs it) and
  the OpenRouter key. Everything goes to `.env` (mode 0600). Without a terminal, export them instead:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `OPENROUTER_API_KEY`, `BRAVE_API_KEY`.
- **`up`** deploys the Worker with `.env`'s variables as its secrets (`wrangler deploy`, on your
  Cloudflare account: `bunx wrangler login` once, or `CLOUDFLARE_API_TOKEN`), waits until `/health` answers from the
  version it deployed, then tells Telegram where to post (`setWebhook` at `<workers.dev URL>/telegram`,
  with the secret). Write to the bot: it answers.

`pikit dev` runs the same Worker and objects on your machine (`wrangler dev`); Telegram cannot reach it
there, so a webhook needs a deploy. `pikit logs` streams the deployed bot's logs, `pikit status` shows
what serves. pikit's own end-to-end test (`packages/cli/src/e2e-telegram-cloudflare.test.ts`) runs this
whole path in workerd against a fake Telegram and a fake OpenRouter.

## What it does

### Two Apps (`worker.ts`, `entrypoint.ts`, `host.ts`)

`wrangler.jsonc` deploys `src/pikit/deployment-cloudflare/worker.ts`, which reads `pikit.config.ts`:

```ts
export default defineApp({ components: [...], config });          // each conversation's object
export const worker = defineApp({ components: [...], config: workerConfig }); // the Worker
```

**The `Conversation` Durable Object** (one per conversation, SQLite-backed) composes the default
export on its first event, never in its constructor:
- Its start runs inside `blockConcurrencyWhile`, so no request, RPC or alarm reaches the object
  before its App has started, with a 20 s deadline, and a 5 s one for the rollback of a failed start.
  Both end before Cloudflare's own 30 s limit.
- A start that fails or passes its deadline is rolled back and rethrown from inside
  `blockConcurrencyWhile`: Cloudflare resets the object, the event that started it fails, and the
  next event starts a new App (SPEC K2). The App is never stopped otherwise: an object is evicted
  without warning (K6), and an evicted object starts its App again on its next event.
- The start context carries `WORKERS_HOST` (`@pikit/contracts`): `env`, and `object` with the
  object's `id`, its `storage` (for `storage-do`), and two hooks:
  - `onAlarm(handler)`: `alarm()` calls it. A rejection makes Cloudflare retry the alarm. An alarm
    with no handler is logged and dropped.
  - `onDeliver(handler)`: the RPC `deliver(type, key, message)` calls it and resolves once it
    has. With no handler, `deliver` rejects, so the sender (`actor.mailbox`) rejects and its
    platform retries.
  
  One handler of each per object. A second registration fails the start: one component (the
  platform's wakeups and mailbox) multiplexes them.
- Its RPC interface is `health()`, `deliver()` and `alarm()`, nothing else.

**The Worker** composes `export const worker` on its first request, once per isolate, with
`WORKERS_HOST` `{ env }` on its start context and the same deadlines. A failed start answers 503 and
the next request tries again. It serves the App's `http.route`s as `server-bun` does on a server: a
context of their own per request (never the start's, and without `WORKERS_HOST`), a literal path
before one with parameters, 404 for no match, and a 500 that does not reveal the error. The routes
are resolved by a component of the entrypoint's own, named `deployment-cloudflare` in `describe()`.
Without `export const worker`, the Worker serves only `/health`.

**`GET /health`** is the Worker's own and public. It starts the Worker's App and the App of one
object of its own (`idFromName("pikit:health")`, never a conversation's), then answers
`{ "ok": true, "version": "<version id>" }` (200) or `{ "ok": false, "version": …, "error": "the
object's App did not start" }` (503). It says which half failed, never why: the logs say why.

Change the deadlines or the logger in `worker.ts`, in `createEntrypoint`'s options. Logs go to
`console` (the core's `consoleLogger`): Workers Logs keeps them (`observability` in `wrangler.jsonc`)
and `pikit logs` streams them.

### `wrangler.jsonc`

One Durable Object class, `Conversation`, bound as `CONVERSATION`, created SQLite-backed by migration
`v1`. `nodejs_compat`, `version_metadata` (the version `/health` reports), Workers Logs on, and rules
that import `.md` files as text and bundle `.wasm` files compiled. A rule matches an import as it is
written, so `execution-do`'s QuickJS, imported by a package export without `.wasm`
(`@jitl/quickjs-wasmfile-release-sync/wasm`), is named in it. It has no `name`: the commands name
the Worker after `package.json`'s `name`. Running wrangler by hand, pass `--name`.

This file is yours: add bindings, routes, a custom domain. Keep the migration: a migration is
forever; add new ones after it. `files.test.ts` checks what the entrypoint relies on.

### The commands (`commands.ts`)

The CLI delegates to these functions; you can call them from a script too. Each one runs the
project's `node_modules/.bin/wrangler` in the project's directory, without a shell, with
`--name <package.json name>` (`my_bot.v2` → `my-bot-v2`).

| Function | Runs |
|---|---|
| `up({ url })` | `wrangler deploy --secrets-file <.env's secrets>`, then `GET /health` every 2 s until it answers ok from the version it deployed (3 min at most), then the components' `afterDeploy` hooks. Resolves with `{ version, url }` |
| `down()` | `wrangler delete`, only at a terminal (see below) |
| `logs()` | `wrangler tail`: live, until Ctrl-C |
| `status({ url })` | `wrangler deployments list --json`, plus `GET /health` |
| `dev()` | `wrangler dev`: the Worker and its objects locally, in workerd, reloading on change |

**`up` and secrets.** `.env`'s variables go up with the version (`wrangler deploy --secrets-file`),
not before it (`wrangler secret put`): the version `/health` checks is the code and its secrets
together, no request ever sees new secrets with old code, and no extra version is created. Wrangler
adds them to the secrets already set and deletes none: remove one with `wrangler secret delete`.
Empty variables and wrangler's own `CLOUDFLARE_*` credentials stay on your machine. The file is
written in a private temporary directory and deleted after.

**`up` waits for the new version (C8).** A new version takes seconds to reach every request. `up`
resolves only once `/health` answers ok from the version it deployed, so whatever registers against
the Worker next (a Telegram webhook) reaches it. If that version answers that its App does not start,
`up` rolls back to the previous version (`wrangler rollback`) and fails, pointing at the logs
(`rollback: false` keeps it). If it never answers in time, `up` fails and leaves it: whether to roll
back is yours. `/health` is asked at the `workers.dev` URL wrangler reports; pass `url` for a custom
domain. `up` notes the version and URL in `.pikit/deployment-cloudflare.json` for `status`.

A deploy cuts the alarms in progress; Cloudflare retries them, and runs resume (C4).

**After the deploy: the components' hooks (C8).** Some components register the Worker with
something outside it (`channel-telegram-webhook` tells Telegram where to post), and that must reach
the new version. So, once `/health` answers ok from it, `up` runs each installed component's
`afterDeploy`. The convention, explicit on both sides:

- The component names the file in its `component.json`, relative to its own directory:
  `"hooks": { "afterDeploy": "deploy.ts" }`. `pikit add` records it in `pikit.json`, by project path
  (`"hooks": { "afterDeploy": "src/pikit/channel-telegram-webhook/deploy.ts" }`); `up` reads only that
  (`deployHooks(cwd)`). No file is found by its name.
- That file exports `afterDeploy(io)`, and resolves with its problems, one line each (empty when done):

  ```ts
  export async function afterDeploy(io: {
    url: string;                               // the deployed Worker's public base URL (`url`, or workers.dev)
    config: Readonly<Record<string, unknown>>; // its config in pikit.config.ts (the default export's, defaults applied)
    get(name: string): string | undefined;     // an exported variable, or else .env: the secrets just uploaded
    say(line: string): void;                   // printed by `pikit up`
  }): Promise<string[]>;
  ```

  The shape is structural (`AfterDeployIO` in `commands.ts`): a component imports nothing from this one.

The hooks run in `pikit.json`'s order, every one of them, and a hook that throws counts as a problem.
Then `up` fails with all their problems, each named by its component. The version stays deployed and
is not rolled back: it answers, and what failed is outside it. Fix what they say (often `pikit
configure`), then `pikit up` again: a hook runs at every deploy, so it must be harmless to repeat. A
version that never answers, or answers that its App does not start, runs no hook.

**`down` deletes.** Cloudflare cannot stop a Worker without deleting it, and deleting it deletes every
conversation's Durable Object with its data. `down` runs `wrangler delete`, which asks at the
terminal. Without a terminal, or in CI, wrangler would answer yes by itself, so `down` refuses.

**`logs`** always follows: `--tail` is refused, since `wrangler tail` replays nothing. Past logs are in
the dashboard (Workers Logs).

**`dev`** reads `.env` as the local Worker's secrets (wrangler does, when there is no `.dev.vars`) and
keeps the objects' state in `.wrangler/`.

There is no `restart` (a new version is `up`) and no `exec`: nothing runs a command where the app
runs, so `pikit configure` logs in on your machine and model keys go in `.env`.

## Removing it

`pikit remove deployment-cloudflare` deletes `src/pikit/deployment-cloudflare/` and `wrangler.jsonc`.
It never touches the deployed Worker: `pikit down` first if you want it gone.

## Tests

The tests are copied with the component and run in your project:
- `host.test.ts`: the entrypoint's logic under Bun with a fake object and namespace: when the object's
  App starts, what `WORKERS_HOST` carries, alarms and deliveries, a failed start and a late one with a
  rollback that hangs (both deadlines hold), the Worker's routes and `/health`.
- `commands.test.ts`: the exact `wrangler` argv of every command, the secrets file, the wait for the
  new version, the components' hooks run after it (with their URL, config and secrets, their problems
  failing `up`, none for a version that does not answer), the rollback and `status`, with a fake runner
  and a fake `fetch`. No wrangler, no account.
- `bundle.test.ts`: `wrangler deploy --dry-run` bundles `worker.ts` with a two-App `pikit.config.ts`
  and exports `Conversation`, and the commands never reach the bundle. Uploads nothing.
- `files.test.ts`: `wrangler.jsonc` keeps its promises, and only `entrypoint.ts` imports `cloudflare:*`.

In the pikit repository, the workerd lane (`tests/workerd/test/deployment-cloudflare.workerd.ts`) runs
the entrypoint on real SQLite-backed Durable Objects: `/health`, `WORKERS_HOST`, `deliver` and the
alarm reaching their handlers, an evicted object starting again, and a failed start resetting it. And
`packages/cli/src/deploy-hooks.test.ts` runs `up` with a fake wrangler against
`channel-telegram-webhook`'s fake Telegram: its webhook registered only once the new version answers.

`component.json` is generated, not written by hand. With no `setup`, it provides and requires
nothing. Its `files` maps `files/src` to `src` and names `wrangler.jsonc` (SPEC §10.2).
