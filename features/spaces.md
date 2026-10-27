# Spaces: what the conversations of a place share

**Public appeal:** — (a team's Google Chat space where every thread is its own conversation, running
in parallel, and the agent still knows what was decided in the other threads; a web chat project
whose chats share what the agent knows about it)

**Specified:** yes (owner's decisions, 2026-10-21). **Built** (2026-10-21): `ConversationRef.space`
and `spaceOf` (`@pikit/contracts`), recorded by both `conversations.registry` providers and the
runtime; channel-google-chat and channel-web give it; memory per space (memory-sql, memory-recall,
memory-summaries); `tool-space-files` over the new `storage.blob` (storage-blob-fs, storage-blob-s3);
retention of conversation workspaces; commands typed in chats (`admitInbound`'s `commands`).

**Needed by:** nothing required. It brings pikit to what the owner's previous platform (pi-hive) did
with `memory_scope: space`, without giving up threads that run in parallel.

## The problem
A conversation is one chat of one channel ([conversation routing](conversation-routing.md)). In Google
Chat each thread is a conversation by default (`googlechat:spaces/AAA:threads/BBB`), so whatever hangs
from the conversation's key (memory, files) is per thread: what Ana told the agent in one thread of the
"H Hotels" space ("the conversion that counts is the booking, not the lead") is unknown in the next
thread. Making the whole space one conversation (`conversations: "chat"`) shares it, but mixes every
topic in one transcript and serializes the space: a long run in one thread makes every other thread
wait.

## Levels (owner's decisions)
| What | Hangs from | Why |
|---|---|---|
| Transcript, run, workspace and VM | the **conversation** (a thread, a chat), per agent | parallel, clean contexts; a workspace is ephemeral ([agent sandboxes](agent-sandboxes.md)) |
| Memory: facts, rules, summaries | the **space**, shared by every agent in it; an agent may keep its own instead | a fact about a client serves every agent working for it |
| Saved files (what must outlive a conversation) | the **space**, saved on purpose (`tool-space-files`) | the agent decides what is worth keeping; no thousands of stray files in context |
| Preferences | the **person** (a request's sender) | they follow a person into any space |
| The machine (packages, hosts, secrets) | the **agent** | unchanged |

A workspace stays per conversation, not per space: agents that make thousands of files would put them
in every other thread's way. What must last goes to the space's files or to memory (a link to a
document is a fact); the rest is deleted after a while (retention, below).

## The contract
- `ConversationRef.space?: string`: the space a conversation belongs to, opaque to all but the channel
  that names it. The channel gives it (`AdmitOptions.space`); `conversations.registry` records it with
  the key's first resolve (`resolve(key, agent, { channel, space }, ctx)`) and keeps it through resets
  and restarts, as the channel; the runtime records it with the conversation (`ConversationDoc`), so a
  run sees it (`CONVERSATION`, `PrepareContext`) whatever ref reached it. A conversation never changes
  space. An empty space is refused.
- `spaceOf(ref)`: the origin's space, else the origin's key. A channel that gives no space (a private
  chat, the HTTP API) changes nothing: each conversation is its own space, as before. A delegated task
  is in its origin's space, never in one of its own.
- It is not where an answer goes (the key is) and not an access boundary by itself: who may write in a
  space is the channel's and the router's.
- Proved by the `conversations.registry` suite (kept through resolves, resets and restarts; none given,
  none; empty refused; checked against two broken doubles), a runtime test (a run sees it, recorded with
  the channel) and a delegation test (a child is in its origin's space).

## Who gives a space
- **channel-google-chat**: the chat's own key (what the key is in "chat" mode) for every thread of it,
  so a chat switching modes keeps one space.
- **channel-web**: a chat created in a project is in that user's project's space; a chat with no project
  is its own. A chat's project is fixed when it is made.
- **Telegram**: both channels answer private chats only, each its own space, so they give none.

## What uses it
- **Memory** ([memory](memory.md)): an actor per owner (`memory:space:<space>`; `memory:agent:<agent>`
  for the agents memory-sql's `agentScope` keeps apart; `memory:person:<channel>:<id>` for a person's
  preferences), decided in one place (`MemoryStore.ownerOf`). FTS5 search on both targets; rules and
  preferences the agent proposes (`propose_rule`, `propose_preference`) stay pending until a person
  approves them (`/rules`, `/prefs`); structured summaries (title, topics, entities, keywords,
  decisions, action items, facts, open questions) on both targets.
- **Saved files**: `tool-space-files`, an agent extension (`space-files`): `files_save`,
  `files_list`, `files_get`, `files_delete`, and a section listing the space's newest files, so every
  conversation of the space knows they exist. A name saved again is a new version. An index actor per
  space (`space-files:<space>`), the bytes in `storage.blob` (written first, so the index never points at
  missing bytes). Limits: 25 MiB a file, 1 GiB and 500 files a space by default. A text file with a
  credential's shape is refused; a binary one cannot be checked. Every agent of the space sees them.
- **Commands typed in a chat**: `admitInbound`'s `commands` (routed like any message, run with the
  sender, never dispatched), so people manage the space's rules from the chat itself
  ([slash commands](slash-commands.md)).

## `storage.blob`
Files a component keeps by key, in a namespace of its own (`packages/contracts/src/blob.ts`): put,
get, delete, list by prefix with pages; restricted key characters; a provider states its largest value
(at least 25 MiB). Providers: `storage-blob-fs` (a server's disk) and `storage-blob-s3` (any S3 API:
AWS, R2, the bucket of a celld fleet; both targets). [Workspace snapshots](workspace-snapshots.md)
proposed it first and can build on it.

## Retention
A conversation's workspace not used for `retentionDays` is deleted (execution-gondolin and
workspace-local, so also a sandbox host behind execution-remote; execution-do through a wakeup in each
object). Off by default: deleting data is opted into. A workspace in use is never deleted; shared ones
(`workspace: "agent"`, `per: "agent"`) are never swept ([agent sandboxes](agent-sandboxes.md)).

## Try it
```ts
// pikit.config.ts, with channel-google-chat, memory-sql, memory-recall, tool-space-files and a storage.blob provider
"memory-sql": { agentScope: [] },                    // every agent shares its space's memory
"execution-gondolin": { retentionDays: 30 },         // conversation workspaces go after 30 idle days
// src/agents/trader/agent.ts
defineAgent({ name: "trader", model: "...", extensions: ["memory", "space-files"] });
```
In one thread of a space: "/rules add The conversion that counts is the booking"; in another thread the
agent has the rule in its prompt, and a file it saved with `files_save` in the first is in the second's
section.

## Open questions
- Shared rooms in the web chat (several people in one chat, live): the next step on the same pieces
  (a project with members whose chats are shared).
- Who may run which command from a chat beyond the channel's `commands` list ([policy tools](policy-tools.md)).
- Instructions per space other than its rules (a folder of context per space).
