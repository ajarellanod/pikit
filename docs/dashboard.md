# The dashboard

SPEC §5. Three pieces:

- **`admin-api`** (a component): the operator's HTTP API under `/admin/api/*`, and the dashboard's
  built files under `/admin/*`. It stands without a UI too (a script, an agent).
- **`admin-auth-token`** (a component): `admin.auth`, who is an operator.
- **The dashboard** (not a component): a Vite + React + Tailwind v4 + shadcn/ui project copied into
  the project's `src/dashboard/` from [registry/dashboard/files](../registry/dashboard/files). A project
  has a UI when that folder exists (`pikit new --ui`, `pikit ui on`), and nothing else says so.

## admin-auth-token

[README](../registry/components/admin-auth-token/README.md). Provides `admin.auth`, on both targets and
in both Apps on Cloudflare (`"apps": { "worker": "default" }`). An operator sends
`Authorization: Bearer <PIKIT_ADMIN_TOKEN>` (read through `secrets` at start; `pikit configure
--generate PIKIT_ADMIN_TOKEN` writes one), compared in constant time. It also provides `sessions`:
`POST /admin/api/session` with the token returns a signed, HttpOnly, SameSite=Strict cookie for
`/admin/api` (12 h), and a request authenticated by it must send `x-pikit-admin: 1` to change
anything. Without the secret, or with one shorter than 32 characters, the App does not start
(`tokenSecret` in config names another secret).

## admin-api

[README](../registry/components/admin-api/README.md), source in
[admin-api/files/src/pikit/admin-api](../registry/components/admin-api/files/src/pikit/admin-api):
`routes.ts` (the routes, written once over a backend), `api.ts` (every answer's JSON type),
`backend.ts` (the server backend), `remote.ts` and `worker.ts` (the Worker's half), `calls.ts` (the
object's answers), `conversation-index.ts`, `titles.ts`, `assets.ts` (the files and the CSP).

It requires `admin.auth`, `agent.observe`, `agent.runtime`, `conversations.registry`, `storage.sql` and
`actor.mailbox`; it uses `outbound.queue`, `actor.inbox`, `agent.definition`, `agent.command` and
`model.complete` when present. It provides `http.route` and two `agent.command`s, `new` (reset the
key) and `name` (set the title).

### Routes

Every `/admin/api/*` route asks `admin.auth` first and answers `401` without an operator.

| Route | What |
|---|---|
| `GET /admin/api/app` | the composition (`APP_DESCRIPTION`, config redacted) |
| `GET /admin/api/agents` | the agents: name, model, tools, whether it is the steward; then the live ones (`agent.directory`: `live: true`, `description`) |
| `POST`, `DELETE /admin/api/session` | open or close a browser session |
| `GET /admin/api/conversations?limit&cursor` | conversations, most recently active first |
| `POST /admin/api/conversations` | a new conversation of the dashboard's own (`dashboard:<uuid>`) with its first message |
| `GET /admin/api/conversations/:id` | one conversation |
| `GET /admin/api/conversations/:id/transcript?limit&cursor` | its history, newest first |
| `GET /admin/api/conversations/:id/events` | live events as server-sent events: a `snapshot`, then changes |
| `POST /admin/api/conversations/:id/messages` | the operator's follow-up |
| `POST /admin/api/conversations/:id/abort` | `agent.runtime.abort` |
| `POST /admin/api/conversations/:id/reset` | `conversations.registry.reset` |
| `GET /admin/api/commands` | the App's `agent.command`s |
| `POST /admin/api/conversations/:id/commands/:name` | run one in the conversation |
| `GET /admin/api/delivery/pending`, `GET /admin/api/delivery/receipts` | `outbound.queue`'s, on a server |
| `GET /admin/*` | the built files; any path that is not a file gets `index.html` |

Other components add their own under `/admin/api/<component>/…` (health-registry: `GET
/admin/api/health-registry`).

### The dashboard as a channel

An operator's message has a request id starting `dashboard:` (`DASHBOARD_REQUEST_PREFIX`) and is a
follow-up, never a steer. In the dashboard's own conversations (`dashboard:<uuid>` keys) answers stay
in the dashboard: no channel delivers that key. In another channel's conversation,
`startAnswerDelivery` never delivers a run whose every request is the dashboard's
(`answersOnlyTheDashboard`); a run that also answers a user's message is delivered to the user. The
agent reads a first line saying the message is the operator's.

### Server and Cloudflare

- **Server.** One App; the default export is the whole API over the App's contracts
  (`createLocalBackend`). Live events come from `agent.observe.watch`.
- **Cloudflare.** Two halves (`"apps": { "worker": "worker" }`). The Worker's half
  (`admin-api-worker`, `worker.ts`) serves the routes over `remote.ts`: every read and action is an
  `actor.mailbox.call` to the conversation's object (`admin-api.list`, `admin-api.conversation`,
  `admin-api.transcript`, `admin-api.snapshot`, `admin-api.message`, `admin-api.abort`,
  `admin-api.reset`, `admin-api.command`, …). The object's half (default export) answers those calls
  through the same contracts (`calls.ts`). Ids are `<conversation key>~<object id>`. Live events are a
  snapshot polled every 2 s, ending after 40 polls; the dashboard reconnects. A list page is at most 20
  conversations. Delivery is not listed (`404 not_installed`).

### The conversation index

`agent.observe` lists in creation order and, on Cloudflare, sees one object's conversations. So
admin-api keeps `admin_api_conversations` in `storage.sql`: one row per conversation (key, id, agent,
newest activity), upserted on `agent.dispatched` (not duplicates), `agent.started` (on Cloudflare only
resumed runs), `agent.settled`, `agent.failed`, `conversation.reset`, and at start from every
conversation `agent.observe` holds. On Cloudflare the index is the object `admin-api:index`, told by
each conversation's object with the message `admin-api.seen`. Titles are a second table,
`admin_api_conversation_titles`: after a conversation's first run, `model.complete` writes a 2-6 word
title in the background (`titleModel`, else the agent's model); `/name` replaces it.

## Building and embedding

The dashboard's `bun run build` writes `dist/`, then `scripts/embed.ts` writes every file of it, in
base64, into `src/pikit/admin-api/dashboard-files.ts` (`DASHBOARD_FILES`). admin-api bundles that module
and serves it from memory, the same on a server and in a Worker: no disk, no binding. As installed the
module is empty and `/admin/` says no dashboard is built. It is listed in admin-api's `generated`
(never your edits), committed, and marked generated in `.gitattributes`.

Every deploy builds it: deployment-docker's Dockerfile in a stage of its own, deployment-cloudflare's
`wrangler.jsonc` `build.command` (`bun install --frozen-lockfile && bun run build` in `src/dashboard/`)
whoever runs wrangler. A project without `src/dashboard/` builds nothing. On a server's `pikit dev`,
rebuild after a change; `bun run dev` in `src/dashboard/` serves it with hot reload on
`http://localhost:5173/admin/` against `PIKIT_URL`.

Every response of the files carries a Content-Security-Policy (`default-src 'self'`, no inline
script; images also `data:` and `blob:`; forms post only to itself and to `https://github.com`, where
github-app's Connect sends its manifest).

## Views

A view is a folder `src/dashboard/src/views/<id>/` whose `index.tsx` default-exports
`defineView({ id, title, icon?, requires?, order?, pages })`
([src/lib/views.ts](../registry/dashboard/files/src/lib/views.ts)). Views are found at build time
(`import.meta.glob`), nothing loads at run time. The `id` must equal the folder's name, and every page
path is under `/<id>`. A view shows only when every capability in `requires` has a provider in the
App's composition (`visibleViews`, read from `GET /admin/api/app`).

| View | `requires` | Where |
|---|---|---|
| `conversations` | `agent.observe` | the dashboard (the chat, not a sidebar item) |
| `composition` | none | the dashboard |
| `delivery` | `outbound.queue` | the dashboard |
| `health-registry` | `health` | health-registry's `view/` |

A component brings a view with `"view": "view"` in `component.json`: `pikit add` (or `pikit ui on`
later) copies it to `src/dashboard/src/views/<component name>/`, recorded as the component's files, so
`upgrade` merges it and `remove` deletes it. `scripts/ui-registry.ts generate` publishes the
dashboard's pieces and every component's view as shadcn items (`@pikit/<name>`,
[registry/ui](../registry/ui)); `scripts/dashboard-build.ts` builds the template with every
component's view in it.

A view reads only the admin API, through `src/lib/api.ts` (`api`, `post`, `useApi`, `follow`, which
send the session and pause while the tab is hidden or the operator is away). New data means a new
route, in the component that owns the data, asking `admin.auth` first.

How to add one: [.agents/skills/pikit-view/SKILL.md](../.agents/skills/pikit-view/SKILL.md), and the
dashboard's own guide, [registry/dashboard/files/README.md](../registry/dashboard/files/README.md).
Prefer a new view over editing a base one: `pikit upgrade` merges the kit's changes into base files.

## Settings sections

The Settings dialog (opened from the sidebar's foot) has the dashboard's own section, General, and one
per installed component with `"settings": "settings"` in `component.json`, copied to
`src/dashboard/src/settings/<name>/` as a view is (`defineSettings`, `src/lib/settings.ts`), shown when
its `requires` are provided. Its values are the component's settings (settings-store's
`/admin/api/settings/:component`), or its own routes. A section may open another
(`useOpenSettingsSection`), and the page's URL may name one: `/admin/?settings=<id>` opens the dialog
at it (github-app's setup comes back to `/admin/?settings=github-app`).

| Section | Component | `requires` | What |
|---|---|---|---|
| Agent | router-basic | `settings` | the default agent; any code agent's prompt, model and tools (runtime-pi's overrides) |
| Agents | agents-live | `settings`, `agent.directory` | create, edit, remove live agents; the code's listed read-only, linking to Agent |
| Routing | router-rules | `settings` | the ordered rules: channel, chat, sender; an agent (the code's or a live one) or deny with a reason |
| GitHub | github-token | `settings`, `github` | the repository (the token is the `GITHUB_TOKEN` secret, never here) |
| GitHub | github-app | `github` | Connect GitHub (a GitHub App created from a manifest and installed on the repository), the App, its installation and repository, the last token minted, Disconnect; its own routes (`/admin/api/github-app/*`), not settings |

A change in Agents reads `/admin/api/agents` again, so the new-conversation picker offers a new live
agent at once.
