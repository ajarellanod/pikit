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
- **Installs to:** `src/pikit/channel-web/`.
- **npm dependencies:** `better-auth` (1.7.7, `better-auth/minimal`, no Kysely), `typebox`.

## Environment

| Variable | | What |
|---|---|---|
| `CHANNEL_WEB_AUTH_SECRET` | secret, required | What sessions are signed with: at least 32 random characters (`openssl rand -base64 48`). Never the admin token. Changing it signs every user out. It refuses to start without it. |
| `PIKIT_PUBLIC_URL` | optional | The public origin (`https://chat.example.com`) when a proxy hides it: redirect URIs and links are made under it. Absent, each request's origin. |
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
}
```

`signUp` is also a setting when `settings` is installed (the dashboard's Settings): the operator
changes it live, read at each sign-up; the config's value is its default.

## What it guarantees

- **Isolation.** A conversation's key is `web:<user id>:<chat id>`, the chat id a UUID the server
  makes. Every route builds it from the session's user and the path's chat id, in one function
  (`keyOf`, `chat.ts`): a user can name no other user's conversation. Another user's chat id is `404`
  on every route, as one that never existed (tested adversarially on both targets' code paths).
- **Sessions.** Every `/chat/api/*` route but `GET /chat/api/config` and `/chat/api/auth/*` needs a
  user's session (`401`). A route that changes something also needs `x-pikit-chat: 1` (`400`): a page
  of another site cannot send it. Cookies `pikit_chat.*`, path `/chat/`, `HttpOnly`, `SameSite=Lax`,
  `Secure` on https. A chat session never opens `/admin/api/*`, an operator's credential never opens
  `/chat/api/*`.
- **Ban latency.** A ban or a removal revokes the user's sessions at once, but a session already
  vouched for by its signed cookie cache stays good until the cache expires: at most
  `sessionCacheSeconds` (5 minutes by default). Set it lower, or `0`, for an immediate effect at the
  cost of a database read (on Cloudflare a call to the accounts actor) per request.
- **What a user sees** of their conversation: their own messages, and the answers delivered to it.
  The sender of each message is `{ channel: "web", id: <user id> }`, so roles by actor see a user, not
  an operator. An operator's follow-up from the dashboard (`dashboard:` request ids) is never
  delivered (`startAnswerDelivery`'s own rule) and streams nothing live: the live view sends the
  answer as written and the tools' names only while the user has a message not answered yet, and
  never thinking, tool arguments or results, system prompts or transcript entries (`live.ts`).
- **Messages** go through `admitInbound` (the router, `inbound.normalize`, duplicates by request id),
  with their images (at most 4 PNG, JPEG, WebP or GIF, 5 MB each; 1 MB in all on Cloudflare). The
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
  `channel-web.auth.*` calls (`wiring.ts`). The Worker's half (`export const worker`, config key
  `channel-web-worker`) serves the routes: a call to the conversation's object, the list one call to
  the index, live events a stream from the object, better-auth's routes forwarded as JSON with every
  `set-cookie`, and the session from the signed cookie cache when it can (no call), else a call.

```ts
import channelWeb, { worker as channelWebWorker } from "./src/pikit/channel-web/index.ts";
export const worker = defineApp({ components: [/* … */ channelWebWorker] });
export default defineApp({ components: [/* … */ channelWeb] });
```

## The page

`/chat/` serves `chat-files.ts`, the module the page's build writes (`src/chat/`). The kit's copy is
empty: `/chat/` then says no page is built, and the API works alone. Every file is served under a
Content-Security-Policy: same origin only, images also `data:`, `blob:` and `https:` (avatars).

## How it is tested

- `channel-web.test.ts`: every route on a server, over the runtime's doubles (`runtime.test-support.ts`)
  and a double of the accounts: config, sessions and the page's header, conversations, the list and
  its cursor, isolation (another user's chat id `404` on every route), answers and states, a lost run
  end, an operator's follow-up never shown, live events, stop, duplicates, request ids, images and
  body limits, refusals, the operator's routes, the live `signUp` setting, what setup declares, the
  lifecycle suite.
- `conformance.test.ts`: the channel conformance suite (`answers: "pushed"`), the platform being the
  table (its writes failed or left hanging by the fixture).
- `remote.test.ts`: the Worker's half over a fake platform of one App per key (`scope: "one"`), each
  conversation's object and the accounts actor: start, list, rename, messages, answers, delete,
  isolation, live events, image limits, an unreachable object, the index's versions, removal.
- `accounts-wiring.test.ts`: the real accounts (better-auth) through the routes, on a server and
  forwarded to the accounts actor on Cloudflare (the cookie cache first); chat and admin sessions never
  open each other's routes. `accounts/*.test.ts` test the accounts themselves.

Not covered yet: the workerd lane (real Durable Objects), the page.
