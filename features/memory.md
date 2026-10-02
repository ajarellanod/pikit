# Memory and user profiles

**Public appeal:** ⭐ The agent remembers you across conversations and channels. Hermes has
agent-curated memory with periodic nudges, user profiles (`MEMORY.md`, `USER.md`) and FTS5 search
over past sessions; OpenClaw keeps state and memory on your hardware.

**Specified:** idea

**Needed by:** nothing required.

## What it gives
Facts the agent chooses to keep, available in later conversations of the same person or agent; a
profile per person (name, preferences, what they work on); search over past conversations.

## How it fits pikit
- **The store**: `memory-sql` on `storage.sql` provides a `memory` capability (remember, recall,
  forget, search; scoped by agent and person), with its suite first. Its registry declares the kind
  `memory` and the capability in `memory-sql`'s `component.json` (`declares`); the contract's type lives
  in the component (declaration merging on `AppCapabilities`), not in `@pikit/contracts`.
- **The behaviour is an agent extension** (`agent.extension`, a Pi `defineExtension` from
  `@pikit/pi-adapter/extensions`), provided by `memory-sql` or a separate `memory` component that uses
  the store, and named by the agents that remember (`extensions: ["memory"]`):
  - **recall**: an async system prompt section that asks the store for what concerns this person and
    renders it before each request (the conversation's key is its `ConversationDoc`);
  - **remember**: a tool (`memory_write`, `replay: "unsafe"`, idempotent by
    `${conversationId}:${callId}`) the model calls, or a hook (`GenerationTask`'s `afterResponse` /
    `onYield`, or `CompactionTask`'s `beforeCompact`, which sees what is about to be summarized) that
    extracts facts without being asked; `memory_read` (`replay: "safe"`) for explicit search;
  - **per-conversation state** (what was recalled already, a nudge counter): a conversation document
    (`defineDoc`), committed with the transcript.
- Memory is neither `agent.state` (one conversation, reset by `/reset`) nor the registry's metadata.
- **Memory is per person and agent, shared across channels; a conversation never is.** Ana on
  Telegram and on WhatsApp has two conversations, two sessions
  ([conversation routing](conversation-routing.md)), and one memory the agent keeps of her, which
  both read and write.
- **One person, many actor ids, linked on purpose.** A person seen on two channels is two actor ids,
  and no platform proves they are one (Telegram does not give the phone number). A link is explicit
  and confirmed from both sides: `/link` on one channel gives a one-time code, sent from the other.
  Until linked, each actor id is its own person. A wrong link shows one person's memory to another,
  so linking belongs with [pairing](pairing.md)'s approvals, never guessed from a name or a number.
- **Where it lives.** On a server, `memory-sql` on the app's `storage.sql`, keyed by person and
  agent. On Cloudflare a conversation's Durable Object cannot hold it (another channel's conversation
  is another object), so:
  - **one Durable Object per person** (`idFromName(personId)`), which each conversation calls
    through `actor.mailbox` (recommended): one owner of a person's memory, as C1 gives a conversation
    one, so writes from two channels at once are ordered, and each person's data is apart; it costs
    one call between objects per recall (one per model request, from the recall section) and per write,
    within C4's subrequest budget;
  - or **a shared D1 database**, as the [conversation index](cloudflare-conversation-index.md) uses:
    search and the dashboard over everyone's memory are easier, but every person's memory is one
    global table whose concurrent writes the component orders itself.
- Absent: no tools, no table, nothing injected; an agent that does not name the extension has none of
  it even when it is installed.

## Pi first
Pi has no memory across sessions: a Pi session is one conversation's memory, and compaction
summarizes inside it. Pi's durable runtime adds documents scoped to a conversation or a session
(`pico-v5.md` §3), not across sessions. Memory shared by conversations, people and channels
crosses sessions, which one Pi process cannot do, so the store is pikit's. Everything the agent does
with it (recall, remember, nudge) is a Pi extension, reached through `agent.extension`: adopt an
existing one if it keeps its store through a capability.

## Open questions
- Memory is where a prompt injection persists: who may write it, and does a stranger's
  conversation ever write shared memory?
- The link's flow in detail (who may start it, how it is undone, whether the owner approves it) is
  decided with [pairing](pairing.md).
- On Cloudflare, a person's Durable Object (recommended above) or D1: settled when `memory` is built,
  with search in mind (a person's object searches only that person's memory).
- Session search: an index fed from `agent.submissions`' `answers`, or reading sessions.
