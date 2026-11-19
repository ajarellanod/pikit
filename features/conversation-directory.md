# One conversation directory

**Public appeal:** - (one list of conversations whose title, order and "delete" mean the same thing in
the dashboard, the web chat and any other view)

**Specified:** no. Design of 2026-11-19, from the operator's direction after neural-agents showed the
same conversations listed by three indexes. It changes one sentence of SPEC §5 (below, "Where it bends").

**Needed by:** nothing required. It replaces admin-api's conversation index (SPEC §5's list,
[cloudflare-conversation-index](cloudflare-conversation-index.md)) and channel-web's users' index, and
gives a project's own index of another channel's conversations (neural-agents' `rooms:index`) a smaller
job: saying who belongs to a space.

## The problem
One conversation is listed by up to three indexes, each with its own title, last activity and meaning of
"delete":

| Index | Where | Title | "Delete" |
|---|---|---|---|
| admin-api's (`admin_api_conversations`, `_titles`, `_hidden`) | `admin-api:index` on Cloudflare, the App's SQL on a server | first message, then a model, then the operator's `/name` | hides from the operators' list only; new activity brings it back |
| channel-web's (`channel_web_conversations`) | each conversation's object (truth) and the accounts actor (`channel-web:accounts`, the index) | first message, a model, the user's rename; pushed into admin-api's through `/name` | gone for its user (every route `404`); kept in the runtime |
| neural-agents' `rooms:index` (`neural_rooms_conversations`, `_reads`, `_web`) | one actor | a thread's first message, never renamed | none |

So the dashboard and the chat disagree on a title once an operator renames; deleting in one view does
nothing in the others; a project member can hide another's shared chat only through a fourth table
(neural-agents' `channel_web_reads`); and each message wakes several index actors: in neural-agents'
Google Chat path admin-api's awaited `seen` (459 ms when `admin-api:index` is cold) and `rooms.seen` (464
ms) are two of the twelve awaits before an answer (agents' `channel-google-chat/LATENCY.md`).

## What it gives
- **One directory**, the source of truth for which conversations exist and how they are listed: per
  conversation its key, agent, channel, space, owner, title (one, whoever looks), when it was made and
  last active, whether a run goes, and its state for everyone (`listed`, `archived`, `deleted`).
- **Views** over it, each filtering by who looks: the operator sees everything; a web user sees what they
  own, the conversations of the spaces they belong to (a project's chats, a Google Chat space they are a
  verified member of), as membership providers say.
- **Per-viewer state** keyed by (viewer, conversation): hidden for me, read up to, my own name for it.
- **Two actions, the same everywhere**: "Hide for me" (any viewer, only their lists) and "Archive /
  delete for everyone" (operators, the conversation's owner, or the owner of its space), honoured by every
  view.
- **One update per message**, written locally in the conversation's own App and sent to the directory
  off the message's path.

## Where it stands
- **admin-api's index** (`conversation-index.ts`, `titles.ts`; [cloudflare-conversation-index](cloudflare-conversation-index.md)):
  rows of (key, conversation, agent, newest activity, title lowercased) written from the runtime's events
  (`agent.dispatched` awaited in the caller, `agent.started`, `agent.settled`, `agent.failed`,
  `conversation.reset`) and a backfill from `agent.observe` at each App's start; titles in each
  conversation's object (first message at dispatch, a model once after the first run, `TITLE_TRIES`, the
  operator's `/name` wins); `admin_api_hidden` for archive/delete. The Worker lists a page from the index
  and asks each row's object for its usage and party.
- **channel-web's store** (`store.ts`, `titles.ts`): `channel_web_conversations` holds the user, chat id,
  agent, project, title, created, newest activity, `hidden`, `archived`, `busy` and a version; on
  Cloudflare the object's row is the truth and the accounts actor keeps the users' index from
  `channel-web.seen` (newer version wins), answering the list, a project's chats (`listProject`,
  `projectConversation`, `projectChats`) and the search. Titles: first message, a model (its own titler,
  `title:<key>` in `storage.kv`), the user's rename wins; each one given to admin-api's `/name` so the
  dashboard agrees, until an operator renames there.
- **conversations-kv / conversations-file** (`conversations.registry`): the pointer of each key to its
  runtime conversation, with its channel and space for good. On Cloudflare each object holds its own
  (C5): a registry answers for its key, never lists. It is not a directory and stays as it is.
- **The titlers**: two copies of the same policy (admin-api's and channel-web's), coordinated through
  `/name`.
- **Downstream** (neural-agents, 2026-11-19): shared chats (`channel_web_activity`, `channel_web_reads`
  with `archived_at` hiding another member's chat, unread and mentions), and Google Chat in Neural Chat
  (`rooms:index` lists a person's Google Chat conversations by verified membership, merged with
  channel-web's list under one keyset cursor; read marks and unread there too).

## The design

### Contracts (`@pikit/contracts`: several kit components use them, as `projects`)

**1. `conversations.directory`** (`packages/contracts/src/conversation-directory.ts`, single, optional
for its users, `experimental`):

```ts
import type { AppContext } from "@pikit/core";
import type { Author, Page, Principal } from "@pikit/contracts";

/** A conversation: a key and its runtime conversation (on Cloudflare an object's id is unique only with its key). */
export type EntryRef = { key: string; conversationId: string };

/** Who looks. Set by the view from what it authenticated, never from a page's words. */
export type Viewer =
  | { kind: "operator"; id: string }                 // admin.auth's operator: everything
  | { kind: "people"; principals: Principal[] }      // a person: principals[0] is the one the view authenticated, whose per-viewer state it is
  | { kind: "component"; name: string };             // trusted code: everything, no per-viewer state

export type TitleSource = "first" | "model" | "rename";    // precedence, lowest first
export type EntryState = "listed" | "archived" | "deleted";

export type DirectoryEntry = EntryRef & {
  channel: string; agent: string; space?: string; owner?: Principal;
  /** The key's newest conversation (a reset leaves the previous one `false`). */
  current: boolean;
  createdAt: number;
  /** Newest activity this viewer may see: for people, never an operator's follow-up nor a run only those started. */
  lastActivity: number;
  busy: boolean;
  title?: string; titleSource?: TitleSource;
  state: EntryState; stateAt?: number; stateBy?: Author;
  /** This viewer's own state (operators and people). */
  mine?: { hidden: boolean; readAt?: number; name?: string; unread: number };  // unread capped at UNREAD_MAX
  /** What this viewer may do: every viewer who sees it hides, names and marks it for themselves. */
  manage: boolean;                                   // rename, archive, delete for everyone
  role: "operator" | "component" | "owner" | "space-owner" | "member";
};

export type DirectoryQuery = {
  limit?: number; cursor?: string;                   // keyset: `<lastActivity>:<key>:<conversationId>`, URI-encoded parts
  state?: "listed" | "archived" | "hidden" | "deleted"; // hidden: this viewer's; deleted: operators and components only
  q?: string;                                        // title, this viewer's own name; operators also the key
  space?: string; channels?: string[]; owned?: boolean; // owned: only those this viewer owns
};

export interface ConversationDirectory {
  list(viewer: Viewer, query: DirectoryQuery, ctx: AppContext): Promise<Page<DirectoryEntry>>;
  /** How many listed conversations each space has, for trusted code (a project card, "not empty"). */
  count(viewer: Viewer, spaces: readonly string[], ctx: AppContext): Promise<Record<string, number>>;
  /** The entry when this viewer may see it now (membership checked fresh); a key alone: its current one. */
  access(viewer: Viewer, ref: { key: string; conversationId?: string }, ctx: AppContext): Promise<DirectoryEntry | undefined>;
  rename(viewer: Viewer, ref: EntryRef, title: string, ctx: AppContext): Promise<DirectoryEntry>;   // manage; source "rename"
  setState(viewer: Viewer, ref: EntryRef, state: EntryState, ctx: AppContext): Promise<DirectoryEntry>; // manage; for everyone
  mine(viewer: Viewer, ref: EntryRef, change: { hidden?: boolean; readUpTo?: number; name?: string | null }, ctx: AppContext): Promise<DirectoryEntry>;
  /** Trusted code (a channel's first message as the person wrote it, the titler's answer): written unless a title of a higher source is there. */
  title(ref: EntryRef, title: { text: string; source: "first" | "model" }, ctx: AppContext): Promise<void>;
}
export class DirectoryError extends Error { code: "not_found" | "forbidden" | "invalid" | "invalid_cursor" | "limit" }
export const cleanTitle: (text: string) => string | undefined;   // one line, no label or quotes, at most TITLE_MAX (60): today's two copies made one
export const TITLE_MAX = 60, UNREAD_MAX = 99, AUDIENCE_MAX = 2_000;
```

What the directory does not hold: the transcript (the runtime's, or a channel's platform table:
`channel_web_entries`, Google Chat's log), usage (`agent.observe`), who a conversation is with
(`conversation.describe`), previews. How entries get there is the provider's (below), not a method: every
conversation with a key is in it once a message reached it, a reset pointed its key to it, or its App
started.

**2. The `conversation.audience` pipeline** (`packages/contracts/src/conversation-audience.ts`): who
belongs to which space, for the directory's people filter. A pipeline, not a keyed capability, for the
reason `conversation.describe` is one: a keyed capability would make the directory depend on every
membership provider, and neural-agents' rooms index uses channel-google-chat's members while
channel-google-chat writes titles to the directory: a start-order cycle. A pipeline orders nobody.

```ts
export type AudienceGrant = { space: string; role: "member" | "owner"; source: string };
export type Audience = {
  principals: readonly Principal[];
  /** Given: check this one space now (the provider's fresh bound, before opening or acting). Absent: every space, for a list (its list bound). */
  space?: string;
  grants: AudienceGrant[];
};
export interface AudienceProvider { grants(principals: readonly Principal[], space: string | undefined, ctx: AppContext): Promise<AudienceGrant[]> }
/** A provider's stage: it only appends grants of its own `source`, a throw appends none (logged): fail closed. */
export function audienceStage(source: string, provider: AudienceProvider): (value: Audience, ctx: AppContext) => Promise<Audience>;
/** Runs the pipeline; never throws, but past AUDIENCE_MAX grants it rejects (`limit`): never a silent cut. */
export function audienceOf(ctx: AppContext, principals: readonly Principal[], space?: string): Promise<AudienceGrant[]>;
```

Stages in the kit: **projects-sql** (its members' projects' spaces; `owner` for a project's owner; the
fresh check is `roleOf`). Downstream: neural-agents' rooms (a person's verified Google Chat spaces,
`googlechat:spaces/AAA`, which is the space channel-google-chat already gives every thread of a chat).

**3. An owner, recorded as the space is** (`conversations.ts`, `inbound.ts`): `ConversationPlace.owner?:
Principal`, given by the channel (`AdmitOptions.owner`, or `resolve`'s place), recorded with the key's
first resolve and kept for good through resets and restarts; `ConversationRef.owner` on the registry's
refs. Given today by channel-web (`{ channel: "web", id: <user> }`) and admin-api for its own
conversations (`{ channel: "dashboard", id: <operator> }`). The runtime does not record it (it reads
nothing of it): the directory reads it from `conversations.registry.get(key)` when it first sees a key,
and the contract says so (contract rule 6).

**4. A sender on `agent.dispatched`** (`agent.ts`, runtime-pi's emit in the adapter): `{ conversation,
admission, sender? }`, the request's sender as dispatched. The directory needs it for "activity by whom"
(unread counts others', never one's own) and to keep an operator's follow-up out of people's order.

### The provider: `conversations-directory`
One component, both targets, choosing by `actor.inbox`'s `scope` (K1), as admin-api does now; a Worker
half `conversations-directory-worker`. Requires `storage.sql`, `conversations.registry`, `agent.observe`
(backfill), `wakeups` on `durable`; optional `model.complete` (titles), `actor.mailbox`/`actor.inbox`.
Config: `titleModel?`, `retitleAtStart` (default 20, admin-api's `UNTITLED_PER_START`).

**Tables** (`conversations_directory_*`):

| Table | Where | Columns |
|---|---|---|
| `_entries` | the directory | key, conversation, channel, agent, space, owner (`principalKey`), delegated, current, created_at, last_activity, shown_activity, busy, seq, title, title_source, title_search, state, state_at, state_by; PK (key, conversation); indexes (shown_activity, key, conversation), (owner, shown_activity), (space, shown_activity), (last_activity) |
| `_viewers` | the directory | viewer (`principalKey` of `principals[0]`, or `operator:<id>`), key, conversation, hidden_at, read_at, name, name_search; PK (viewer, key, conversation) |
| `_activity` | the directory | key, conversation, at, by (`principalKey`, or `agent`); at most 100 per conversation (for `unread`) |
| `_outbox` | each conversation's App | key, conversation, patch (JSON, merged per conversation), seq |
| `_titles` | each conversation's App | key, conversation, input, tries (the model's tries, `TITLE_TRIES` 2) |

- **On a server** every table is the App's own `storage.sql`; the recorder writes the directory directly.
- **On Cloudflare** the directory is one actor, `conversations-directory:index`, an object of the
  conversations' class (as `admin-api:index`); `_outbox` and `_titles` are in each conversation's object.

**One update per message.** The recorder listens in the conversation's App: `agent.dispatched` (not a
duplicate: activity, `busy`, the sender; the first one of a key also its place, read from the registry),
`agent.started`, `agent.settled` / `agent.failed` (activity by the agent, `busy` off), `conversation.reset`
(the previous one `current: false`, the new one recorded). Each is one upsert of the conversation's
`_outbox` row (a local SQL write, merged: a burst of events is one row) and, on Cloudflare,
`wakeups.at("conversations-directory.flush", now)`. The flush, in its own alarm, sends every row as one
`conversations-directory.seen` (`actor.mailbox.send`) and deletes the rows it sent; a failure is retried by
`wakeups`' backoff. So a message costs no call to any index on its path (today: admin-api's awaited
`seen`, channel-web's `seen` on web chats, `rooms.seen` downstream). `seen` is field-wise idempotent: the
newest `seq` of a conversation wins for `busy` and `agent`, activity is a maximum, `current` only goes
false, titles follow their precedence. Activity by an operator's request (`dashboard:`) and a run only
those started (`answersOnlyTheDashboard`) moves `last_activity` only, never `shown_activity`.
Events can be missed (K3): at each App's start the recorder adds to `_outbox` the conversations
`agent.observe` holds that it never told (a server's in the background, an object's own), as admin-api's
backfill does now, but without a call when there is nothing new.

**Titles, one per conversation.** `first` (a channel's `title`: the first message as its person wrote it,
without the platform's prefixes or the operator's note) < `model` (the titler) < `rename` (a view's
`rename`, by whoever may manage). A write applies only over a lower or equal source; a `rename` always.
The titler runs in the conversation's App after its first settled run that a non-operator request started,
in a wakeup (`conversations-directory.title`, not a promise outliving the event: C4), from the `first`
text when there is one, else the first user text of that run; its try is recorded in `_titles` before the
model is called; its answer goes out through `_outbox`. A reset's new conversation has its own title.
A per-viewer `name` never changes the title, and only its viewer sees or searches it. Without
`model.complete` no model titles; a conversation with no title is shown by its view's fallback (its party).

**Lists and search.** `list` filters in the directory actor's SQL: for people `current`, not delegated
(`origin`), `shown_activity > 0`, the state asked, and `owner IN (principals) OR space IN (grants)`; for
operators and components every conversation. Ordered by the activity the viewer may see, then key and
conversation id; the cursor is that sort key. The grants (`audienceOf`, run by the provider's client in the
calling App: the Worker on Cloudflare) are split in chunks of at most 90 spaces (Cloudflare's SQL takes
100 bound parameters a query, which channel-web's `projectChats` already chunks for), one keyset query each, merged: one call, any number of spaces up to
`AUDIENCE_MAX`. `q` is `LIKE` over the lowercased title (and the viewer's own name; for operators the
key), its wildcards escaped, at most 200 characters. `unread` counts `_activity` rows after `read_at` by
someone not among the viewer's principals, capped at `UNREAD_MAX`. A page costs one call to the
directory, plus the audience providers' (projects' index, a rooms index): what channel-web's list and
neural-agents' merged list cost now.

### admin-api and channel-web as views
- **admin-api**: its list is `list({ kind: "operator", id }, …)`, then each row's object for usage and
  party as now; `/name` and Rename are `rename`; its menu has "Hide for me" (`mine`, per operator) and
  "Archive for everyone", "Delete for everyone" (`setState`); a conversation it starts gives its owner
  (the operator) and `title(first)` with the operator's text. Removed: `conversation-index.ts`, `titles.ts`,
  the `admin-api:index` actor and its `seen`/`list` calls, the awaited `agent.dispatched` listener.
- **channel-web**: `GET /chat/api/conversations` is `list({ kind: "people", principals }, { channels:
  ["web"], owned: true, … })` (`channels` is the view's choice: neural-agents widens it to Google Chat's;
  `owned: false` adds the project chats of others, as its shared chats do); a project's chats are `list(…,
  { space })`, their counts and "not empty" are `count`; every route on a chat id first asks
  `access(viewer, { key: keyOf(user, chat) })`, so "another user's chat is `404`" stays one function. Rename,
  archive and delete are `rename` / `setState` (its "delete" becomes "Delete for everyone", the owner's;
  another member's chat gets "Hide for me"); the first message is `title(first)`; it gives `owner` at
  admission. Removed: `titles.ts`, the `/name` hand-off, `title:<key>` records, `channel_web_conversations`
  and the accounts actor's index role (`channel-web.seen`, `listProject`, `projectConversation`,
  `projectChats`, `forget`): a removed user's chats become `setState(component, deleted)`. Kept: its
  transcript (`channel_web_entries`), commands, accounts, live view.

## Authorization
- **Who sees.** An operator and a component: everything (a deleted conversation only when asked for by
  state or reference). A person: a conversation they own (`owner` among their principals; with
  `principals` installed, a person's other identities too) or of a space a grant names, current, not
  delegated, with activity they may see, not deleted. Grants are listed within each provider's list
  bound (rooms: 30 minutes) and checked fresh by `access` and before every act (rooms: 2 minutes;
  projects: `roleOf` now).
- **Who acts.** Any viewer who sees a conversation hides it, names it and marks it read, for themselves.
  Rename, archive and delete for everyone: operators, components, its owner, an owner grant of its space
  (a project's owner). Writing in a conversation is not the directory's: each view decides (channel-web: its
  owner; a shared chat's members downstream), after `access`.
- **Trust.** The directory is trusted code's: a view authenticates its viewer and builds `Viewer` from the
  session (as `projects`' `Caller`); the provider's client computes the grants with `audienceOf` and the
  actor applies them. A people viewer's principals are 1 to 20, never of the `dashboard` or `delegate`
  channel (`invalid`). A cursor is a sort key: it gives nothing a viewer may not list.
- **Adversarial cases**, each a suite case or a view test: another user's chat by id or by key (`404`,
  nothing called in its object); a Google Chat conversation id made from a `web:` key; a member removed
  from a space (listed at most within the list bound, refused at once by `access`); a delegated child in a
  project's space (never listed to people); an operator's follow-up (no move in people's order, no unread,
  no unarchive); a member's rename, archive or delete of another's chat (`forbidden`); hide by A leaves B's
  list as it was; A's own name never seen nor searched by B; a stage that throws (no grants), one that
  appends another source's grant (dropped), more grants than `AUDIENCE_MAX` (`limit`, logged); a
  `dashboard:` principal in a people viewer (`invalid`); a late or repeated `seen` (no change); `q` with
  `%`, `_`, `\`; a deleted conversation's later activity (still deleted for people).

## Migration
- **In the kit: none.** pikit 0.0.x carries no migration (AGENTS.md); the directory rebuilds itself from
  the runtime at each App's start (its normal backfill) and titles at most `retitleAtStart` conversations a
  start. What is lost in a project that had them: operators' renames and archive/delete, web users'
  renames, archives and deletes (a deleted web chat is listed again), the provisional titles. The removed
  components' tables stay in old databases, unread: nothing creates, reads or drops them.
- **Downstream (neural-agents, which runs in production)**: a one-off project component, run once with the
  old copies still installed, then deleted. In each object at start: `admin_api_conversation_titles` and
  channel-web's row (with `title:<key>`: whose) -> `rename` (an operator's or a user's title), `title(model)`,
  `title(first)`; channel-web's `hidden` -> `setState(deleted)`, `archived` -> `setState(archived)`. In the
  index actors, through an operator route: `admin_api_hidden` -> the operator's `mine(hidden)` (it was the
  operators' list only), `channel_web_reads` -> `mine(readUpTo, hidden)`, `neural_rooms_reads` ->
  `mine(readUpTo)` of each person's web principal. Then the consumer drops the old tables in its own code.
- **The rooms index becomes a membership provider**: its stage of `conversation.audience` (both Apps:
  its client already has the Worker half) answers a person's open rooms with a current membership,
  `googlechat:spaces/AAA`, within its windows (30 minutes listed, 2 minutes fresh, Google Groups closed).
  It keeps the Google sync, memberships and the projects' member sync; `rooms.conversations`, `resolve`,
  `markRead`, `seen`, `neural_rooms_conversations`, `_web` and `_reads` go, and channel-google-chat's
  `rooms.seen` with them (the directory's recorder sees the same events). channel-web's merged list and its
  `g_` ids become one list whose Google Chat rows are `channels: ["web", "googlechat"]`.

## Removals
- admin-api: `conversation-index.ts`, `titles.ts`, the `admin-api:index` actor, `admin-api.seen` and the
  index's calls, the `agent.dispatched` / `started` / `settled` / `failed` / `reset` listeners, the start
  backfill; `/name` writes through `rename`.
- channel-web: `titles.ts`, the index half of `store.ts` (`seen`, `list`, `listProject`,
  `projectConversation`, `projectChats`, `forget`, `channel_web_conversations`), `channel-web.seen`, the
  `/name` hand-off; `ChatConversation` fields read from the entry.
- [cloudflare-conversation-index](cloudflare-conversation-index.md): superseded (its open question on
  pending work stays, moved to [kit follow-ups](kit-follow-ups.md)).

## Conformance
`createConversationDirectoryConformance(fixture)` (`@pikit/contracts/testing`): the fixture records
through the provider's real recorder (a runtime double emitting the events), audience stages are doubles,
and it can restart the provider. Cases: order and paging (ties, nothing missed or repeated across chunks,
`invalid_cursor`); the viewer filter (owner, grants, principals of one person, delegated, deleted,
current, operator sees all); every adversarial case above; the title precedence; hide, name and read are
per viewer; archive and delete for everyone in every viewer's list; unarchived by people-visible activity
only; unread by others only, capped, read marks only forward; `seen` idempotent and late; restart keeps
everything; bounds (`TITLE_MAX`, `q`, `AUDIENCE_MAX`). A double, `createMemoryDirectory`, passes it, and
each case is checked against a broken double (rule 7: owner check dropped, grants ignored, title precedence
reversed, hide applied for everyone, an operator's activity shown). `createConversationAudienceConformance`
for a stage (appends its own source only, a throw appends none, a removed member none at the fresh
check). The `conversations.registry` suite gains the owner's cases (recorded at the first resolve, kept
through resets and restarts, a later one ignored, an empty id refused). conversations-directory passes the
directory suite on a server and in the workerd lane (the Worker's half against the actor).

## Plan: phases, parallel tasks, file ownership
Each phase leaves the kit green (`bun run typecheck`, `bun test` bounded, `registry validate`, the
workerd lane). Tasks of a phase run in their own worktrees; a task touches only what it owns. Generated
files (`bun run registry generate`: `registry/registry.json`'s generated parts, the shadcn items) are the
integrator's, regenerated after each phase's merge.

| Phase | Task | Owns | Done when |
|---|---|---|---|
| 0 | **0a directory contracts** | `packages/contracts/src/{conversation-directory,conversation-audience}.ts` (new), `packages/contracts/src/index.ts`, `packages/contracts/src/testing/{conversation-directory,conversation-audience}.ts` and their tests (new), `packages/contracts/src/testing/index.ts`, `packages/cli/src/registry/capabilities.ts`, `docs/contracts.md`, `SPEC.md` (§5's sentence), this note | suites pass on `createMemoryDirectory`; each case fails a mutant |
| 0 | **0b owner and sender** | `packages/contracts/src/{conversations,inbound,agent}.ts`, `packages/contracts/src/testing/conversations.ts` (+ test), `registry/components/conversations-kv/**`, `registry/components/conversations-file/**`, `packages/pi-adapter/src/` (the `agent.dispatched` emit and its test), `registry/components/runtime-pi/README.md` | both registries pass the owner cases; the event carries the sender; no new export (0a's `index.ts`) |
| 1 | **1a provider** | `registry/components/conversations-directory/**` (new), its `registry/registry.json` entry, `registry/dashboard/dashboard.json` (installed with admin-api), `registry/presets/*.yaml` if one lists admin-api's needs, `tests/workerd/src/**` and `tests/workerd/test/conversations-directory.workerd.ts`, the shared test compositions that include admin-api (it is added there, unused yet) | the suite on a server and in workerd; one `seen` per flush, none on a message's path (counted at the mailbox) |
| 1 | **1b projects' stage** | `registry/components/projects-sql/**` | the audience suite over projects-sql, both halves |
| 1 | **1c Google Chat's first text** | `registry/components/channel-google-chat/**` | optional `conversations.directory`: a thread's first message as Google sent it, `title(first)` |
| 2 | **2a admin-api as a view** | `registry/components/admin-api/**`, `registry/dashboard/files/src/**`, `tests/workerd/test/admin-api.workerd.ts` | the dashboard's list, rename, hide, archive, delete over the directory; index and titler removed |
| 2 | **2b channel-web as a view** | `registry/components/channel-web/**` (with `chat/`, `view/`, `projects-stores.test.ts`), `tests/workerd/test/{channel-web,projects-e2e}.workerd.ts`, `tests/acceptance/projects.test.ts` | its lists, projects' chats and counts, rename, archive, delete for everyone, hide for me; the index half and titler removed; isolation tests unchanged and green |
| 3 | **3 docs and removals** | `features/**` (this note to `completed/`, the index note superseded, README rows, spaces and projects pointers), `features/kit-follow-ups.md`, `CHANGELOG.md`, `.agents/skills/pikit/**`, `SPEC.md`, `docs/contracts.md` | no doc names admin-api's index; `rg 'u00a7|u20[0-9a-f]{2}'` clean |

0a and 0b, 1a to 1c, 2a and 2b run in parallel; phases in order. Downstream (neural-agents, not the kit):
`pikit upgrade` of admin-api and channel-web (their edited copies conflict in `store.ts`, `routes.ts`,
`backend.ts`), the one-off import, rooms as a stage.

## How it fits pikit, and where it bends
- **Contracts are the only coupling**: views and providers meet in `conversations.directory`; channels and
  stores give owner (the registry), space (as now) and membership (a pipeline stage); nobody reads another's
  tables. **Absence**: without the component nothing lists across conversations; admin-api and channel-web
  require it, the dashboard's defaults install it.
- **Bends SPEC §5**: "The list of conversations, on every host, comes from admin-api's conversation index"
  becomes "from `conversations.directory`". Proposed in §5 first (task 0a), as SPEC §7 requires.
- **A pipeline used for authorization.** Pipelines tolerate a broken stage; here that must fail closed, so
  `audienceStage` only appends its own grants and a throw appends none, and `audienceOf` refuses past its
  bound instead of cutting.
- **One actor takes every `seen`**, as `admin-api:index` does now: fine for teams (flushes batch a
  conversation's events), not a global query engine. Sharding it (by space) is a later change of the
  provider, not of the contract.
- **Events can be missed** (K3): the recorder writes from events; a miss is repaired at the next activity
  or the App's next start, as admin-api's index says today. Writing from a feed with a cursor would close
  it; not needed by lists that refresh.
- **"Delete" deletes nothing of the runtime's** (pi-durable keeps every conversation): it is a state for
  every view, said as such, as both "deletes" are now.
- **Rule 1**: `owner` and `sender` come with their consumer (the directory); `unread` with channel-web's
  project chats (a dot on a chat others wrote in) and downstream's shared chats and Google Chat rows.
- **Experimental**: one provider (rule 8).

## Pi first
Nothing in Pi: a Pi session knows nothing of the others, and pi-durable's conversations have no title,
owner or visibility.

## Open questions
1. **A project's members and an adopted space's threads.** With projects-sql's stage, every member of a
   project sees every conversation of its space: for a Google Chat space adopted as a project, also a
   manual member who is not in the Google space. Accept, or grant only a project's web chats (the stage
   naming channels)?
2. **Archive and delete are shared now.** The dashboard's Archive and Delete hide from operators only
   today; here they become "for everyone" (a user's list too), with "Hide for me" for the old meaning.
   Keep the dashboard's buttons as "for everyone"?
3. **Delete for everyone and a platform that goes on.** A deleted Google Chat thread or Telegram chat keeps
   going on its platform with the agent's context. Leave it so (deleted only in the views), or also reset
   its key, so the next message starts a new conversation?
4. **A project's owner on another member's chat**: rename only, or also archive and delete for everyone
   (the design's default)?
5. **Hide for me**: for good until undone (the design), or until new activity, as archive?
6. **Titles of Google Chat threads** by a model too (one call per thread; today rooms shows the first
   message): yes?
7. **neural-agents' production data**: run the one-off import (renames, states, read marks), or accept
   re-titled conversations and lost states?
