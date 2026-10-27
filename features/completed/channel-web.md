# Channel: web

**Public appeal:** ⭐ People who are not operators talk to the assistant from a web page: their own
conversations, the same look as the dashboard, no admin in sight. They sign in with an email and a
password, a link by email, Google, GitHub or any OAuth/OIDC platform. OpenClaw has WebChat (its
Control UI's chat tab and native apps over the Gateway's WebSocket).

**Status:** built, on both targets: the UI split (`@pikit/lib-ui`, `@pikit/admin-client`), `email.send`
with `email-ses` and `email-resend`, UI projects of a component, and `channel-web` with its page
(`src/chat/`), the operator's view, Settings section and command. This note was its build guide;
"Where it is" and "Open" are at its end.

**Needed by:** nothing required.

## What it gives
A chat page for the assistant's users, at `/chat/`, with its own accounts. Each user sees and
continues only their own conversations, watches the answer as it is written, attaches images and
stops a run. The operator invites, bans and removes users from the dashboard (or `pikit channel-web`).
The operator dashboard (`/admin/`, SPEC §5) stays as it is: operators only, nothing of it in the
users' page. Both targets, `server` and `durable`, from the first version.

## The pieces
| Piece | What | Where |
|---|---|---|
| UI split | `@pikit/lib-ui` (generic helpers) and `@pikit/admin-client` (the admin API's client) | `registry/dashboard/files`, `registry/ui` |
| `email.send` | a contract: send one email; two providers that need only variables | `@pikit/contracts`, `email-ses`, `email-resend` |
| UI projects of a component | a component ships a UI project of its own, built and bundled like the dashboard | CLI, `deployment-docker`, `deployment-cloudflare` |
| `channel-web` | the channel: accounts (better-auth), routes, delivery, live view, admin routes, view, command | `registry/components/channel-web` |
| The page | `src/chat/`: a Vite + React + Tailwind v4 project | the component's UI project |

## 1. The UI split
The dashboard's pieces are shadcn registry items (`registry/ui/r/*.json`), but `@pikit/lib` is one
item holding generic helpers and the admin client (`api.ts`, `admin-api.ts`, `chats.tsx`,
`settings.ts`, `views.ts`, `router.tsx`, `shell.tsx`).
- `@pikit/lib-ui`: `utils`, `format`, `theme`, `messages`, `activity`, `names`, `sounds` (what is
  generic). `@pikit/admin-client`: `api`, `admin-api`, `chats`, `settings`, `views`, `router`, `shell`.
- `bui`, `markdown`, `markdown-engine`, `message`, `PromptBar` and `error-note` depend on `lib-ui`
  only, take everything by props and never fetch. Today two imports break that:
  `components/pikit/message.tsx` imports `OPERATOR_NOTE` from `@/lib/admin-api` (moves to
  `lib-ui`'s `messages.ts`, `admin-api.ts` re-exports it), and `components/pikit/error-note.tsx`
  imports `ApiFailure` from `@/lib/api` (it takes a structural `{ status, code, message }` instead).
- A boundary test (in `scripts/`) keeps these pieces from importing `@/lib/api`, `@/lib/admin-api`,
  `@/lib/chats`, `@/lib/settings`, `@/lib/views`, `@/lib/router` or `@/lib/shell`.
- The chat page carries copies of the shared pieces, generated from the dashboard's sources by a kit
  script and checked identical by a test (as `admin-api.ts` is with `api.ts`). `pikit upgrade` merges
  them as any other file (P6).

## 2. `email.send`
better-auth sends no email itself: it calls ours (`sendVerificationEmail`, `sendResetPassword`, the
magic link plugin's `sendMagicLink`). Email goes through a contract with providers that need only
variables, no SMTP and no SDK: a `fetch` to an HTTP API, so both targets.
- Contract (`packages/contracts/src/email.ts`): `EmailSender.send({ to, subject, text, html? }, ctx)
  → { id }`, one recipient per call. `from` is the provider's (its variable): a component never picks
  a sender address. Rejects with an `EmailError` whose `code` is `invalid` (the address or message;
  never retry), `rejected` (the provider refused: suppressed, unverified sender) or `unavailable`
  (network, 429, 5xx: retry later). Never logs a message's body or a link.
- Conformance suite (`createEmailSenderConformance`, `@pikit/contracts/testing`) against a fake HTTP
  API each provider points at: a send, the codes, no body in the error's message.
- `email-ses`: Amazon SES v2 `SendEmail` signed with SigV4 over WebCrypto (no AWS SDK). Variables
  `AWS_SES_REGION`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`.
- `email-resend`: Resend's `POST /emails`. Variables `RESEND_API_KEY`, `EMAIL_FROM`.
- Catalogue: `email.send`, single, experimental (two providers pass the suite).

## 3. UI projects of a component
The dashboard's build is wired by hand today (deployment-docker's Dockerfile stage, deployment-cloudflare's
`build.command`, `packages/cli/src/project/dashboard.ts`, the starter's `.gitattributes`). A
component may now ship a UI project of its own:
- A manifest field names a folder of the component and where it goes in the project (`src/chat/` for
  channel-web). `pikit add` writes it, recorded as the component's files; `pikit upgrade` merges it;
  `pikit remove` takes it away (absence, not flags: P4). `pikit ui off` never touches it.
- Its `build` script writes the component's files module (channel-web: `src/pikit/channel-web/chat-files.ts`,
  `CHAT_FILES`, as admin-api's `DASHBOARD_FILES`), which the component's routes serve. The kit's copy of
  that module is empty: the routes then say no page is built.
- Every deploy builds every UI project the project has (the dashboard and these) before bundling:
  the Dockerfile stage and wrangler's build command loop over them; `pikit dev` builds each at start
  (on a server) and again on change.
- `registry validate` checks it as browser code (its own `package.json`, never App imports), and the
  project's `tsc` and `bun test` skip it as they skip `src/dashboard/`.

## 4. `channel-web`
Targets `server` and `durable`, two halves like admin-api (`index.ts` the default App's, `worker.ts`
the Worker's, `apps.worker`). One code for both: in `start`, `actor.inbox`'s `scope` says where it
runs (`"all"` or none: a server, everything local; `"one"`: a Durable Object), as admin-api and
settings-store do.

### Accounts: better-auth
- `better-auth` pinned (1.7.7), imported from `better-auth/minimal` (no Kysely). Reference:
  `better-auth/better-auth` at v1.7.7.
- **Its database** is a custom adapter over `storage.sql` (`createAdapterFactory`): tables
  `channel_web_user`, `channel_web_session`, `channel_web_account`, `channel_web_verification` (model
  names mapped), created in `start` / at first use with `CREATE TABLE IF NOT EXISTS` in the SQL subset
  `storage.sql` allows; dates as epoch ms or ISO text, booleans 0/1. It passes better-auth's adapter
  suite (`@better-auth/test-utils/adapter`, a devDependency) on `sqliteStorage`, and runs in workerd.
  **No transactions** (`transaction: false`): `storage.sql`'s transaction runs statements only, and
  better-auth runs hashing and our email callback inside its own. Its multi-step writes are ordered
  so that a crash between them leaves a user who can sign in again or be removed, said in the README.
- **Where it runs.** On a server, in the App. On Cloudflare, in one actor, `channel-web:accounts` (an
  object of the conversations' class, like `admin-api:index`), whose `storage.sql` holds the accounts
  and the users' conversation index. The Worker forwards every `/chat/api/auth/*` request to it
  (`actor.mailbox.call`, the request as `{ method, url, headers, body }`, the response as `{ status,
  headers, body }` with every `set-cookie` kept). Its tables are made lazily, only in that object.
- **Secret** `CHANNEL_WEB_AUTH_SECRET` (required, at least 32 characters): better-auth's secret.
  Never the admin token, never derived from it.
- **Cookies**: prefix `pikit_chat`, path `/chat/`, `HttpOnly`, `SameSite=Lax`, `Secure` on https.
  Never `pikit_admin_session`, never path `/admin/`. A chat session never opens `/admin/api/*`, and
  an admin session never opens `/chat/api/*` (tests both ways).
- **Session checks** (every `/chat/api/*` but auth): better-auth's signed cookie cache
  (`session.cookieCache`, `maxAge` from config, 5 minutes by default) is checked without a database
  read (`getCookieCache`); past it, the session is read from the database (on Cloudflare a call to
  the accounts actor), and the route sends back the cache better-auth's `getSession` renewed after that
  read (never `refreshCache`, which re-signs without reading). A ban or removal takes effect within
  `maxAge`: said in the README.
- **Base URL**: every absolute URL the accounts make (an email's link, an OAuth redirect URI,
  `trustedOrigins`, an operator's invitation or reset) is under a trusted origin (`linkOrigin`):
  `PIKIT_PUBLIC_URL` when set; without it, the request's own origin only when its host is trusted. On
  a server that is a loopback host (`localhost`, `127.0.0.1`, `[::1]`, any port): a client writes
  `Host`, so any other is `400 public_url_required` on `/chat/api/auth/*` and on the operator's
  invitation and reset, before anything is made, and the start-up log says public access needs
  `PIKIT_PUBLIC_URL`. On Cloudflare the Worker's own host is trusted: Cloudflare routes a request to a
  Worker by its host (a route or `workers.dev` of the operator's), so a client cannot make it
  another's. `basePath` is `/chat/api/auth`, so an OAuth redirect URI is
  `<origin>/chat/api/auth/callback/<provider>` (the README's table for each provider's console).
- **Sign-in methods** (config `signIn`):
  - `password`: email and password (better-auth's `emailAndPassword`), on by default.
  - `magicLink`: a link by email; only with `email.send`.
  - `social`: any of better-auth's built-in providers by id (`google`, `github`, `microsoft`, `apple`,
    `discord`, `gitlab`…), each with `CHANNEL_WEB_<PROVIDER>_CLIENT_ID` and `_CLIENT_SECRET`.
  - `oidc`: any other OAuth2/OIDC platform (`genericOAuth`): `{ id, name, discoveryUrl, scopes? }`
    each, with `CHANNEL_WEB_OIDC_<ID>_CLIENT_ID` and `_CLIENT_SECRET`.
  A configured method whose secrets are missing refuses to start, naming the variables.
- **Who may have an account** (config `signUp`, a live setting when `settings` is installed):
  `invite` (default: only users the operator invited), `allowlist` (also anyone whose verified email
  matches `allow`: `ana@x.com` or `@company.com`), `open`. Enforced in one place,
  `databaseHooks.user.create.before`, for every method (password, link, OAuth); tests for each.
  An OAuth account links to an existing user only when the provider says the email is verified.
- **Email, when `email.send` is installed**: a self-made account's confirmation (required before its
  first session), "forgot password", the magic link, and the invitation itself.
- **No unverified password.** With email, a password sign-up's password is a random one nobody knows
  (the request's is replaced), and its confirmation is a link that sets the first password
  (`#/set-password?…&welcome=1`); setting a password with a link (an invitation, a reset, a
  confirmation) verifies the email. So whoever signs up with another person's address never holds a
  password that works once the owner confirms it (by that link, a magic link or a provider). Never inside a
  `storage.sql` transaction (there are none, above), never retried by better-auth: a failure is the
  route's error. **Without it**: no self-service reset or link; the operator's invitation and reset
  are links the operator copies (the dashboard shows them once).
- **Rate limits**: better-auth's own, in memory (one process on a server; the one accounts actor on
  Cloudflare), on sign-in, sign-up, reset and link routes, per client address: the one the server saw
  (`http.route`'s `x-pikit-client-address`: a server's socket peer, Cloudflare's `cf-connecting-ip`),
  never a header the client wrote, unless the operator names a proxy's header
  (`trustedProxyHeaders`: `x-forwarded-for`, or `cf-connecting-ip` behind a Cloudflare tunnel).
- **What the operator does** (`/admin/api/channel-web/*`, behind `admin.auth`, optional: without it
  the routes are absent): list users (id, name, email, methods, created, last seen, banned), invite
  (`{ email, name? }` → a link valid `inviteTtl`, emailed when `email.send` is installed), ban /
  unban (sessions revoked), remove (sessions, accounts; their conversations stay in the runtime and
  leave the index), a password-reset link. Logged with the operator's id, never a link or token.

### The channel
- **The sender** of each message is `{ channel: "web", id: <user id> }` (`InboundMessage.actor`), so a
  role by actor ([policy tools](../policy-tools.md)) and the steward's "only operators may ask it"
  (SPEC §6) see a user, not an operator.
- **Keys**: `web:<user id>:<chat id>`, `<chat id>` a UUID the server makes. The page names a
  conversation by its chat id only; every route builds the key from the authenticated user's id and
  the path's chat id, in one function (`keyOf(user, chatId)`), so a user can name no other user's
  conversation. Covered by tests on both targets: another user's chat id is `404`, for every route
  (read, messages, events, send, abort, rename, archive, unarchive, delete).
- **Request ids**: `web:<uuid>` (the page may send its own, for retries: `web:` then 1 to 118 of
  `A-Z a-z 0-9 . _ ~ : -`). Never `dashboard:`: `admitInbound` refuses it.
- **Admission** through `admitInbound` (the router, `inbound.normalize`, duplicates), images with
  the dashboard composer's limits (`attachmentsProblem`; on Cloudflare 1 MB in all), the body at most
  what they and the text need on that target (`maxBodyOf`).
- **Per-user rate**: `messagesPerMinute` (20 by default) of a user's messages, every conversation
  together; one too many is `429 rate_limited` with `retry-after`, before its body is read. Counted in
  memory where every message of a user passes: on a server the App; on Cloudflare the accounts actor,
  which the Worker asks before each message (`channel-web.rate`). A restart forgets it.
- **Since [chat parity](chat-parity.md)** the store is a transcript (`channel_web_entries`: the
  user's messages, and what each run that answered them wrote, stored when it ends), the page reads
  `GET .../transcript` and the live view gives the dashboard's event shapes, both cut by the operator's
  `visibility`; delivery writes an answer only for a run whose end was never heard. The bullets on
  answers and the live view below say how it was first built; the README and the API table below say what it is now.
- **Answers take the channels' path**: `startAnswerDelivery` (with `outbound.queue` when installed)
  whose transport delivers to the channel's own store: table `channel_web_messages` (the user's
  messages, written when admitted, and each answer, written by the transport, idempotent by its
  idempotency key). A run only `dashboard:` requests started is never delivered (the helper's own
  rule), so an operator's follow-up in a user's conversation is never shown to the user. The page
  reads `GET .../messages` from that table. The channel conformance suite runs with `answers:
  "pushed"`, its platform this table.
- **Where state is**: on a server, the App's `storage.sql`. On Cloudflare, each conversation's
  messages in its own object's `storage.sql` (where its delivery runs), the users' conversation index
  (`channel_web_conversations`: user, chat id, key, title, created, last activity, hidden) in the
  accounts actor, told by each object (`channel-web.seen`, as admin-api's index is).
- **Live view**: `GET /chat/api/conversations/:id/events`, server-sent events of `ChatEvent`s, a
  projection of `agent.observe`'s `watch` of the conversation's current runtime conversation, made in
  the App that holds it (on Cloudflare a stream from the object, `actor.mailbox.stream`): `state`
  (busy or not), `partial` (the answer as written: text only, no thinking; with its run's request
  ids when known), `tool` (a tool's name while it runs: no arguments, no results), `message` (a
  message or answer stored, or a message's state changed: read again; an answer's names the request it
  answers, so the page swaps the live text for it by identity, never by text).
  `partial` and `tool` only during a run whose inputs are known to include a message of the user's
  (a `web:` request id, from the watch's `submission` events, which come before the run that takes
  them). A run that answers both the user's message and an operator's follow-up is the user's, as
  delivery is. A run going when the view opened (a snapshot names inputs by submission id, which
  `agent.submissions` cannot turn into request ids) is named by the request that started it, which
  the App holding the conversation heard (`agent.started`). Fail closed: a run the view cannot name
  (its start not heard: a restart) streams nothing, its answer arriving as a `message`; the next run
  is named. So a run of the operator's own
  follow-up streams nothing to the user, even while the user's message waits. Never transcript
  entries, system prompts, tool results or operator notes.
- **Titles**: the first message, cleaned (`cleanTitle`); the user renames it. Later (chat-parity):
  a model titles it after its first answer unless the user renamed it, and each title is given to the
  App's `/name`, so the dashboard lists the same one (`titles.ts`).
- **Actions**: stop the run (`agent.runtime`'s `abort`, the conversation's current one); archive
  (listed apart, `?archived=1`, until the user restores it or new activity lists it again, as the
  dashboard's archive does); delete from the list (the index only: nothing of the runtime's is
  deleted). No reset: a new conversation is a new chat id. Slash commands: only those the config
  lets users type (below).
- **Projects** (added later): each user organizes their chats in projects, their own (another user's
  project id is `404` on every route, tested on both targets). A chat's project is fixed when it is
  made (`ChatStartRequest.project`), and so is its space: it is admitted with `AdmitOptions.space` =
  `web:<user id>:project:<project id>` (`projectSpace`), which `conversations.registry` records with the
  key's first resolve, so what the App keeps per space (memory, instructions, saved files) is shared by
  the project's chats; a chat of no project gives none (it is its own space). No moving a chat between
  projects. A project with chats (archived ones too; deleted ones not) is not deleted (`409
  not_empty`): the simplest rule that never changes a chat's place behind the user's back. Projects are
  kept beside the users' index (`channel_web_projects`; on Cloudflare in the accounts actor, the
  Worker's `channel-web.project*` calls); a chat made in a project deleted at that very moment (the
  index learns of the chat a moment later) lists with those of no project, its space kept.
- **Commands typed in the chat** (added later): `commands` (`"all"` or names; default `["rules",
  "prefs"]`, memory's per-user commands) cut the App's `agent.command`s (`allowedCommands`), given to
  `admitInbound` (`options.commands`): `/name args` for one of them is routed like any message, runs in
  its conversation with the user as sender, and is never dispatched nor stored in the transcript; the
  answer says what came of it (`ChatSendResponse.command`), which the page shows as a quiet note. A
  request id runs a command at most once: the conversation claims it before it runs
  (`channel_web_commands`, in the conversation's object on Cloudflare), and the same id again answers
  `duplicate` with the outcome (`unfinished` while it runs or when it never finished). A first message
  that is a command makes the chat, empty (titled `New conversation`): the command ran there, in its
  project's space.
- **Contract change, `agent.observe`**: from "read-only, for operators" to "read-only, for a reader the
  consumer authorized for that conversation: an operator (`admin.auth`), or a user of a channel for
  their own conversation; a consumer that shows it to a non-operator projects what that user may
  see". channel-web is the second consumer; its authorization is `keyOf`, its projection the live view
  above. docs/contracts.md and SPEC say so.
- **Absent**: no `/chat/`, no tables, nothing else changes.

### The API (`/chat/api`)
JSON typed in `api.ts` (no imports), copied identical into the page's `src/lib/chat-api.ts` (a test
checks). Errors `{ error, message? }`. Every route but `GET /chat/api/config` and `/chat/api/auth/*`
needs a session (`401`). State-changing routes also need `x-pikit-chat: 1` (a page of another site
cannot send it without CORS, which nothing allows).

| Route | Answer |
|---|---|
| `GET /chat/api/config` | `ChatConfig`: the assistant's name, sign-in methods (password, magic link, providers with display names), whether one may sign up, `visibility` (`{ thinking, tools: "none" \| "names" \| "full", context }`), `agents` (`{ name, description? }[]`, the ones users may pick) (chat-parity.md), `commands` (`{ name, description, argumentHint? }[]`, the ones users may type) |
| `/chat/api/auth/*` | better-auth (sign in, sign up, sign out, OAuth callbacks, verification, reset, link, account linking, sessions) |
| `GET /chat/api/me` | `ChatMe`: the user (id, name, email, image), their linked methods, and `suggestedAgent?`: the assistant Routing chooses for their new chat (a dry run of `route.resolve`, nothing made; on Cloudflare the accounts actor's, `channel-web.routed`), only when it is one of `ChatConfig.agents` |
| `GET /chat/api/projects` | `ChatPage<ChatProject>` (`{ id, name, createdAt, chats }`), the user's, by name (at most `MAX_PROJECTS`, 100) |
| `POST /chat/api/projects` | `{ name }` (1 to 60 characters) → `201 ChatProject` (`400` past `MAX_PROJECTS`) |
| `PATCH /chat/api/projects/:id` | `{ name }` → `200 ChatProject` |
| `DELETE /chat/api/projects/:id` | `204`; `409 not_empty` while it has chats |
| `GET /chat/api/conversations?limit&cursor&archived&q&project` | `ChatPage<ChatConversation>`, newest activity first: not archived, or with `archived=1` the archived ones; with `q`, those whose title holds it (any case); with `project`, that project's (`none`: those of no project; another user's `404`) |
| `POST /chat/api/conversations` | `ChatStartRequest` (a `ChatSendRequest`, `agent?`, one of `ChatConfig.agents`, else `400`, and `project?`, one of the user's, else `404`) → `201 ChatStartResponse` (`{ id, requestId, admission, command? }`; a command makes the chat too) |
| `GET /chat/api/conversations/:id` | `ChatConversation` (`id`, `title`, `busy`, `archived`, `lastActivity`, `createdAt`, `agent?` when one users may pick, `project?`) |
| `PATCH /chat/api/conversations/:id` | `{ title }` → `200 ChatConversation` |
| `POST /chat/api/conversations/:id/archive`, `.../unarchive` | `200 ChatConversation`: listed apart, or back in the list (the owner only; new activity lists an archived one again) |
| `DELETE /chat/api/conversations/:id` | `204` (the list only: gone for the user) |
| `GET /chat/api/conversations/:id/transcript?limit&cursor` | `ChatPage<ChatTranscriptEntry>`, newest first: admin-api's `ApiTranscriptEntry` (`{ id, kind, messages }`, pi-ai messages) cut by `visibility`; a user's message (id its request id, `state`: `pending`, `answered`, `failed`, `aborted`; images `{ type: "image", url, mimeType }`, never bytes) and each message its runs wrote (id `<run's request>#<hash>`, the id the live events gave it); at most `PAGE_JSON_MAX` (1 MiB) of stored JSON a page |
| `GET /chat/api/conversations/:id/messages/:messageId/images/:n` | one image's bytes of a user's message: the conversation's owner only, its type, `nosniff`, `cache-control: private, immutable` |
| `POST /chat/api/conversations/:id/messages` | `ChatSendRequest` → `202 ChatSendResponse` (`{ requestId, admission, command? }`: `admission` `command` when it was one of `ChatConfig.commands`, `command` its outcome `{ name, outcome: "ran" \| "failed" \| "unfinished", text? }`); `429` past `messagesPerMinute` |
| `GET /chat/api/conversations/:id/events` | server-sent `ChatEvent`s, admin-api's `ApiEvent` shapes (`snapshot` first, `run_*`, `message_*`, `tool_execution_*`, `entry_appended`) cut by `visibility`, the user's runs only; heartbeats; ends when the client goes |
| `POST /chat/api/conversations/:id/abort` | `200` |
| `GET /chat/*` | the page's files, under a Content-Security-Policy (`default-src 'self'`, images `'self'`, `data:`, `blob:` and the configured built-in providers' avatar hosts only) |

## 5. The page: `src/chat/`
A Vite + React + Tailwind v4 project of its own (section 3), built from the shared pieces (section 1):
`bui`, `markdown`, `message` (the answer's markdown), `PromptBar` (the composer, images), `error-note`.
- Sign-in: the methods `GET /chat/api/config` says (a button per provider, email and password, a
  link by email), sign-up when allowed, forgot password and the verification / reset / invitation
  landing pages better-auth's links lead to.
- The user's conversations (newest first; one menu, `ActionsMenu`, on the sidebar's rows, the list's
  and the conversation's header: rename, archive or restore, delete; the sidebar lists the latest 20,
  Conversations every one and the archived ones), one conversation (messages, the answer as written, the tool running, stop), a new one,
  the composer with images.
- Projects in the sidebar (under the chats; "New project"; each one's menu: a new chat in it, rename,
  delete): one opens Conversations showing its chats only (`#/chats?project=<id>`), searched and
  archived alike; a new chat in it says so over the composer (`#/?project=<id>`); a chat of a project
  names it in its header and in the list. The commands users may type have the composer's "/" menu;
  what one answered shows as a quiet note in the thread ("Only you see this"), never in the transcript.
- Settings (a modal from the user's menu at the sidebar's foot, the dashboard's settings dialog's
  frame and rows, `settings-shell`, `settings-rows`): profile (name), password, connected accounts
  (connect Google...), sessions (sign out the others), appearance; sign out from the same menu.
- Light and dark theme as the dashboard's; no admin code, route or import in its bundle.
- An answer's markdown image of another site is a link, never loaded (`MarkdownImages` `same-origin`;
  the CSP refuses it too): an answer cannot carry what it read out in an image's address. A failed
  sign-in's `?error=` is said by its code's known text only, never the address's own words.
- Reads the API with `fetch` and the session cookie; follows events with `fetch` (no `EventSource`).
  Polls only while the tab is visible (`lib-ui`'s `activity`).

## 6. Tests
- Accounts: the adapter suite; each sign-in method end to end against a fake OAuth/OIDC server and a
  fake email API; `signUp` modes, including OAuth and magic link sign-ups refused under `invite`;
  ban and removal; cookie names and paths; admin and chat sessions never open each other's routes.
- Isolation (adversarial): user B with user A's chat id gets `404` on every route, on a server and in
  workerd; an operator's follow-up in a user's conversation never appears in `messages` or `events`.
  So with user A's project id: rename, delete, the list by project and a new chat in it are `404`,
  nothing made or dispatched (server, the fake Cloudflare platform, workerd).
- Projects and spaces: two chats of a project record the same space, another project or user another,
  a chat of no project none (in workerd, read back from conversations-kv by a `/rules` fixture); the
  list by project, `none`, search within, archived apart; `409` while a project has chats.
- Commands: listed in the config (the default `rules`, `prefs`; `"all"`; `[]`), run in the
  conversation with the user as sender, never dispatched nor in the transcript, once by request id,
  a failure's message answered, a routing denial running nothing; a first message that is a command
  making the chat in its project's space.
- Channel conformance suite (`answers: "pushed"`), lifecycle suite, "what setup declares".
- Cloudflare: the workerd lane runs sign-up, sign-in, a message and its answer, the live view and the
  isolation cases through the Worker and the objects.
- `email.send`: the suite for both providers; SigV4 against AWS's published test vectors.
- UI: the boundary test, the copies' identity test, the page builds, `pikit add channel-web` then
  `pikit doctor` green, `pikit remove channel-web` leaves the project as it was.

## Pi first
Nothing in Pi: serving a chat page and authenticating its users is ingress, pikit's (SPEC P1). Pi
removed `pi-server` and `pi-client` in 1.2.0 ([kit follow-ups](../kit-follow-ups.md)); when Pi serves
sessions to a browser with authentication again, re-check whether the live part should use it.

## Where it is
- `packages/contracts/src/email.ts` and `createEmailSenderConformance`; `registry/components/email-ses/`,
  `registry/components/email-resend/`.
- `registry/dashboard/files/src` (the shared pieces), `scripts/ui-shared.ts`, `scripts/chat-shared.ts`
  (the chat's copies), `scripts/ui-registry.ts`.
- The CLI's UI projects: `packages/cli/src/project/ui-project.ts` (`pikit dev` builds each at start on a
  server and again on change), `registry/commands.ts` and `checks.ts` (`registry validate`).
- `registry/components/channel-web/`: `files/src/pikit/channel-web/` (routes, accounts, store, delivery,
  live view, the Worker's half), `chat/` (the page), `view/`, `settings/`, `command.ts`; its README
  says what it guarantees and how each part is tested. The workerd lane:
  `tests/workerd/test/channel-web.workerd.ts`.

## Open
- No automated browser test of the page, the view or the Settings section: they were tested end to
  end by hand in a browser (sign-up, sign-in, links, a conversation live, the operator's actions);
  their pure logic is in `scripts/chat.test.ts`.
- Rate limits and the per-user message count are in memory: a restart or an eviction forgets them.
- **Next: an Email section in the dashboard's Settings.** Today nothing in `/admin/` says how email is
  sent. Each `email.send` provider (`email-ses`, `email-resend`) ships a `settings/` section showing:
  the provider installed, its sender (`EMAIL_FROM`), whether each of its variables is set or missing
  (never a value), and a "Send test email" button (an admin route of the provider, behind
  `admin.auth`, sending to an address the operator types; logged without the address's body). The
  credentials stay where they are (`.env`, Cloudflare's secrets, `pikit configure`): settings never
  hold a secret (features/settings.md). Tests: the route's `401` first, a sent and a refused email
  against the provider's fake, no secret in any answer.

## Not in it
- One person across channels (a web user and their Telegram chat as one actor): keys stay per channel.
- Tenants: users of different clients on one App are [multi-tenant isolation](../multi-tenant-isolation.md);
  routing is not isolation.
- The chat hosted apart from the App (static files against `/chat/api`): CORS and cookies then need care.
- Passkeys, two-factor: better-auth plugins, later, on the same accounts.
