# channel-web

People who are not operators talk to the assistant from a web page, `/chat/`, with accounts of their
own: they sign in with an email and a password, a link by email, Google, GitHub or any OAuth2/OIDC
platform, see and continue only their own conversations, watch the answer as it is written, attach
images and stop a run. The operator invites, bans and removes them from the dashboard. The operator's
dashboard (`/admin/`) stays as it is: nothing of it in the users' page.

- **Provides:** `http.route`: the chat API (`/chat/api/*`, `api.ts`), better-auth's routes
  (`/chat/api/auth/*`), the page's files (`/chat/*`), and the operator's routes over the users
  (`/admin/api/channel-web/*`, `admin-api.ts`).
- **Requires:** `secrets`, `conversations.registry`, `agent.runtime`, `agent.observe` (the live
  view), `agent.submissions` (answers, and the states of messages whose run's end no event brought),
  `storage.kv` (the delivery cursor), `storage.sql` (accounts, conversations, messages). A router
  (`router-basic`) picks the agent.
- **Uses, if installed:** `outbound.queue` (answers stored before they are written), `wakeups`
  (delivery on a Durable Object), `settings` (sign-up changes live), `email.send` (verification,
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
}
```

`signUp` is also a setting when `settings` is installed (the dashboard's Settings, Web chat): the
operator changes it live, read at each sign-up; the config's value is its default.

## What the operator does

The operator's routes (`/admin/api/channel-web/*`, `admin-api.ts`) answer only with an `admin.auth`
installed (`admin-auth-token`). Three ways in, the same routes behind each:

- **The dashboard's Web users view** (`view/`, installed to `src/dashboard/src/views/channel-web/`
  when the project has a UI; shown while `admin.auth` is provided): every user (name, email, how they
  sign in, created, last seen, state: active, invited, banned), a search and filters, and the actions:
  Invite (an email, a name if you like), a password-reset link (an invited user who never came: a new
  invitation instead), Ban / Unban, Remove (behind a confirmation). It uses only the primitives the
  base dashboard ships. `view/admin-api.ts` is an identical copy of the component's (a test checks).
- **Settings, Web chat** (`settings/`, while `settings` is provided): who may make an account
  (`signUp.mode`: invited only, an allow list, anyone) and the allow list (`ana@example.com`, or
  `@example.com` for a whole domain). It stores only what differs from the config's `signUp`.
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
send it over a channel you trust. Without `email.send`, sending it is yours.

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
- **What a user sees** of their conversation: their own messages, and the answers delivered to it.
  The sender of each message is `{ channel: "web", id: <user id> }`, so roles by actor see a user, not
  an operator. An operator's follow-up from the dashboard (`dashboard:` request ids) is never
  delivered (`startAnswerDelivery`'s own rule) and streams nothing live: the live view sends the
  answer as written and the tools' names only during a run whose inputs are known to include one of
  the user's messages (by the request ids the runtime's own events give before the run starts). A run
  that answers both the user's message and an operator's follow-up is the user's, as delivery is. It
  names a run already going when the view opened by the request that started it, which its App heard
  (`agent.started`), so a first message's answer streams even when the page follows it late. It fails
  closed: a run it cannot name (its start not heard: the process restarted) streams nothing, and its
  answer comes as a message once stored. Never thinking, tool arguments or results, system prompts or
  transcript entries (`live.ts`).
- **Live text and stored answer by identity.** A `partial` event carries its run's request ids
  (`requests`, when the runtime's events gave them), the `message` event of a stored answer the request
  its key names (`answers`), and every change of a user's message's state (its run's end, or a run end
  found when the page reads) is a `message` event too, sent where the live view is made (on Cloudflare
  the conversation's object). The page keeps a finished answer's live text until the messages it reads
  have that answer's id, never by comparing texts.
- **Messages** go through `admitInbound` (the router, `inbound.normalize`, duplicates by request id),
  with their images (at most 4 PNG, JPEG, WebP or GIF, 5 MB each; 1 MB in all on Cloudflare; the body
  at most what those and the text need, `maxBodyOf`). A page of messages names each image by its URL
  (`GET .../messages/:messageId/images/:n`: the owner only, its type, `nosniff`, cached privately) and
  holds at most 1 MiB of text; image bytes are read one at a time, never in a page. The
  page may name its request (`web:` then 1 to 118 of `A-Z a-z 0-9 . _ ~ : -`): sent again, it runs
  once. A first message sent again reaches the same conversation (its chat id comes from the request
  id). A refusal is the route's status (`403` denied, `422` a stage halted it, `500` no router); a
  runtime that cannot take it now is `503`, and the page sends it again.
- **Answers** take the channels' path: `startAnswerDelivery` (with `outbound.queue` when installed)
  writes each answer into the channel's table under its idempotency key, at least once, stored once,
  delivered after a restart or an eviction. A user's message is `pending`, then `answered`, `failed`
  or `aborted` when its run ends (from `agent.settled` / `agent.failed`, and from `agent.submissions`
  when the page reads a message whose run's end no event brought).
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
  (`channel_web_conversations`, `channel_web_messages`), delivery.
- **Cloudflare** (`"one"`): the default export goes in each conversation's Durable Object, which
  admits the Worker's messages, answers its calls about this conversation (`calls.ts`), keeps its
  messages, delivers its answers and tells the users' index (`channel-web.seen`) of each change. One
  object, `channel-web:accounts`, holds the accounts and the index, and answers the Worker's
  `channel-web.auth.*` calls (`wiring.ts`). Every object registers those handlers and the index's
  (one class), but only `channel-web:accounts` answers them: any other refuses (`no_handler`). The Worker's half (`export const worker`, config key
  `channel-web-worker`) serves the routes: a call to the conversation's object, the list one call to
  the index, live events a stream from the object, better-auth's routes forwarded as JSON with every
  `set-cookie`, and the session from the signed cookie cache when it can (no call), else a call. The
  page's config (`GET /chat/api/config`) is the accounts actor's (`channel-web.config`, kept 10 s in
  the Worker): its sign-in methods, the live sign-up mode, and whether its App sends email, so
  `email.send` goes in the default App only (the accounts actor sends), never in the Worker's.

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
  its cursor, isolation (another user's chat id `404` on every route), answers and states, a lost run
  end, a run that ends before its admission returns (a quick model: not busy, its message answered),
  an operator's follow-up never shown, live events, stop, duplicates, request ids, images and body
  limits, refusals, the operator's routes, the live `signUp` setting, what setup declares, the
  lifecycle suite.
- Security cases: a spoofed `Host` gets no link nor email and `400` (accounts, the operator's routes),
  loopback hosts and `PIKIT_PUBLIC_URL` work; a client's `x-forwarded-for` never resets a rate limit,
  distinct addresses never share one; a squatter's password never works once the owner comes (magic
  link, confirmation); a user's `messagesPerMinute` (server and Worker); images by URL, never in a page,
  the owner only; a page's text bound; the accounts' and index's calls refused on any key but the
  accounts actor's; `live.test.ts`: a view opened during an operator-only run, the user's message
  queued, streams nothing of it (the reviewer's probe), the user's next run streams.
- `conformance.test.ts`: the channel conformance suite (`answers: "pushed"`), the platform being the
  table (its writes failed or left hanging by the fixture).
- `remote.test.ts`: the Worker's half over a fake platform of one App per key (`scope: "one"`), each
  conversation's object and the accounts actor: start, list, rename, messages, answers, delete,
  isolation, live events, image limits, an unreachable object, the index's versions (not busy after a
  run that ended before its admission returned), removal.
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
  cookies (`__Secure-` and `Secure` on https only, path `/chat/`), a message and its answer, the live
  view (`state`, `partial`, `message`), another user's every route on a chat `404`, an operator's
  follow-up never in the user's messages or live view, the accounts' tables in the accounts actor only;
  an invitation's link setting a password, a ban refused once the cookie cache expired (the actor asked
  then, its answer renewing the cache cookie; a foreign `Origin` refused through the forwarder);
  `email.send` in the default App only: the config says so, a magic link signs a new user in, a
  password sign-up verifies first, an invitation is emailed.

Not covered yet: the page, the view and the Settings section in a browser.
