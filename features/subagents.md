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
  extensions and skills; its key and agent recorded, so a reopened Harness builds it again).
- **Its message has a sender**, the delegating agent (`{ channel: "delegate", id }`, an
  `InputEntry`), which its tools and hooks read (`RUN_REQUESTS`).
- **A background answer goes through `dispatch`**, not straight into the parent's inbox as in the
  example: so it is logged in `answers` and announced, and the parent's channel delivers the parent's
  answer to the person. Request id `delegate-result:<reporter task id>`: a rerun admits it once.
- **The tasks are installed by the runtime** (`pikit.delegation`, `pikit.delegation-anchor`,
  `pikit.delegation-reporter`) before pi-durable opens, so a restart finds their definitions.

`tool-delegate` is the tool: which agents (each with what it is for, which the model reads), how deep
(`maxDepth`), `wait` (`run`) or not (`start`), a delegated task always waiting for its own. It owns the
children's keys (`delegate:<depth>:<task id>`). A tool cannot use `agent.runtime` (the runtime uses
every tool: a dependency cycle), which is why the delegation comes in the tool's context.

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
