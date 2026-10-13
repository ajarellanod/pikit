# Channel: web

**Public appeal:** ⭐ People who are not operators talk to the assistant from a web page: their own
conversations, the same look as the dashboard, no admin in sight. OpenClaw has WebChat (its Control
UI's chat tab and native apps over the Gateway's WebSocket).

**Specified:** idea (the bases are built: the dashboard's UI pieces as `@pikit` shadcn items,
`channel-http`'s request/answer API, `admin-auth-token`'s browser sessions)

**Needed by:** nothing required.

## What it gives
A chat page for the assistant's users, at `/chat/`, with its own sign-in. Each user sees and
continues only their own conversations. The operator dashboard (`/admin/`, SPEC §5) stays as it is:
operators only, nothing of it in the users' page.

## How it fits pikit
Three layers: the UI pieces both pages share, a channel for the backend, and a second UI project.

### 1. The UI pieces, shared by both pages
The dashboard's pieces are shadcn registry items (`registry/ui/r/*.json`), but today they pull in
the admin client:
- `@pikit/lib` is one item: generic helpers (`format`, `utils`, `theme`, `messages`, `activity`)
  and the admin API's client (`api.ts`, `admin-api.ts`, `chats.tsx`, `settings.ts`, `views.ts`,
  `router.tsx`). `@pikit/bui` and `@pikit/message` depend on it.
- `components/pikit/message.tsx` imports `OPERATOR_NOTE` from `@/lib/admin-api`, its only admin
  import.
- The `conversations` view is the admin API's (`follow`, `useChats`, `composer.ts` reads
  `admin-api`) and carries operator actions (steer, abort, reset, commands, the agent picker, cost):
  it is not shared.

The split: `@pikit/lib-ui` (the generic helpers) and `@pikit/admin-client` (the admin API's
client). `bui`, `markdown`, `message`, `PromptBar` and `error-note` depend on `lib-ui` only, take
everything by props and never fetch; `message.tsx` gets the operator note's prefix from `lib-ui` or
a prop. A boundary test keeps these pieces from importing `@/lib/api` or `admin-api`. This split is
a refactor of the registry, useful on its own; it lands first, with the channel as its user.

### 2. The backend: `channel-web`
- A channel component. Its routes (`/chat/api/*`) go through `http.route`, and it serves the chat's
  built files under `GET /chat/*` (its own generated files module, as admin-api's
  `DASHBOARD_FILES`).
- Its own authentication, never `admin.auth`: a user is not an operator. Its session cookie has its
  own name and path (`/chat/api/`), its own client header, and never opens `/admin/api`.
- The sender of each message is `{ channel: "web", id: <user> }`, so a role by actor
  ([policy tools](policy-tools.md)) and the steward's "only operators may ask it" (SPEC §6) see a
  user, not an operator.
- The conversation key is the channel's own (`web:<user>:<uuid>`, `ConversationRef.key` is opaque
  and only its channel reads it): a user lists and reads only keys with their id, checked in one
  place, the channel's routes, and covered by a test (one user never reads another's).
- Answers take the channels' path (`outbound.queue`, `startAnswerDelivery`): the channel keeps each
  answer for its request and the page reads it, as `channel-http` does (`GET .../messages/:id`). The
  first version has no live tool calls or streaming.
- Its own request-id prefix (`web:`), never `dashboard:`: `admitInbound` already refuses
  `DASHBOARD_REQUEST_PREFIX` from a channel (`packages/contracts/src/delivery.ts`).
- Targets: server and Cloudflare. On Cloudflare it needs a Worker half, which `channel-http` does not
  have yet; until it has one, the component says `server` only.
- Absent: no `/chat/`, nothing else changes.

### 3. The page: `src/chat/`
- A shadcn/ui project of its own, as `src/dashboard/` is (Vite, React, Tailwind v4), that installs
  `@pikit/lib-ui`, `@pikit/bui`, `@pikit/markdown` and `@pikit/message` with `shadcn add`. A page
  made of those pieces: the user's conversations, one conversation, a composer.
- Apart from the dashboard on purpose: its own bundle (no admin code or route in it), its own
  build, and `pikit ui off` does not touch it (absence, not flags: P4). It comes and goes with
  `channel-web`.
- Its copies of the pieces are the user's, merged by `pikit upgrade` like any other (P6).

## Pi first
Nothing in Pi: serving a chat page and authenticating its users is ingress, pikit's (SPEC P1). Pi
removed `pi-server` and `pi-client` in 1.2.0 ([kit follow-ups](kit-follow-ups.md)); when Pi serves
sessions to a browser with authentication again, re-check whether the live part should use it.

## Open questions
- How users sign in: a password per user, a link by email, OIDC, or [pairing](pairing.md) (a
  stranger asks, the owner approves). Where users are kept (`storage.sql`), and who adds them.
- Live updates. `agent.observe` is "read-only, for operators" (`docs/contracts.md`); showing a user
  the tool calls and the text as it is written needs a view limited to their own conversations, a
  contract decision (contract rules 2 and 4), not admin-api's stream opened to users. Compare
  [streaming replies](streaming-replies.md).
- One person across channels: is a web user the same actor as their Telegram chat? Not in the first
  version: keys stay per channel.
- Tenants: users of different clients on one App are [multi-tenant isolation](multi-tenant-isolation.md);
  routing is not isolation.
- Attachments and images from the page, with the limits the dashboard's composer already uses.
- Whether the chat may also be hosted apart from the App (static files against `/chat/api`), as the
  dashboard may (SPEC §5): CORS and the cookie then need care.
