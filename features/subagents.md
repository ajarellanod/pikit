# Subagents

**Public appeal:** ⭐ The agent splits a large job into parallel workers and merges their results.
Hermes spawns isolated subagents for parallel workstreams.

**Specified:** delegation to another agent built, on every target (`tool-delegate`, on the runtime's
`AGENT_DELEGATION`); a helper of the same agent with its context (a fork) is open. (The former SPEC
§6.4 table: "Deferred"; its §7.1: "a subagent is a child conversation".)

**Needed by:** nothing required. The budget "≤ 6 concurrent outbound connections" on Cloudflare
caps its fan-out (SPEC §4).

## What it gives
An agent delegates part of its work, to a helper of its own or to another agent of the project, and
continues with the result.

## Pi first
pi-durable has subagents (its examples `22-subagent-foreground.ts` and `23-subagent-background.ts`,
`pico-v5.md` §5.4, §7.2), in 1.2.0:
- **Foreground:** a tool call creates a conversation owned by its task (`ownership: { kind: "task" }`),
  submits to it with a request id derived from the task id, and waits. Aborting the call aborts the
  child; a rerun of a replay-safe call after a crash finds the child it created (`scanConversations({
  ownerTaskId })`) and the submission it made.
- **Background:** an anchor task (background, of the parent conversation) owns the child, which
  outlives the parent's turns; a reporter task submits to it, waits, and posts the answer to the parent
  as a follow-up. Both are durable tasks: a restart resumes them.
- Everything is in the parent's storage, so it is the same in a Durable Object.

Pi's `subagent` example extension of the coding agent spawns `pi` processes, which pikit cannot use (no
`coding-agent`, no `child_process` on Cloudflare); pi-durable's child conversations are what pikit
builds on.

## How it fits pikit
What pi-durable does not know is pikit's agents. The runtime adds that layer
(`packages/pi-adapter/src/delegation.ts`), given to every tool in its context (`AGENT_DELEGATION`,
`@pikit/pi-adapter/tools`):
- **The child is another of the project's agents**: created as pi-durable's example creates it, then
  applied as every conversation is (`AgentConfigs.apply`: the definition's model, prompt, tools,
  extensions and skills; its key and agent recorded, so a reopened Harness builds it again). With
  `execution-gondolin` or `execution-remote` it works in a sandbox of its own, its agent's machine,
  not its parent's; a child of the same agent shares its parent's only in a Durable Object (on a
  server it is a conversation of its own, with its own sandbox) ([agent sandboxes](agent-sandboxes.md)).
- **Its message has a sender**, the delegating agent (`{ channel: "delegate", id }`, an
  `InputEntry`), which its tools and hooks read (`RUN_REQUESTS`).
- **It knows whom it works for**: its record holds its origin (`ConversationRef.origin`), the
  conversation a person or a channel opened and the tree descends from (the parent's origin, or the
  parent), written by the delegation in the commit that creates it and never taken from a ref or the
  model. Its tools, hooks, sections and `prepare` see it in `CONVERSATION`, also after a restart, and
  read it with `originOf`: memory-recall's person, tool-schedule's key, extension-approvals'
  conversation are the chat's, not the task's. `agent.submissions` and `agent.observe` do not carry it.
- **What it asks the person reaches them**: a completed task's outcome carries the parts of the
  child's run that answered it (a question of `askUser` or `request_approval`). The `delegate` call
  that waits gives them with its result (`withParts`); a background report brings them to the parent
  (`AgentRequest.parts`, kept with the message and given with the answer of the parent's run that
  takes it, before its tools' parts, once). The parent's agent reads them as shown (`partsNote`).
- **A background answer goes through `dispatch`**, not straight into the parent's inbox as in the
  example: so it is logged in `answers` and announced, and the parent's channel delivers the parent's
  answer to the person. Request id `delegate-result:<reporter task id>`: a rerun admits it once.
- **The tasks are installed by the runtime** (`pikit.delegation`, `pikit.delegation-anchor`,
  `pikit.delegation-reporter`) before pi-durable opens, so a restart finds their definitions.
- **A background task can be listed, steered and cancelled** by the conversation that started it, and
  only by it: `start` returns its id (the call's task id), and the parent's `pikit.delegations`
  document records its agent, child, steers, a cancel and its bounded result (fixed in the reporter's
  commit), so `list` survives restarts and another conversation's id is `not_found`. A steer goes to
  the child with `whenBusy: "steer"` and the task's sender; it is recorded before it is sent and
  refused once the result is fixed, and the reporter waits for every recorded steer before fixing it,
  so one that came after the child's last tool round (and ran on its own) is what the report answers,
  never lost. A cancel marks the task and aborts the child; the report says stopped, once; each submit
  to the child checks the mark after it, so none escapes a cancel.

`tool-delegate` is the tool: which agents (each with what it is for, which the model reads), how deep
(`maxDepth`), `wait` (`run`) or not (`start`), a delegated task always waiting for its own; and
`delegate_tasks`, `delegate_steer`, `delegate_cancel` for the tasks not waited for, separate so an
agent names only those it needs (and `extension-house-rules` can allow them per sender). It owns the
children's keys (`delegate:<depth>:<chain>:<task id>`, `<chain>` the agents above the child, root
first, joined by `.`). A tool cannot use `agent.runtime` (the runtime uses every tool: a dependency
cycle), which is why the delegation comes in the tool's context.

**Who may delegate to an agent** is an agent's `from` in the tool's config: a call to it is allowed
only when the calling conversation's agent and every agent above it, up to the conversation a person
or a channel started, are in `from` (so an allowed `orchestrator` does not launder a `support`
agent's task to a `developer` with a token). The chain is trusted data, never the model's: it is read
from the calling conversation's key, which only the tool writes, and its first agent must be the
origin's, which the runtime fixed. A chain that does not check out reaches no restricted agent, and
its children's chain is written empty (fail closed). The runtime and the contracts are unchanged:
the tool decides, from what the runtime gives it (`CONVERSATION`).

Not through `admitInbound`: routing picks an agent for a person's message; here the calling agent names
it, among the tool's config.

## In the dashboard
Beautiful UI's harness has a **Tasks** panel (`TaskRows`: a row per task, its status, steps and
output) beside the chat. The dashboard dropped it while a run's tool calls are its only work (they
are the chat's chips); it is the place for durable tasks and subagents: a conversation's task graph
(pi-durable's `taskGraph()`), read through an admin route, each child conversation a row that opens it.
A `delegate` call already puts its child's conversation id in its details (`api.details`), as
pi-durable's example does for a UI to attach to it.

## Open questions
- A helper of the same agent, with its context: pi-durable forks a conversation
  (`forkConversation`); a `fork: true` on the delegation would make the child the parent's own agent
  from the parent's transcript.
- Named, long-lived subagents a conversation messages again (pi-durable's example 23 keeps a name to
  conversation map): today each call is a new child.
- Cost limits: none beyond depth; each child's usage is its own conversation's.
