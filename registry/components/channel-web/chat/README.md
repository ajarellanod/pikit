# The chat page

The page your assistant's users talk to it from, at `/chat/` (channel-web): sign in (email and
password, a link by email, a button per provider the App offers), their own conversations (rename,
delete), one live (the answer as it is written, the tool running, stop), a new one, images, and their
account (name, password, linked providers, browsers signed in). It is yours: a Vite + React + Tailwind
v4 project whose source you change like any other file of the project. It looks like the dashboard
(`src/dashboard/`), light and dark, and carries none of its admin code.

## Run it

```sh
bun install
bun run dev        # hot reload on http://localhost:5173/chat/, the API from PIKIT_URL (default http://localhost:3000)
bun run build      # dist/, then scripts/embed.ts writes it into ../pikit/channel-web/chat-files.ts
bun run typecheck
```

`bun run dev` needs the app running (`pikit dev`, or `PIKIT_URL=https://your.service bun run dev`):
Vite sends `/chat/api` there and says the app's origin, which better-auth checks on every change. A
sign-in by a provider or a link comes back to the app's own `/chat/` (its `PIKIT_PUBLIC_URL`), not to
Vite's: sign in with a password while developing, or sign in on the app's page and reload Vite's (on
`localhost` both have the session cookie: cookies go by host, not by port).

The build's last step (`scripts/embed.ts`) writes `dist/` as a module, `src/pikit/channel-web/chat-files.ts`
(each file in base64), which channel-web bundles and serves at `/chat/`, the same on a server and on a
Cloudflare Worker. Without channel-web next to it the build makes `dist/` only. Every deploy builds it
again. A bundle that names the admin API (`/admin/api`) is refused.

## What is where

| Path | What |
|---|---|
| `src/app.tsx` | what the App offers and who is signed in, then the screen of the route |
| `src/screens/` | sign-in, make an account, forgot password, an invitation's or reset's landing, "confirm your email", the layout (sidebar), a new chat, a conversation, the conversations, the account |
| `src/lib/chat-api.ts` | the chat API's JSON: a copy of channel-web's `api.ts` |
| `src/lib/client.ts`, `auth.ts` | the API (`fetch`, the session cookie, `x-pikit-chat: 1` on changes) and better-auth's routes |
| `src/lib/live.ts`, `live-state.ts`, `sse.ts` | a conversation live: its server-sent events read with `fetch`, folded into a state; a finished answer's live text stays until the messages read have the stored answer its `message` event named (by id, never by text) |
| `src/lib/outbox.ts` | messages sent from here not shown yet: sending, queued, failed (send again) |
| `src/lib/location.ts`, `routes.ts` | the hash routes (`#/c/<id>`, `#/set-password?token=…&email=…`); each signed-out screen keyed by its route, so another route starts it anew |
| `src/lib/visible.ts` | signed out, the config read again when the tab comes back (a sign-up mode changed meanwhile) |
| `src/components/bui/`, `src/components/pikit/`, `src/lib/{activity,format,messages,names,sounds,theme,utils}.ts`, `src/index.css`, `public/` | the dashboard's shared pieces and look, copied |

The copies are the dashboard's own files: in the kit, `bun scripts/chat-shared.ts generate` makes them
and `scripts/chat.test.ts` checks them; in your project `pikit upgrade` merges them as any other file.

## Routes

| Route | Screen |
|---|---|
| `#/` | a new chat |
| `#/c/<chat id>` | a conversation |
| `#/chats` | the conversations |
| `#/account` | the account |
| `#/sign-in`, `#/sign-up`, `#/forgot` | signing in |
| `#/set-password?token=…&email=…[&invite=1]` | where an invitation, a confirmation and a password reset land (the email shown read-only) |
| `#/verify?email=…` | "confirm your email" |

It asks the API only while its tab is visible and the person was there in the last 5 minutes
(`src/lib/activity.ts`): the conversations are read every 20 s (60 s on Cloudflare), a conversation
follows its live events, and both pause otherwise.
