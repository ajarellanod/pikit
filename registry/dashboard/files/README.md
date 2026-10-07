# The dashboard

The operator's view of this pikit service (SPEC §5): its conversations, the most recently active
first, one of them live (the transcript, the answer being written, the tools running), abort and
reset, the cost, and what the App is made of. It is yours: a shadcn/ui project (Vite, React, Tailwind
v4) whose source you change like any other file of the project.

It looks like [Beautiful UI](https://www.beautifului.dev/harness)'s harness: a sidebar (the App's menu
with the theme, the interaction sounds and sign out; **New chat**; **Home**; the views; every
conversation, searchable), the conversations you opened as tabs, a chat (the transcript, the answer
streaming in, the model's thinking, the tool calls as chips, a composer that stops a run), and a
**Tasks** panel with the conversation's tool calls, their status and output. Light, dark, or the
system's (the default); interaction sounds on until you turn them off. Both are kept in this browser.

It talks only to the admin API that `admin-api` serves (`/admin/api/*`), and admin-api serves its
built files under `/admin/`.

## A channel of its own

- **New chat** (the home): pick one of the App's agents (in the composer) and write the first message.
  It is a conversation of the dashboard's own (`dashboard:<uuid>`, labeled `dashboard`): its answers
  appear only here, and no other channel can continue it.
- **Another channel's conversation** (a Telegram chat, an HTTP client's): what you write is a
  follow-up (with a run going, it waits for it) whose answer stays here. Nothing you say, nor its
  answer, is sent to that chat; the agent reads that the message is the operator's and that the user
  does not see it. A run that also answers the user's own message is delivered to the user, as always.
- **Abort** and **reset** work on every conversation.

## Signing in

The page asks for the operator's token (`PIKIT_ADMIN_TOKEN`; `pikit configure --generate
PIKIT_ADMIN_TOKEN` writes one) once, and posts it to `POST /admin/api/session`: the browser gets a
session cookie (HttpOnly, SameSite=Strict, sent to `/admin/api/` only, 12 h), never keeps the token,
and no script can read the session. Every call also sends `x-pikit-admin: 1`, which a page of
another site cannot. **Sign out** clears the cookie. The files are served with a Content-Security-Policy
(`default-src 'self'`, no inline script): keep scripts in modules, and fonts, images and styles in
the build (`src/`, `public/`), never from another origin.

## Requests

The dashboard asks the API only while its tab is visible and you were there in the last 5 minutes (a
key, the pointer, a scroll): polling and live streams pause otherwise, and resume at your next touch
(`src/lib/activity.ts`). On Cloudflare that is the budget: every Worker request and Durable Object
request counts in the day's (Workers Free: 100,000 Worker requests and 100,000 Durable Object requests
a day), shared with the bot. There the list is read every 30 s (1 Worker request and up to 21 object
requests), and an open conversation's live stream asks its object for a snapshot every 2 s (about 30
object requests a minute, one Worker request each 80 s). An hour of watching one conversation costs
about 2,000 requests; a tab left open costs none after 5 minutes.

## Run it

```sh
bun install
bun run dev        # hot reload on http://localhost:5173/admin/, the API from PIKIT_URL (default http://localhost:3000)
bun run build      # dist/, then scripts/embed.ts writes it into ../pikit/admin-api/dashboard-files.ts
bun run typecheck
```

The build's last step (`scripts/embed.ts`) writes `dist/` as a module, `src/pikit/admin-api/dashboard-files.ts`
(each file in base64), which admin-api bundles and serves at `/admin/`: the same on a server and on a
Cloudflare Worker, with no disk. Without admin-api next to it the build makes `dist/` only. Every
deploy builds it again: on Cloudflare wrangler's `build.command` (`pikit up`, `pikit dev`, a hand
`wrangler deploy`, Workers Builds; a failed build stops the deploy), Docker's image in a stage of its
own. On a server's `pikit dev`, rebuild after a change: it serves what was built last. The module is
committed, marked generated in `.gitattributes` (a diff shows only that it changed). The ids in the API
are opaque (on Cloudflare `<key>~<id>`, and one may hold `.`, `@` or `/`): always
`encodeURIComponent` one in a path (`pagePath` in `router.tsx`); any page reloads.

## What is where

| Path | What |
|---|---|
| `src/views/<view>/index.tsx` | one view each: its pages and when it shows (below) |
| `src/components/bui/` | Beautiful UI's primitives (the sidebar, the composer, thinking, tool chips, task rows, pills), fed by real data |
| `src/components/ui/` | shadcn/ui primitives, copied and yours (`shadcn add` puts more here), in the same tokens |
| `src/components/pikit/` | pieces the views share: a transcript (`turnsOf`, `Reply`, `UserBubble`, `MessageView`), an error, the sign-in |
| `src/index.css` | the one stylesheet: Beautiful UI's tokens (light and dark), shadcn's variables mapped onto them |
| `src/lib/api.ts` | calls to the admin API (the session), `signIn` / `signOut`, `useApi`, live events (`follow`) |
| `src/lib/activity.ts` | whether you are there: `useActive`, `usePolling`, `every` (slower on Cloudflare) |
| `src/lib/admin-api.ts` | the API's JSON, typed: an identical copy of `src/pikit/admin-api/api.ts` |
| `src/lib/views.ts` | how views are found and when they show |
| `src/lib/router.tsx` | the pages under `/admin` |
| `src/lib/chats.tsx` | the conversations the sidebar lists, the tabs, the titles (`useChats`, `agentsOf`) |
| `src/lib/shell.tsx` | what the shell gives a page: the App, the views, `TabActions`, `SidePanel` |
| `src/lib/theme.ts`, `public/theme.js` | light, dark or the system's, before the first paint |
| `src/lib/sounds.ts` | the interaction sounds, and their switch |
| `src/app.tsx` | sign-in, the sidebar, the tabs and the page the path names |

## Add a view

A view is a folder of `src/views/`, found when the dashboard is built. **Prefer a new view to
editing a base one** (`conversations`, `composition`, `delivery`): `pikit upgrade` merges the kit's
changes into the base views, and a file you did not touch never conflicts. To show something more
about conversations, add a view of your own (`src/views/my-conversations/`) that reuses the base
pieces they export (`useLive` from `views/conversations/live.ts`, `turnsOf`, `Reply`, `MessageView`
and `ErrorNote` from `components/pikit/`, `useChats` and `agentsOf` from `lib/chats.tsx`) and the
client in `src/lib/`;
change a base view only for what a view of your own cannot do, and keep that change small.

```tsx
// src/views/memory/index.tsx
import { Brain } from "iconoir-react";
import { defineView } from "@/lib/views";
import { MemoryPage } from "./memory";

export default defineView({
  id: "memory",                     // the folder's name; its pages live under /memory
  title: "Memory",
  icon: Brain,
  requires: ["memory"],             // shown only while a component provides these capabilities
  pages: [{ path: "/memory", component: MemoryPage }],
});
```

A view appears in the sidebar with its icon (iconoir, MIT; never a paid set) and its page in the main
pane, padded and scrolling (`fill: true` on a page: it fills the pane and scrolls itself, as the chat
does). Build it from `src/components/bui/` (Beautiful UI's look) or `src/components/ui/` (shadcn's,
in the same colours).

Its data comes from admin routes its component registers through `http.route` (`GET
/admin/api/memory/…`, asking `admin.auth`), read with `useApi` / `api` from `@/lib/api` (they send
the session and pause while you are away; poll with `useApi(path, every(ms))`). A view never reads
anything else: no internals, no other origin.

More primitives: `bunx shadcn@latest add dialog` (from this folder). pikit's own pieces and views are
shadcn items too: `bunx shadcn@latest add @pikit/<item>` (`components.json` names the registry; its
list is `registry/ui/r/registry.json` in the pikit repository). A component with a view installs it
here itself (`pikit add`). The skill `pikit-view` (`.agents/skills/`) teaches an AI agent all of this.

## Notices

The primitives in `src/components/ui/` come from shadcn/ui (MIT), those in `src/components/bui/`, the
tokens in `src/index.css` and the interaction sounds from Beautiful UI (MIT); the icons are iconoir
(MIT) and the fonts Inter and JetBrains Mono (OFL): see `NOTICE`.
