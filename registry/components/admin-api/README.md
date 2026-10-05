# admin-api

The operator's HTTP API (SPEC §5): what the dashboard reads and does, under `/admin/api/*`, and the
dashboard's built files under `/admin/`. A project with a UI (`pikit new --ui`, `pikit ui on`) has it
installed; it also stands on its own, for a script or an agent that reads the service.

- **Provides:** `http.route`: the routes below, and `GET /admin/*` for the dashboard's files.
- **Requires:** `admin.auth` (who is an operator; `admin-auth-token`), `agent.observe` (runtime-pi),
  `agent.runtime`, `conversations.registry`. A server (such as `server-bun`) serves the routes.
- **Targets:** `server`. The files are read from disk, and on Cloudflare the Worker's App, which
  serves HTTP, has no `agent.observe` yet (features/cloudflare-conversation-index.md).
- **Installs to:** `src/pikit/admin-api/`.
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

- `limit` is 1 to 500 (the runtime's default when absent); `cursor` is the `next` of the previous
  page. Either one wrong is `400`.
- A message, an abort or a reset reaches only a conversation's current one: to one a reset left
  behind it is `409 not_current`, to one no message has reached yet `409 no_agent`.
- A message from the dashboard is part of the conversation: its run's answer goes to the
  conversation's chat, as any message's does. The same `requestId` sent again does not run again.
- Live events: one JSON object per `data:` line, each with its `type`, in the runtime's own words. A
  client that falls behind gets a new `snapshot`: rebuild the view from it. A comment line every
  `heartbeatMs` keeps an idle stream open. A browser's `EventSource` cannot send the token: read the
  stream with `fetch`.

```sh
curl -N -H "Authorization: Bearer $PIKIT_ADMIN_TOKEN" http://localhost:3000/admin/api/conversations
```

## The dashboard's files

`GET /admin/*` serves the folder `assets` (default `src/dashboard/dist`, from the working directory),
which the dashboard's own build makes. The files hold no data, so they are served without a credential:
a browser's navigation sends no header, and the page asks the operator for the token. A path with no
file and no extension gets `index.html` (the app's own pages); a path never leaves the folder. Without
a built dashboard `/admin/` is a `404` that says so, and the API still answers.

## Config

```ts
"admin-api": {
  assets: "src/dashboard/dist", // the dashboard's built files, from the working directory
  heartbeatMs: 15_000,          // a comment on an idle event stream this often
}
```

## Guarantees

- Every API answer is an operator's (`admin.auth`); nothing is read before it says yes.
- It reads contracts only (`APP_DESCRIPTION`, `agent.observe`, `conversations.registry`) and acts only
  through the contracts that own each action (`agent.runtime`'s `dispatch` and `abort`,
  `conversations.registry`'s `reset`).
- Each action is logged with the operator's id and the conversation's key, never the message's text.
- Live events end when the client goes away or the server stops: nothing keeps watching.

## Tests

`admin-api.test.ts`, with a double for every contract it uses, routes picked the way a server picks
them: what setup declares; `401` on every API route without an operator, before anything is read;
each route's answer and its `400` / `404` / `409`; server-sent events (a snapshot, then changes, a
heartbeat, the watch released when the client leaves); messages logged without their text; the files
served, pages falling back to `index.html`, and no path leaving the folder.
