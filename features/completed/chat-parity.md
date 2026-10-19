# Chat parity: one conversation view for the dashboard and the chat page

**Public appeal:** ⭐ The users' chat page (`channel-web`, `/chat/`) looks and behaves as the
operator's dashboard does: the thinking, the tools, the context, tabs, an assistant to pick, search.

**Status:** built, on both targets. This note was its build guide; "As built" records where it differs. Builds on [channel-web](channel-web.md).

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

### As built (the server), and why
- **Ids, live and read.** A user's message is its request id; a run's message is
  `<the run's first request>#<hash of the message itself>` (role, time, tool call id, blocks' text and
  ids; `entries.ts`). The live view hashes the message `message_end` announces, the store the same
  message in `AgentResult.messages`: one id, one form (`{ id, kind, model }` live, `{ id, kind, messages }`
  read), so the view's merge by id never shows one twice. pi-durable's entry ids could not be used:
  `AgentResult` carries no entry ids, and no contract changes.
- **A message sent while a run goes is held** out of the transcript and the live view until that run
  ends: the run's messages are stored only then, and the view puts live-only entries after the
  transcript's, so a message read before them would jump below them when the run ends. The runtime
  does the same (a queued input enters the transcript when its run starts); the page shows it as sent
  meanwhile, as the dashboard does.
- **Order.** Entries are in turns: a user's message opens one; a run's messages go in the turn of the
  newest user message it answered, whenever it ends.
- **Delivery stays**, as the durable path: it writes a completed run's answer (one assistant message)
  only for a run whose end this App never heard (it waits a second for it), and the run's messages
  replace it when heard late. The channel conformance suite still runs.
- **The projection is in the routes** (`visibility.ts`), one place for both targets: on Cloudflare the
  Worker cuts what the objects give, by the accounts actor's `ChatConfig` (kept 10 s).
- **Small additions:** a user's entry carries its `state` (`pending`, `answered`, `failed`, `aborted`);
  `entry_appended` without an entry means "read the transcript again"; `ChatConversation.agent` is said
  only when it is one users may pick; a failed answer's provider error is replaced by a plain sentence;
  `run_start` and `run_end` of any run (an operator's too) say only that the assistant is busy.

## The page
- The shared conversation view over a chat source (`/chat/api`), with the chat's actions (the menu,
  Archived) and without the operator's (commands, notes, reset).
- Tabs, the assistant picker (new chat; a conversation's composer shows its assistant), the Context
  panel when the policy allows, the search in Conversations.

### As built (the page), and why

- **One source, pure.** `chatSource(id, client, target)` (`src/lib/source.ts`) is the view's
  `ConversationSource` over `/chat/api`, its requests through the client given (the page's `fetch`
  client), so its paths and bodies are tested without a browser. A message is checked before it goes
  (the image limits of the target); the server makes its request id. The events are read by the same
  SSE reader as before (`readSse`). The old renderer, `live.ts`, `live-state.ts` and the outbox are
  gone: the shared `useSentMessages` (in `ConversationsProvider`, so New chat's first message shows in
  the conversation it opens) replaces the outbox, without its "Send again" (the view refuses with the
  reason, the draft comes back).
- **The header is the tab bar**, as in the dashboard: the title is the tab's; "Archived", the Context
  button (only when `visibility.context`, and only when there is something to show) and the menu go at
  its right end (`TabActions`), the Context panel beside the window (`SidePanel`).
- **An archived conversation is still talked to**: the server lists it again on a message, so the
  composer stays (no `closed`) and the page reads the conversation and the lists again when the live
  stream says it changed: the pill goes, the sidebar has it back.
- **Tabs** are kept in `localStorage["pikit-chat-tabs:<user id>"]`: per browser, and per user (two
  people on one browser never see each other's titles), never the dashboard's `pikit-tabs`. A deleted
  conversation's tab closes; an archived one's stays (it is still read and written).
- **The picker** shows only with `ChatConfig.agents`; it starts on the one `#/?agent=` names (a
  conversation's composer sends there when another assistant is picked: a chat keeps its assistant),
  else on the one Routing chooses for the user's new chat (`ChatMe.suggestedAgent`, a dry run of
  `route.resolve`), else on the first (the conversation then always records its assistant, and its
  composer shows it). Routing's rules for `web` pick the assistant offered first; a user may pick another.
- **Search** in Conversations: `?q=` 250 ms after the last key, with an "Archived" switch that searches
  the archived ones alike; without either the list is the sidebar's. The sidebar's own search still
  filters the chats it has loaded (its field is the shared `SidebarNav`'s, unchanged).
- **Titles, one per conversation in both apps** (channel-web's `titles.ts`). A web conversation is
  named by its first message at once, then, after its first run that answers the user, by a model
  (`model.complete`; `titleModel`, else its agent's model), in the background, once (one more try
  after a later run if it failed). The user's rename always wins: no model titles a renamed
  conversation, and a model's title is written only while the title is still the one it replaces
  (whose the title is: a `storage.kv` record per conversation, no table). The page hears a new title
  as a change (the live view's `entry_appended` with no entry: it reads the conversation and the list
  again). The dashboard titles conversations on its own (admin-api's titler), so channel-web gives
  each title it sets to the App's `/name` (`agent.command`, a public contract; on Cloudflare run in
  the conversation's object): the dashboard lists the chat's title, and, the first one being given
  while the first message is dispatched (before any run can settle), admin-api's titler finds the
  conversation named and asks no model. Both clean a title alike (first line, no label or quotes, no
  end punctuation, a capital first, 60 characters at most), so the two read the same. An operator's
  rename in the dashboard stays the dashboard's until the chat sets a title again. Elsewhere (any
  channel), the dashboard lists a conversation by its first message from the moment it is
  dispatched, so one whose runs all fail is never listed by its id.

## The dashboard
- Uses the same shared view over its admin source: unchanged behaviour.
- The conversation header gets the menu (Rename, Archive or Restore, Delete), the sidebar's.
