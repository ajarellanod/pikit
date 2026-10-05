# admin-api

The operator's HTTP API (SPEC §5): what the dashboard reads and does, under `/admin/api/*`, and the
dashboard's built files under `/admin/`. A project with a UI (`pikit new --ui`, `pikit ui on`) has it
installed; it also stands on its own, for a script or an agent that reads the service.

- **Provides:** `http.route`: the routes below, and `GET /admin/*` for the dashboard's files.
- **Requires:** `admin.auth` (who is an operator; `admin-auth-token`), `agent.observe` (runtime-pi),
  `agent.runtime`, `conversations.registry`. A server (such as `server-bun`) serves the routes. On
  Cloudflare, also `actor.inbox`, `actor.mailbox` (platform-cloudflare) and `storage.sql` (storage-do).
- **Targets:** `server` and `durable` (Cloudflare): below, how it works on each.
- **Installs to:** `src/pikit/admin-api/`. `dashboard-files.ts` there is the dashboard's build's, never
  yours (`generated`).
- **npm dependencies:** `typebox`.

## The API

Every route under `/admin/api/` asks `admin.auth` first: without an operator's credential
(`Authorization: Bearer <PIKIT_ADMIN_TOKEN>` with admin-auth-token) the answer is `401`. The JSON of
every answer is typed in `api.ts`, of which the dashboard keeps an identical copy
(`src/dashboard/src/lib/admin-api.ts`); an error is `{ error, message? }`.

| Route | Answer |
|---|---|
| `GET /admin/api/app` | the composition: components, capabilities and providers, pipelines, config (`APP_DESCRIPTION`, no secrets) |
| `GET /admin/api/conversations?limit&cursor` | a page of conversations: key, agent, busy, last activity, cost, and `current` (whether its key points to it now) |
| `GET /admin/api/conversations/:id` | one conversation |
| `GET /admin/api/conversations/:id/transcript?limit&cursor` | its history, newest first, a page at a time |
| `GET /admin/api/conversations/:id/events` | its live events as server-sent events: a `snapshot`, then each change |
| `POST /admin/api/conversations/:id/messages` | `{ text, requestId?, whenBusy? }`: a message to it, a steer by default → `202 { requestId, admission }` |
| `POST /admin/api/conversations/:id/abort` | stops its run → `200` |
| `POST /admin/api/conversations/:id/reset` | points its key to a new, empty conversation; the old one is kept → `200 { key, previousConversationId, conversationId }` |
| `GET /admin/api/delivery/pending?limit&cursor` | what is not delivered yet (with an `outbound.queue`, on a server) |
| `GET /admin/api/delivery/receipts?after&limit` | what settled (with an `outbound.queue`, on a server) |

- `limit` is 1 to 500 (the runtime's default when absent); `cursor` is the `next` of the previous
  page. Either one wrong is `400`.
- An id is opaque: put it in a path encoded (`encodeURIComponent`).
- A message, an abort or a reset reaches only a conversation's current one: to one a reset left
  behind it is `409 not_current`, to one no message has reached yet `409 no_agent`.
- A message from the dashboard is part of the conversation: its run's answer goes to the
  conversation's chat, as any message's does. The same `requestId` sent again does not run again.
- Live events: one JSON object per `data:` line, each with its `type`, in the runtime's own words. A
  client that falls behind gets a new `snapshot`: rebuild the view from it. A comment line every
  `heartbeatMs` keeps an idle stream open. A browser's `EventSource` cannot send the token: read the
  stream with `fetch`, and connect again when it ends.

```sh
curl -N -H "Authorization: Bearer $PIKIT_ADMIN_TOKEN" http://localhost:3000/admin/api/conversations
```

The routes are written once (`routes.ts`) over a backend (`backend.ts`): what each target reads them
from.

## On a server

One App, and this component's default export is the whole API over its contracts
(`createLocalBackend`): every conversation of the runtime, ids the runtime's, live events from
`agent.observe`'s `watch`, delivery from the `outbound.queue` when one is installed.

## On Cloudflare

Each conversation lives in a Durable Object of its own (SPEC §4.1, C1), and the Worker reaches one only
by `actor.mailbox.call` (JSON in, JSON out). So admin-api has two halves, which `pikit add` (and
`pikit ui on`) puts in the two Apps of `pikit.config.ts`; admin-auth-token goes in both.

- **The Worker's half** (`worker.ts`, `export const worker`, config key `admin-api-worker`) serves the
  routes over the remote backend (`remote.ts`): each read and action is a call to the conversation's
  object. It needs only `admin.auth` and `actor.mailbox`.
- **The object's half** (the default export, in each object's App) answers those calls about its own
  conversations, through the same contracts as on a server (`calls.ts`), and tells the index when a run
  starts and when it settles.
- **Ids** name the object: `<conversation key>~<the object's id>` (`telegram:12345~1`), split on the last
  `~`. Every object numbers its own conversations, so its own id alone names nothing.
- **The list comes from an index**, the object `admin-api:index` (an object of the same class, which
  runs the same App and holds no conversation). Each conversation's object sends it
  `admin-api.seen` `{ key, agent, at }` when a run starts and settles; it keeps them in its
  `storage.sql` (`admin_api_index`). The list asks it for a page of keys, the most recently active
  first, then each key's object for its conversations (its current one and those a reset left behind).
  A page is at most 20 keys whatever `limit` says (each key is a subrequest), so it may hold more
  conversations than keys. An object that does not answer is left out of the page, and logged.
- **What the index may miss.** `seen` is sent from the runtime's events, which can be missed (SPEC K3):
  an object evicted at the wrong moment, or an index that did not answer, leaves a conversation out of
  the list, or its time old, until its next run sends again. A conversation whose runs all happened
  before admin-api was installed is not listed until it runs again. It can always be read by its id.
- **Live events are polled.** No call streams, so `…/events` asks the object for its `snapshot` about
  once a second and sends it only when it changed, then ends after 40 of them (the subrequests of a
  request are bounded); the dashboard connects again. Text does not stream word by word: the view shows
  where the run is, each second.
- **The composition** (`/admin/api/app`) is the objects' App, where the agents run (the index's).
- **Delivery** is not listed: each conversation's outbound queue is in its own object
  (`404 not_installed`).
- An object that cannot be reached is `503 unavailable`.
- An id naming a key nobody used starts an empty object for it (Durable Objects exist by name), which
  then answers `404`. Only an operator can ask.

## The dashboard's files

`GET /admin/*` serves `dashboard-files.ts`, a module the dashboard's own build writes
(`src/dashboard/`: `bun run build`, whose last step is `scripts/embed.ts`): every file of its `dist/`,
in base64. It is bundled with the app, so a server and a Worker serve it the same way, with no disk and
no binding. As installed it is empty, and `/admin/` is a `404` that says no dashboard is built; the API
still answers. Rebuild the dashboard and the module follows; commit it or not, as you like: a build
with the CLI makes it again.

- The files hold no data, so they are served without a credential: a browser's navigation sends no
  header, and the page asks the operator for the token.
- A path with no file and no extension gets `index.html` (the app's own pages); a path never leaves
  the files.
- **Builds before a deploy.** On Cloudflare, `pikit up` runs admin-api's `beforeDeploy` (`deploy.ts`):
  in a project with `src/dashboard/`, `bun install --frozen-lockfile` and `bun run build` there, and the
  deploy stops if either fails. On a server it builds nothing: deployment-docker's image builds the
  dashboard in a stage of its own, so it is built once.

## Config

```ts
"admin-api": {
  heartbeatMs: 15_000, // a comment on an idle event stream this often
}
// On Cloudflare, the Worker's half takes the same under workerConfig's "admin-api-worker".
```

## Guarantees

- Every API answer is an operator's (`admin.auth`); nothing is read, and no object called, before it
  says yes.
- It reads contracts only (`APP_DESCRIPTION`, `agent.observe`, `conversations.registry`) and acts only
  through the contracts that own each action (`agent.runtime`'s `dispatch` and `abort`,
  `conversations.registry`'s `reset`), on Cloudflare inside the conversation's own object.
- Each action is logged with the operator's id and the conversation's key, never the message's text.
- Live events end when the client goes away or the server stops (on Cloudflare also after their
  polls): nothing keeps watching.

## Tests

- `admin-api.test.ts`, with a double for every contract (`runtime.test-support.ts`), routes picked the
  way a server picks them: what setup declares; `401` on every API route before anything is read; each
  route's answer and its `400` / `404` / `409`; server-sent events; messages logged without their text.
- `remote.test.ts`: the Worker's half over a fake platform whose every key is an App running the
  default export on `durable`: ids, the list from the index (order, pages, an object that does not
  answer), reads, actions and their refusals across the call, the polled snapshot, `401` before any
  call, and the index told when a run starts or settles.
- `conversation-index.test.ts`: the index on SQLite (an upsert a late `seen` does not move back, order,
  pages, cursors). `assets.test.ts`: the files served from the module. `deploy.test.ts`: the hook.
- The kit's workerd lane runs both halves in real Durable Objects (`tests/workerd/test/admin-api.workerd.ts`).
