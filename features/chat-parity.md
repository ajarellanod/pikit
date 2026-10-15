# Chat parity: one conversation view for the dashboard and the chat page

**Public appeal:** ⭐ The users' chat page (`channel-web`, `/chat/`) looks and behaves as the
operator's dashboard does: the thinking, the tools, the context, tabs, an assistant to pick, search.

**Specified:** yes (this note is the build guide). Builds on [channel-web](completed/channel-web.md).

## Why
The chat page was written apart from the dashboard: it shares only low-level pieces (bui, markdown,
the message bubble, the composer), and renders its own conversation from its own JSON. So the two
diverged: the chat flickers when an answer ends (it swaps a live text for a stored one, read from a
second source), shows no thinking, tools or context, has no tabs, no assistant picker, no search in
Conversations, and the dashboard lacks the conversation header's menu the chat has.

## The decisions (the user's)
1. **One conversation view, shared as copies.** The dashboard's conversation view is split into its
   presentation (shared: the thread, the live state, the turns, the activity line, the Context panel,
   the tabs, the composer's wiring) and its data (each app's own). Shared pieces stay what they are
   today: files of `registry/dashboard/files/src` listed in `scripts/ui-shared.ts`, copied into the
   chat by `scripts/chat-shared.ts` (identical, checked), published as shadcn items; no shared piece
   imports the admin client (the boundary test). channel-web stays self-contained: its page carries its
   copies, and it needs neither the dashboard nor admin-api.
2. **The same JSON.** The chat's server answers in the dashboard's shapes, so the shared view needs no
   second model: a transcript of entries `{ id, kind, messages }` (pi-ai messages, newest first,
   paged) and live events (pi-durable's, a `snapshot` first) as admin-api's `ApiTranscriptEntry` and
   `ApiEvent`. One source each: the thread is the transcript plus the live state, so nothing is
   swapped when an answer ends.
3. **What a user sees is the operator's policy**, a channel-web config value and a live setting
   (`visibility`): `thinking` (default off), `tools`: `"none" | "names" | "full"` (default `"names"`:
   a tool's name, never its arguments or result), `context` (default on: the images sent and what web
   searches and fetches found, which needs `tools: "full"` for the sources; images alone otherwise).
   The server projects every transcript entry and live event by it, at read time (a change applies to
   history too). Never: system prompts, operator messages (`dashboard:` requests) or their runs,
   another user's anything, usage or cost.
4. **An assistant to pick, when the operator allows it.** A setting `agents`: the agents users may
   pick (default none: no picker, the router decides, as today). A new chat names one of them; the
   conversation is made with it (`conversations.registry.resolve(key, agent, "web")` before
   `admitInbound`: a key keeps the agent it was made with), and routing still allows or denies the
   message. No contract change. A conversation keeps its agent; picking another starts a new chat.
5. **The rest:** tabs of open conversations in the chat; a search in the chat's Conversations (`q`,
   the title, server side, the user's own only); the conversation header's menu (Rename, Archive or
   Restore, Delete) in the dashboard too.

## The server (channel-web)
- **History.** A run that answered a user's message (the same rule as delivery: not only `dashboard:`
  requests) is stored whole when it settles: its messages (`AgentResult.messages`: the assistant's,
  with thinking and tool calls, and the tool results), next to the user's message it answered, in the
  channel's store (the conversation's object on Cloudflare). The transcript route builds entries from
  the store: the user's messages (images as URLs, served by the existing image route) and each run's
  messages, projected by the visibility policy. An aborted or failed run keeps what it wrote.
- **Live.** The projection of `agent.observe.watch` keeps the dashboard's event shapes, filtered by the
  policy (thinking deltas and blocks dropped when off; tool calls' arguments and results, tool
  execution updates and outputs dropped unless `"full"`; with `"none"` no tool event at all), with
  today's guard: only runs known to answer a user's message stream (fail closed).
- **Routes** (`/chat/api`): `GET /conversations/:id/transcript?limit&cursor` (entries), `GET
  /conversations/:id/events` (the dashboard's event shapes), `GET /conversations?q=` (search),
  `ChatConfig` gains `visibility` and `agents` (`{ name, description? }[]`), `POST /conversations`
  takes `agent` (one of `agents`, else `400`). The old `messages` route and `ChatEvent` go (pikit is
  unreleased: no compatibility).
- **Tests:** each policy value on transcript and live (what shows, what never does), operator runs
  never shown, isolation for the new routes, the agent picked (allowed, refused, routing still
  denies), search, both targets (bun lanes and workerd).

## The page
- The shared conversation view over a chat source (`/chat/api`), with the chat's actions (the menu,
  Archived) and without the operator's (commands, notes, reset).
- Tabs, the assistant picker (new chat; a conversation's composer shows its assistant), the Context
  panel when the policy allows, the search in Conversations.

## The dashboard
- Uses the same shared view over its admin source: unchanged behaviour.
- The conversation header gets the menu (Rename, Archive or Restore, Delete), the sidebar's.
