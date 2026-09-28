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
- `memory-sql` on `storage.sql` provides a `memory` capability (remember, recall, forget, search;
  scoped by agent and actor), with its suite first. The kind `memory` is new (naming decision).
- Tools from `tool-memory`: `memory_read` (`replay: "safe"`) and `memory_write` (`replay: "never"`,
  idempotent by `${sessionId}:${runId}:${toolCallId}`). An agent gets them only by naming them.
- Recall into the prompt: through the `agent.prepare` pipeline ([pipeline anchors](pipeline-anchors.md))
  or a Pi extension's `before_agent_start` (tier A, SPEC §6.2b).
- Memory is neither `agent.state` (one conversation, reset by `/reset`) nor the registry's metadata.
- A person seen on two channels is two actor ids; linking them is its own decision (below).
- Absent: no tools, no table, nothing injected.

## Pi first
Pi has no memory across sessions: a Pi session is one conversation's memory, and compaction
summarizes inside it. Pi's durable runtime adds documents scoped to a conversation or a session
(`pico-v5.md` §3), not across sessions. Memory shared by conversations, people and channels
crosses sessions, which one Pi process cannot do, so the store is pikit's. The tools and the
"nudge" may be a Pi extension: adopt an existing one if it keeps its store through a capability.

## Open questions
- Memory is where a prompt injection persists: who may write it, and does a stranger's
  conversation ever write shared memory?
- Linking identities across channels (Hermes' cross-platform continuity) versus
  [pairing](pairing.md).
- On Cloudflare, `storage.sql` is per Durable Object: shared memory needs a shared store (D1),
  as the [conversation index](cloudflare-conversation-index.md) does.
- Session search: an index fed from `agent.submissions`' `answers`, or reading sessions.
