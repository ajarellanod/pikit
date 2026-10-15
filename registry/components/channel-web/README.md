# channel-web

People who are not operators talk to the assistant from a web page, `/chat/`, with accounts of their
own: they sign in with an email and a password, a link by email, Google, GitHub or any OAuth2/OIDC
platform, see and continue only their own conversations, watch the answer as it is written, attach
images and stop a run. A conversation reads as the dashboard's (the same JSON: a transcript of
pi-ai messages and pi-durable's live events), cut to what the operator lets users see (thinking,
tools, the Context panel); the operator may let them pick an assistant, and they search their
conversations by title. The operator invites, bans and removes them from the dashboard. The operator's
dashboard (`/admin/`) stays as it is: nothing of it in the users' page.

- **Provides:** `http.route`: the chat API (`/chat/api/*`, `api.ts`), better-auth's routes
  (`/chat/api/auth/*`), the page's files (`/chat/*`), and the operator's routes over the users
  (`/admin/api/channel-web/*`, `admin-api.ts`).
- **Requires:** `secrets`, `conversations.registry`, `agent.runtime`, `agent.observe` (the live
  view), `agent.submissions` (answers, and the states of messages whose run's end no event brought),
  `storage.kv` (the delivery cursor), `storage.sql` (accounts, conversations, transcripts). A router
  (`router-basic`) picks the agent.
- **Uses, if installed:** `outbound.queue` (answers stored before they are written), `wakeups`
  (delivery on a Durable Object), `settings` (sign-up, visibility and the agents users may pick change
  live), `agent.definition` / `agent.directory` (the agents users may pick, described), `email.send` (verification,
  "forgot password", magic links, invitations by email), `admin.auth` (without it, the operator's
  routes answer `404`), `actor.inbox` / `actor.mailbox` (Cloudflare).
- **Targets:** `server` and `durable`, from one code (below).
- **Installs to:** `src/pikit/channel-web/`; with a UI, its view and Settings section to
  `src/dashboard/src/views/channel-web/` and `src/dashboard/src/settings/channel-web/`. Adds the command
  `pikit channel-web`.
- **npm dependencies:** `better-auth` (1.7.7, `better-auth/minimal`, no Kysely), `typebox`.

## Environment

| Variable | | What |
|---|---|---|
| `CHANNEL_WEB_AUTH_SECRET` | secret, required | What sessions are signed with: at least 32 random characters (`openssl rand -base64 48`). Never the admin token. Changing it signs every user out. It refuses to start without it. |
| `PIKIT_PUBLIC_URL` | needed to serve the chat publicly from a server | The chat's public origin (`https://chat.example.com`): every link (an email's, an OAuth redirect URI, an invitation) is made under it. Absent, a server answers sign-in and makes links only at a loopback host (`localhost`, `127.0.0.1`, `[::1]`): any other `Host` is `400 public_url_required`, since a client writes it (it says so at start). On Cloudflare, absent, the Worker's own host (Cloudflare routes by it). |
| `CHANNEL_WEB_<ID>_CLIENT_ID`, `_CLIENT_SECRET` | secret, per provider | For each id of `signIn.social` (`google` → `CHANNEL_WEB_GOOGLE_CLIENT_ID`; `-` becomes `_`). |
| `CHANNEL_WEB_OIDC_<ID>_CLIENT_ID`, `_CLIENT_SECRET` | secret, per platform | For each `signIn.oidc` entry. |

A configured method whose variables are missing refuses to start, naming them (never a value). Each
provider's console takes the redirect URI `<origin>/chat/api/auth/callback/<id>` (Google, GitHub, an
OIDC platform alike).

## Config

```ts
"channel-web": {
  name: "Ada",                                   // the page's title
  signIn: {
    password: true,                              // email and password (default)
    magicLink: false,                            // a link by email: needs email.send
    social: ["google", "github"],                // better-auth's built-in providers
    oidc: [{ id: "corp", name: "Corp SSO", discoveryUrl: "https://sso.example.com/.well-known/openid-configuration" }],
  },
  signUp: { mode: "invite", allow: [] },         // invite | allowlist ("ana@x.com", "@company.com") | open
  sessionCacheSeconds: 300,                      // how long the signed cookie vouches without a database read
  inviteTtlHours: 72,
  heartbeatMs: 15000,                            // a comment on idle live streams
  messagesPerMinute: 20,                         // a user's messages a minute, all conversations: 429 past it
  trustedProxyHeaders: [],                       // e.g. ["x-forwarded-for"]: only behind a proxy that sets it
  visibility: { thinking: false, tools: "names", context: true }, // what users see (below)
  agents: [],                                    // the agents users may pick for a new chat; none: the router decides
}
```

`signUp`, `visibility` and `agents` are also settings when `settings` is installed (the dashboard's
Settings, Web chat): the operator changes them live, read at each request; the config's values are
their defaults.

**`visibility`** is what users see of a conversation, applied to every transcript entry and live event
when they are read (`visibility.ts`; a change applies to history too):

| Value | Shows | Never |
|---|---|---|
| `thinking: false` (default) | | the model's thinking (blocks, deltas, signatures) |
| `thinking: true` | the thinking blocks | their signatures |
| `tools: "none"` | | any tool call, result or event (an answer made only of tool calls is left out) |
| `tools: "names"` (default) | a call's name, its result's `isError`, tool events by name | arguments, output, a result's content |
| `tools: "full"` | arguments, output, results' content | a result's `details` |
| `context: true` (default) / `false` | whether the page shows the Context panel (images sent; sources with `tools: "full"`) | |

Whatever it says, never: a system prompt, the user's message as the runtime holds it, an operator's
messages or the runs only they started, usage or cost, a model's or provider's name, the provider's
error text (a failed answer says so plainly).

**`agents`**: names of `agent.definition`s or live agents (`agent.directory`). `ChatConfig.agents` lists
those that are agents now (a live one with its description); `POST /chat/api/conversations` takes one
of them (`agent`, else `400`), and the conversation is made with it (`conversations.registry.resolve`
before `admitInbound`): routing still allows or denies the message, and the conversation keeps it. A
conversation says its `agent` only when it is one users may pick.

## What the operator does

The operator's routes (`/admin/api/channel-web/*`, `admin-api.ts`) answer only with an `admin.auth`
installed (`admin-auth-token`). Three ways in, the same routes behind each:

- **The dashboard's Web users view** (`view/`, installed to `src/dashboard/src/views/channel-web/`
  when the project has a UI; shown while `admin.auth` is provided): every user (name, email, how they
  sign in, created, last seen, state: active, invited, banned; last seen is the user's own, written at
  each sign-in and at most once per `sessionCacheSeconds` of use, so a ban or "sign out everywhere" keeps
  it, and someone who came once is never "invited" again), 20 a page with "Showing 1–20 of 57" and the
  pages under the table, a search (name, email or id) and filters by state, each with its count; the
  search, the filter and the counts are the server's (`GET /admin/api/channel-web/users?limit&offset&state&q`
  answers the page, `total` and `counts`), so they cover every user, not a page. Each row's actions
  (its "..." menu, `ActionsMenu`):
  Invite (an email, a name if you like), a password-reset link (an invited user who never came: a new
  invitation instead), Ban / Unban, Remove (behind a confirmation; a ban's latency is under "Ban
  latency" below). A link is shown once, on one line with a Copy button. It uses only the primitives the
  base dashboard ships. `view/admin-api.ts` is an identical copy of the component's (a test checks).
- **Settings, Web chat** (`settings/`, while `settings` is provided): who may make an account
  (`signUp.mode`: invited only, an allow list, anyone) and the allow list (`ana@example.com`, or
  `@example.com` for a whole domain); what users see (Thinking, Tools: None, Names or Full, Context);
  the assistants users may pick (a switch per agent of the App). It stores only what differs from the
  config's values.
- **`pikit channel-web`** (the component's command, `command.ts`), from the project's directory:

  ```sh
  pikit channel-web users                           # id, email, name, sign-in methods, created, last seen, state
  pikit channel-web invite ana@example.com --name Ana
  pikit channel-web reset ana@example.com           # a user's id or email
  pikit channel-web ban ana@example.com             # unban, likewise
  pikit channel-web remove ana@example.com          # asks first; --yes without a terminal
  ```

  It signs in with `PIKIT_ADMIN_TOKEN` (the environment, or `.env`) and talks to `--url <origin>`,
  else `PIKIT_PUBLIC_URL`, else this machine's App (`pikit dev`: `http://127.0.0.1:8787` with
  deployment-cloudflare, else server-bun's port, 3000 by default). Behind `pikit expose`, the public
  URL serves only the paths it exposes: pass `--url http://127.0.0.1:3000` to reach the App itself.

**A link is shown once.** An invitation or a reset link is in the dialog (or the command's output)
that made it, with whether it was emailed too (`email.send`) and until when it works
(`inviteTtlHours`); never in the list, a log or the API again. Anyone with it can set the password:
send it over a channel you trust. Without `email.send`, sending it is yours. It names the account's
email (`&email=`), which the page shows read-only and signs in with once the password is set.

## What it guarantees

- **Links under a trusted origin.** Every absolute URL the accounts make (an email's link, an OAuth
  redirect URI, better-auth's trusted origin, an operator's invitation or reset) is under
  `PIKIT_PUBLIC_URL`, or without it under the request's own origin only when that is trusted: a
  loopback host on a server, the Worker's host on Cloudflare. A request with another `Host` is `400`
  before anything is made (`accounts/links.ts`, `linkOrigin`): no reset or magic link ever goes out
  under a host a client chose.
- **Client addresses.** better-auth's rate limits (sign-in, sign-up, links) count by the address the
  server saw (`x-pikit-client-address`, `http.route`): a client's `x-forwarded-for` changes nothing.
  Behind a proxy every request has the proxy's address and they share one count: name the header the
  proxy sets in `trustedProxyHeaders` (`x-forwarded-for` when it sets one address, `cf-connecting-ip`
  behind a Cloudflare tunnel), never one a client can reach the App without.
- **Per-user rate.** At most `messagesPerMinute` messages a user a minute, every conversation together:
  past it `429 rate_limited` with `retry-after`, before the body is read. In memory: the App's on a
  server, the accounts actor's on Cloudflare (the Worker asks it before each message). A restart or an
  eviction forgets it.
- **No unverified password.** With `email.send`, a password sign-up's password is random (the page
  asks none) and the confirmation email is a link that sets the first one; setting a password with a
  link verifies the email. Someone who signs up with another person's address never holds a password
  that works once its owner comes (by that link, a magic link or a provider). Without `email.send` no
  address is verified: a provider never links to such an account (better-auth's rule), and an operator
  removes a squatted one.

- **Isolation.** A conversation's key is `web:<user id>:<chat id>`, the chat id a UUID the server
  makes. Every route builds it from the session's user and the path's chat id, in one function
  (`keyOf`, `chat.ts`): a user can name no other user's conversation. Another user's chat id is `404`
  on every route, as one that never existed (tested adversarially on both targets' code paths).
- **Sessions.** Every `/chat/api/*` route but `GET /chat/api/config` and `/chat/api/auth/*` needs a
  user's session (`401`). A route that changes something also needs `x-pikit-chat: 1` (`400`): a page
  of another site cannot send it. Cookies `pikit_chat.*`, path `/chat/`, `HttpOnly`, `SameSite=Lax`,
  `Secure` on https. A chat session never opens `/admin/api/*`, an operator's credential never opens
  `/chat/api/*`. better-auth's origin and CSRF checks are on (said in its config, never left to its
  default, which turns them off under `NODE_ENV=test`): a request to `/chat/api/auth/*` carrying the
  cookies whose `Origin` (else `Referer`) is another site's is `403`, on a server and through the
  Worker's forwarding alike.
- **Ban latency.** A ban or a removal revokes the user's sessions at once, but a session already
  vouched for by its signed cookie cache stays good until the cache expires: at most
  `sessionCacheSeconds` (5 minutes by default). Set it lower, or `0`, for an immediate effect at the
  cost of a database read (on Cloudflare a call to the accounts actor) per request.
- **Cache renewal.** Once the cache expired, a route reads the session from the database (on
  Cloudflare one call to the accounts actor) with better-auth's own `getSession`, and sends back the
  renewed cache cookie it set (`Accounts.user` returns the user and those `set-cookie` values; the
  accounts actor's answer carries them to the Worker): one read per browser per `sessionCacheSeconds`,
  not one per request. Renewed only after a real database read: better-auth's `refreshCache` (which
  re-signs the cache without reading) stays off, so a ban or a removal still takes effect within
  `sessionCacheSeconds`. (Done on the server, not by the page polling `/chat/api/auth/get-session`: no
  timer, and every route renews it, the live stream included.)
- **What a user sees** of their conversation: their own messages, and what the runs that answered
  them wrote, cut by `visibility`. The sender of each message is `{ channel: "web", id: <user id> }`,
  so roles by actor see a user, not an operator. An operator's follow-up from the dashboard
  (`dashboard:` request ids) and a run only such follow-ups started are never stored for the user nor
  streamed (only that a run goes: `run_start`, `run_end`).
- **History.** A run that answered one of the user's messages is stored whole when it ends
  (`agent.settled`, `agent.failed`): `AgentResult.messages` (the assistant's, with thinking and tool
  calls, and the tools' results; never the runtime's user or system messages), in the turn of the
  newest user message it answered. An aborted or failed run keeps what it wrote. Its end heard twice
  (a restart re-announces it) stores it once. The transcript (`GET .../transcript`, newest first,
  paged, at most 1 MiB of stored JSON a page) is the user's messages (`{ type: "image", url, mimeType }`
  for each image: `GET .../messages/:messageId/images/:n`, the owner only, its type, `nosniff`, cached
  privately; image bytes are read one at a time, never in a page) and those messages, each its own
  entry.
- **One id per entry, live or read.** A user's message's id is its request id; a run's message's is
  `<the run's first request>#<hash of the message itself>` (its role, time, tool call id, blocks' text
  and ids: `entries.ts`). The live view announces each message the run writes (`message_end`'s
  `entry`) with that id and in that form, and the transcript reads it so later: a view merging them by
  id never shows one twice nor swaps one for another when the run ends.
- **A message sent while a run goes waits out of the transcript** and of the live view until that run
  ends (its messages are stored only then); then it is announced (`entry_appended`) after them. The
  page shows it as sent meanwhile.
- **Live view** (`live.ts`): pi-durable's events in the dashboard's shapes (a `snapshot` first,
  `run_start`, `run_end`, `message_*`, `tool_execution_*`, `entry_appended`), the answer and the tools
  only during a run whose inputs are known to include one of the user's messages (by the request ids
  the runtime's own events give before the run starts). A run that answers both the user's message and
  an operator's follow-up is the user's. A run already going when the view opened is named by the
  request that started it, which its App heard (`agent.started`), so a first message's answer streams
  even when the page follows it late. It fails closed: a run it cannot name (its start not heard: the
  process restarted) streams nothing, and its messages come with the transcript once stored. Never a
  runtime's own entry, a system prompt, usage or cost. `entry_appended` without an entry: something
  stored changed (a run's messages, a message's state): read the transcript again.
- **Messages** go through `admitInbound` (the router, `inbound.normalize`, duplicates by request id),
  with their images (at most 4 PNG, JPEG, WebP or GIF, 5 MB each; 1 MB in all on Cloudflare; the body
  at most what those and the text need, `maxBodyOf`). The
  page may name its request (`web:` then 1 to 118 of `A-Z a-z 0-9 . _ ~ : -`): sent again, it runs
  once. A first message sent again reaches the same conversation (its chat id comes from the request
  id). A refusal is the route's status (`403` denied, `422` a stage halted it, `500` no router); a
  runtime that cannot take it now is `503`, and the page sends it again. A user's message is
  `pending`, then `answered`, `failed` or `aborted` when its run ends (from `agent.settled` /
  `agent.failed`, and from `agent.submissions` when the page reads a message whose run's end no event
  brought).
- **Answers also take the channels' path**: `startAnswerDelivery` (with `outbound.queue` when
  installed) writes a completed run's answer into the channel's table only for a run none of whose
  messages are stored (its end never heard here: after waiting a second for it), at least once, stored
  once, delivered after a restart or an eviction; the run's messages, stored later, replace it.
- **Search**: `GET /chat/api/conversations?q=` lists the user's own conversations whose title holds
  `q` (any case, accents too; `%` and `_` are characters), paged, archived ones apart (`archived=1`). On
  Cloudflare the accounts actor's index answers it.
- **Archiving** a conversation lists it apart (`GET /chat/api/conversations?archived=1`; `POST
  .../archive`, `.../unarchive`, the owner only): still theirs, read and written to, and a new message
  or answer in it lists it again, as the dashboard's archive does. On Cloudflare the conversation's
  object keeps the flag and tells the index (`channel-web.seen`).
- **Deleting** a conversation takes it out of the user's list (and every route `404`s it): nothing of
  the runtime's is deleted. Removing a user takes their sessions and accounts, and their
  conversations out of the users' list; the runtime keeps them.
- **No transactions in the accounts.** `storage.sql`'s transactions run statements only, and
  better-auth hashes passwords and calls our email sender inside its own, so its multi-step writes run
  one statement at a time (`accounts/adapter.ts`): a crash between two leaves a user who can sign in
  again or be removed, and an invitation whose link was not made yet is sent again.
- **Logs** carry user ids, chat ids, request ids and operator ids: never a message's text or images,
  a link or a token.

## Two targets, one code

In `start`, `actor.inbox`'s `scope` says where it runs:

- **A server** (`"all"`, or no `actor.inbox`): the default export does everything in the App: the
  routes, the accounts (better-auth over the App's `storage.sql`), the store
  (`channel_web_conversations`, `channel_web_entries`), delivery.
- **Cloudflare** (`"one"`): the default export goes in each conversation's Durable Object, which
  admits the Worker's messages, answers its calls about this conversation (`calls.ts`), keeps its
  transcript, stores what its runs wrote and tells the users' index (`channel-web.seen`) of each change. One
  object, `channel-web:accounts`, holds the accounts and the index, and answers the Worker's
  `channel-web.auth.*` calls (`wiring.ts`). Every object registers those handlers and the index's
  (one class), but only `channel-web:accounts` answers them: any other refuses (`no_handler`). The Worker's half (`export const worker`, config key
  `channel-web-worker`) serves the routes: a call to the conversation's object, the list one call to
  the index, live events a stream from the object, better-auth's routes forwarded as JSON with every
  `set-cookie`, and the session from the signed cookie cache when it can (no call), else a call. The
  page's config (`GET /chat/api/config`) is the accounts actor's (`channel-web.config`, kept 10 s in
  the Worker): its sign-in methods, its live settings (sign-up mode, visibility, the agents users may
  pick), and whether its App sends email, so `email.send` goes in the default App only (the accounts
  actor sends), never in the Worker's. The Worker cuts the transcript and the live events the objects
  give it by that config's `visibility`: a change shows within 10 s.

On Cloudflare one script holds both Apps: channel-web adds about 1.3 MiB to it (265 KiB gzip; better-auth,
its core, zod, jose, OpenTelemetry's conventions), measured with wrangler 4.143.0 on a Worker of
runtime-pi, provider-anthropic, admin-api and the platform's components (3.3 MiB, 649 KiB gzip with
it).

```ts
import channelWeb, { worker as channelWebWorker } from "./src/pikit/channel-web/index.ts";
export const worker = defineApp({ components: [/* … */ channelWebWorker] });
export default defineApp({ components: [/* … */ channelWeb] });
```

## The page

`/chat/` serves `chat-files.ts`, the module the page's build writes (`src/chat/`). The kit's copy is
empty: `/chat/` then says no page is built, and the API works alone. Every file is served under a
Content-Security-Policy: same origin only, images also `data:`, `blob:` and the avatar hosts of the
configured built-in providers (`google`: `*.googleusercontent.com`, `github`:
`avatars.githubusercontent.com`…; an OIDC platform's are not shown). An answer's markdown image of
another site is shown as a link, never loaded: an answer cannot carry what it read out in an image's
address. A failed sign-in's `?error=` shows its code's known text, else a generic one, never the
address's own words.

**Use https.** On plain http the cookies have no `__Secure-` prefix and no `Secure` flag, and anyone on
the network reads the session: http is for `localhost` only. Serve any other deployment over https
(`PIKIT_PUBLIC_URL=https://…`; behind a proxy that ends TLS, the App still makes `__Secure-` cookies
under an https `PIKIT_PUBLIC_URL`).

## How it is tested

- `channel-web.test.ts`: every route on a server, over the runtime's doubles (`runtime.test-support.ts`)
  and a double of the accounts: config, sessions and the page's header, conversations, the list and
  its cursor, isolation (another user's chat id `404` on every route, the transcript and the search
  included), history (a run's messages stored once with the message it answered, the runtime's user
  message never, a failed run's kept, pages), a lost run end (its state read, its answer delivered,
  replaced when heard late), a run that ends before its admission returns (a quick model: not busy, its
  message answered), an operator's follow-up and its run never shown, live events in the dashboard's
  shapes with `message_end`'s entry the transcript's (same id, same messages), a message held behind a
  run, the policy as a live setting on history and live events, the agents users may pick (allowed,
  refused, denied by routing, taken away), the search, stop, duplicates, request ids, images and body
  limits, refusals, the operator's routes, the live `signUp` setting, what setup declares, the
  lifecycle suite.
- `visibility.test.ts`: each policy value on messages, entries and live events (a hidden block's
  deltas left out and the next renumbered), and what never shows under the defaults.
- Security cases: a spoofed `Host` gets no link nor email and `400` (accounts, the operator's routes),
  loopback hosts and `PIKIT_PUBLIC_URL` work; a client's `x-forwarded-for` never resets a rate limit,
  distinct addresses never share one; a squatter's password never works once the owner comes (magic
  link, confirmation); a user's `messagesPerMinute` (server and Worker); images by URL, never in a page,
  the owner only; a page's text bound; the accounts' and index's calls refused on any key but the
  accounts actor's; `live.test.ts`: a view opened during an operator-only run, the user's message
  queued, streams nothing of it (the reviewer's probe), the user's next run streams; a run's messages
  announced with the transcript's ids, the runtime's user and system messages and own entries never.
- `conformance.test.ts`: the channel conformance suite (`answers: "pushed"`), the platform being the
  table (its writes failed or left hanging by the fixture).
- `remote.test.ts`: the Worker's half over a fake platform of one App per key (`scope: "one"`), each
  conversation's object and the accounts actor: start, list, rename, the transcript, a run's messages,
  delete, isolation, live events cut in the Worker, entries told live from the object, the policy and
  the agents from the accounts actor's config, an agent picked reaching the object, the search in the
  index, image limits, an unreachable object, the index's versions (not busy after a run that ended
  before its admission returned), removal.
- `accounts-wiring.test.ts`: the real accounts (better-auth) through the routes, on a server and
  forwarded to the accounts actor on Cloudflare (the cookie cache first, its renewal sent back after a
  database read); chat and admin sessions never open each other's routes; every better-auth route the
  page uses reachable on both targets; an OIDC sign-in through the Worker (form_post, then the GET
  callback's `302` with its Location and both session cookies); a foreign `Origin` or `Referer` refused. `accounts/*.test.ts` test the accounts themselves.
- `command.test.ts`: `pikit channel-web` against a fake of the operator's routes (`Bun.serve`): the
  list page by page, invite (the link printed once, emailed or not), reset, ban and unban by id or
  email, remove asked first (`--yes` without a terminal), the App's origin, and each failure said
  (no token, a wrong one, no App, no routes, bad arguments).
- The view and the Settings section compile and bundle with the dashboard (`bun
  scripts/dashboard-build.ts` in the kit).
- The kit's workerd lane (`tests/workerd/test/channel-web.workerd.ts`): on real Durable Objects
  (deployment-cloudflare's class) through the Worker's `fetch`, composed as a project's (storage-do,
  storage-kv-sql, actors-do, runtime-pi with provider-faux, conversations-kv, router-basic,
  outbound-durable, admin-auth-token, admin-api): better-auth in the accounts actor (its bundle,
  AsyncLocalStorage, scrypt from `node:crypto`, Web Crypto), sign-up and sign-in with a password, the
  cookies (`__Secure-` and `Secure` on https only, path `/chat/`), a message and its answer (the
  transcript), the live view (`snapshot`, `message_*` whose entry ids the transcript has), another
  user's every route on a chat `404`, an operator's follow-up never in the user's transcript or live
  view, the search, an agent picked, the accounts' tables in the accounts actor only;
  an invitation's link setting a password, a ban refused once the cookie cache expired (the actor asked
  then, its answer renewing the cache cookie; a foreign `Origin` refused through the forwarder);
  `email.send` in the default App only: the config says so, a magic link signs a new user in, a
  password sign-up verifies first, an invitation is emailed.

Not covered yet: the page, the view and the Settings section in a browser.
