# Subagents

**Public appeal:** ⭐ The agent splits a large job into parallel workers and merges their results.
Hermes spawns isolated subagents for parallel workstreams.

**Specified:** idea (the former SPEC §6.4 table: "Deferred"; its §7.1: "a subagent is a child
conversation")

**Needed by:** nothing required. The budget "≤ 6 concurrent outbound connections" on Cloudflare
caps its fan-out (SPEC §4).

## What it gives
An agent delegates part of its work, to a helper of its own or to another agent of the project, and
continues with the result.

## How it fits pikit
Two different things:
- **A helper inside the conversation** (same agent, forked context, parallel runs): Pi's, below.
  pikit builds nothing for it.
- **Delegation to another pikit agent** (its own prompt, tools and workspace): routing between
  agents, which is pikit's. A tool sends a message to a conversation of that agent through
  `admitInbound`, with a request id derived from the calling tool call, and reads the answer from
  `agent.submissions`' `answers` (a `Feed`, K3; `packages/contracts/src/submissions.ts`). The tool
  is `replay: "never"`; a repeat is the same request id, so the same submission.

## Pi first
Pi's durable runtime has subagents: foreground and background child conversations owned by a tool
task, created atomically inside the session with a registry mapping and request-id deduplication,
and aborted with their owner (`pico-v5.md` §5.4, §7.2). Pi's `subagent` example extension spawns
`pi` processes, which pikit cannot use (no `coding-agent`, no `child_process` on Cloudflare). So the
in-session helper waits for `pi-durable` and reaches pikit through the adapter.

## Open questions
- Is delegation a contract (two real parties: a delegating tool and the runtime), or a tool over
  `admitInbound`?
- Which actor the child sees, and how routing authorizes an agent as a sender.
- Cost and depth limits.
