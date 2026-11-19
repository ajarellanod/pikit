# conversations-directory

One directory of the conversations every view lists
([features/conversation-directory.md](https://github.com/ajarellanod/pikit/blob/main/features/conversation-directory.md)):
it provides `conversations.directory` (`ConversationDirectory`, `@pikit/contracts`'
`conversation-directory.ts`). Per conversation (a key and its runtime conversation): its channel,
agent, space and owner, **one title** whoever looks, when it was made and last active, whether a run
goes, and its state for everyone (`listed`, `archived`, `deleted`); per viewer, their own state
(hidden for me, read up to, a name of their own) and `unread`. Views (the dashboard, the web chat)
read it through a `Viewer` they authenticated; who belongs to which space comes from the
`conversation.audience` pipeline (projects-sql's stage, a channel's).

- **Provides:** `conversations.directory`.
- **Requires:** `storage.sql`, `conversations.registry` (a conversation's place and owner), `agent.observe`
  (the start's backfill; a conversation's first text for its title).
- **Optional:** `actor.inbox`, `actor.mailbox` and `wakeups` (on Cloudflare, actors-do: required there,
  it refuses to start without them), `model.complete` (titles; without it none), `agent.definition`
  (each agent's model, which titles its conversations unless `titleModel`).
- **Targets:** `server` and `durable`: it imports nothing platform-specific. On `durable` the Worker's
  App runs the Worker half (`conversations-directory-worker`, `component.json`'s `apps.worker`):
  `conversations.directory` over the mailbox.
- **Installs to:** `src/pikit/conversations-directory/` (`index.ts`, `directory.ts` the directory's
  rows and queries, `client.ts` the contract's checks and the grants, `calls.ts` the index object's
  answers, `recorder.ts` the runtime's events and the outbox, `titles.ts` the titler, `update.ts`,
  `tables.ts`, `config.ts`, `worker.ts`, `conversations-directory.test.ts`). The dashboard installs it
  (`registry/dashboard/dashboard.json`).

## Config

```ts
// pikit.config.ts
export const config = {
  "conversations-directory": {
    titleModel: "openrouter/google/gemini-flash-1.5", // absent: each conversation's agent's model
    retitleAtStart: 20, // conversations the start's backfill found that one start titles
  },
};
```

## How it works

- **Where it is.** It never reads the target: `actor.inbox`'s `scope` says. On a server (`"all"`, or
  no `actor.inbox`) every table is the App's `storage.sql`. On Cloudflare (`"one"`) the directory is one
  actor, the object `conversations-directory:index` (an object of the conversations' class, running
  the same App), and each conversation's object keeps its own `_outbox` and `_titles`.
- **Tables** (`conversations_directory_*`): `_entries` (one row per conversation), `_viewers` (one per
  viewer and conversation: `hidden_at`, `read_at`, `name`), `_activity` (each conversation's newest 100:
  who, when, whether people see it), in the directory; `_outbox` and `_titles` in each conversation's App.
- **One update per message.** The recorder listens in the conversation's App: `agent.dispatched` (not
  a duplicate: activity by its sender; the first one of a conversation also its place, from
  `conversations.registry`), `agent.started` (busy), `agent.settled` / `agent.failed` (not busy,
  activity by the agent), `conversation.reset` (the previous one no longer current, the new one
  recorded). On a server it writes the directory at once. On Cloudflare each event is one upsert of
  the conversation's `_outbox` row (merged: a burst of events is one row) and a wakeup
  (`conversations-directory.flush`), which sends every row as one `conversations-directory.seen` to the
  index object and deletes what it sent: a message makes no call to the directory on its path. A
  `seen` is field-wise idempotent (activity a maximum, `busy` and `agent` by the newest `seq`, `current`
  only going false, titles by precedence): a late or repeated one changes nothing.
- **Two orders.** Activity of an operator's request (`dashboard:`) and a run only such requests took
  moves `last_activity` (operators' and components' order) and never `shown_activity` (people's): no
  reordering, no unread, no unarchive, no unhide for people.
- **Who sees.** Operators and components every conversation; a person one that is its key's current,
  not delegated, not deleted, with activity people see, owned by one of their principals or of a space
  a grant names. The grants are computed in the calling App (the Worker's on Cloudflare) with
  `audienceGrants`: within each stage's list bound for a list (in chunks of spaces, each query under
  Cloudflare's 100 bound parameters), checked fresh for one space before `access` and every act.
- **For everyone.** `rename`, `setState` (archive: operators, components, the owner, a space's owner;
  delete: never a space's owner). Deleting a key's current conversation first resets the key in its own
  App (on Cloudflare the index object calls the key's object, `conversations-directory.reset`), so the
  platform's next message starts a new conversation. Nothing of the runtime's is deleted.
- **Titles**, one per conversation: `first` (a channel's `title`) < `model` < `rename`. The titler runs
  in the conversation's App after its first completed run a person started, in a wakeup
  (`conversations-directory.title`; on a server without `wakeups`, in the background, waited for at
  stop), from the `first` text when there is one, else the run's first user text; its try is recorded
  before the model is called (at most 2), and its answer goes out like any update.
- **Events can be missed** (K3): at each App's start the conversations `agent.observe` holds that this
  App never told the directory of are given to it (a server's in the background, an object's own),
  with no call when there is nothing new; at most `retitleAtStart` of them are titled.

## Tests

`conversations-directory.test.ts` runs the `conversations.directory` suite on a server's layout and on
Cloudflare's in one process (an inbox of scope `"one"`: the outbox, the flush, every call through the
mailbox, the reset asked of the key's App), and checks one `seen` per flush and none on a message's
path, the titler, and the backfill. The workerd lane runs the suite from the Worker half against the
real index object (`tests/workerd/test/conversations-directory.workerd.ts`).
