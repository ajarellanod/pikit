# A team of work agents, built on the bases

**Public appeal:** — (an operator's team of agents: a trader, a designer, a developer, an
orchestrator, each with its own skills, tools and permissions, in the chats and task trackers a
company already uses)

**Specified:** no. A map, not one component: which pieces of such a platform the bases already give,
which have a design note, and which have none yet.

**Needed by:** nothing required. It orders the notes it links, for a user who builds this.

## What it gives
A team of agents for a company's daily work, on bases that are durable (a run survives a restart),
deploy to a server or to Cloudflare, change themselves through a reviewed proposal (SPEC §6), and come
with conformance suites. What such a platform usually keeps in configuration files becomes components
a project installs, and agents that name what they may use.

## The map

| Piece | pikit today | Where it goes |
|---|---|---|
| Agents, each with its prompt, skills, extensions and context | built: `agents-folders`, each agent a folder (`agent.ts` its allow-lists, `SYSTEM.md`, channel texts, skills), `pikit agents` writes the App's file; agents-live for the dashboard's | [agent folders](agent-folders.md); `context/` and `extensions/` still open |
| Skills shared by several agents | built: the project's catalog (`agent.skill`) from `src/skills/`, each agent names its skills, live agents and overrides too | [skills catalog](completed/skills-catalog.md), [agent folders](agent-folders.md) |
| Tools per agent | built: an agent has the tools it names (`tool-*`, `tool-mcp`) | — |
| Roles: command and path rules | `extension-house-rules` (tools by name, by sender) | [policy-tools](policy-tools.md) |
| A workspace per chat space, with context copied in | `workspace-local`, a directory per agent; `ConversationRef.channel` built | [channel context](channel-context.md), [agent folders](agent-folders.md) |
| Channels: Google Chat, an HTTP API, Telegram, a task tracker (comments in, comments out) | channel-http, channel-telegram (polling and webhook); Google Chat specified, next | [channel-google-chat](channel-google-chat.md); a task tracker has no note |
| Routes: which agent answers where | router-basic, router-rules (Routing in the dashboard) | — |
| Idempotency, per-conversation serialization | built: request ids deduplicated by the runtime, one owner per conversation | [inbound-dedup](inbound-dedup.md) for transports |
| Rate limits, admission control | none | no note yet |
| Slash commands, prompt templates | `/new` in the channels; `agent.command` exists, but only admin-api runs it; Pi extensions' commands not | [slash-commands](slash-commands.md) |
| Delegation, background tasks | `tool-delegate`: run or start, depth limit, answers to the parent | [subagents](subagents.md) |
| An orchestrator: assign, list, follow, steer and cancel other agents' tasks, read their transcripts | none: `AgentDelegation` has `run` and `start` only | no note yet (below) |
| An agent writes to another chat | none; `outbound.queue.enqueue` reached through the mailbox | no note yet |
| Questions to the user (`askUser`: cards, selects, dialogs) | none | [approvals](approvals.md), [channel-google-chat](channel-google-chat.md) (`askUser`) |
| Decisions: proposed, supervised, approved by rule or after a veto window | the self-change gate only (SPEC §6) | [approvals](approvals.md) |
| Missions: a goal ledger with checkpoints, mirrored in a task tracker | none | no note yet |
| Memory: summaries, search, rules, preferences | none | [memory](memory.md) |
| Routines (cron), followups (one-shot, agent-made) | built: `scheduler-sql` (`scheduler`), `scheduler-admit`, `scheduler-routines` (config), `tool-schedule` (the agent's, its own conversation); server only | [scheduler](scheduler.md) |
| Reply context (a terse reply to a routine's message) | none | with [scheduler](scheduler.md) |
| A persistent JavaScript worker for the agent | none | [codemode](codemode.md) |
| MCP servers per agent | `tool-mcp` | — |
| Browser (cloud sessions) | none | [browser](browser.md) |
| Attachments, assets, size limits | images in `AgentRequest`, from the dashboard only | `InboundMessage.images` with [channel-google-chat](channel-google-chat.md); files: [rich-content](rich-content.md) |
| Durable outbound delivery | `outbound-durable`, `startAnswerDelivery` | — |
| Model fallback, provider account failover | built: `provider-failover` (`failover/<chain>`) | — |
| Tracing (Langfuse, OpenTelemetry) | none; an `agent.extension`'s hooks on model requests and tool calls | no note yet |
| Dashboard, monitor | the dashboard (`src/dashboard/`, admin-api): chat, agents, settings, proposals | — |
| Metrics (`/metrics`), observability | `log-events`, health | [health](health.md) |
| Disk hygiene, retention | none | no note yet |
| A developer agent that changes the platform | the steward, a proposal approved in the dashboard (SPEC §6) | [self-improvement](self-improvement.md) |

## How it fits pikit
- **Agents first** (built): [agent folders](agent-folders.md), the [skills catalog](completed/skills-catalog.md) and
  [channel context](channel-context.md) make each agent a folder, with what it may use named in it and
  what it knows next to it. The contract that tells channels apart is built.
- **Then the daily work**: [scheduler](scheduler.md) (routines and followups), [memory](memory.md),
  [approvals](approvals.md) (questions and decisions), [policy-tools](policy-tools.md). Each is a
  component on an existing contract or a new one with its suite (the contract rules of `AGENTS.md`).
- **Then the channels** the team is in: [channel-google-chat](channel-google-chat.md) (specified, the
  next one), and a task tracker as a channel of its own (comments in, comments out).
- **The business stays the user's**: its skills (ads platforms, spreadsheets…) are Agent Skills
  folders and move as they are; missions and their task-tracker projection are the user's components,
  built on the scheduler and the approvals.
- **Not a migration tool**: conversations, memories and routes of a running platform stay there.
  [import-from-openclaw-hermes](import-from-openclaw-hermes.md) is the nearest note, for prompts and
  skills.

## Contracts or components
Most of the map is components. A component may declare a contract of its own
(`declares.capabilities` in its `component.json`, `packages/cli/src/registry/capabilities.ts`), as
`scheduler` or `memory` would; and a tool, which cannot use `agent.runtime` (a cycle), reaches a
component that does through `actor.mailbox`, as [memory](memory.md) decides. What needs the kit's
contracts:

- **`InboundMessage.images`**: a channel's photos reach the model only through `admitInbound`, the
  kit's code. With [channel-google-chat](channel-google-chat.md).
- **`approvals`** (questions now and decisions in days, one contract): what is asked is shared by who
  asks, who draws it and who waits for the answer, three components that must not know each other.
  Questions (`askUser`, the `question` part) come with channel-google-chat; decisions
  that wait days stay approvals'.
- **`AgentDelegation`** (`@pikit/pi-adapter`): status, steer, cancel and the list of started tasks,
  for an orchestrator. Stitching `agent.runtime`, `agent.observe` and the mailbox together could do
  it, but `agent.observe` sees only its own Durable Object on Cloudflare.
- **Not threads**: a thread is the channel's, in its key ([threads](threads.md)).

Changes to components, not contracts: channels running `agent.command` (`runAgentCommand`) for a
team's commands (`/cancel`, `/status`, `/tasks`…); and a halt in `inbound.normalize` (a rate limit)
that the channel may explain or keep quiet about, where channel-telegram always says "I can't take
that message."

## Pi first
Skills, MCP and extensions are Pi's, so what agents built on Pi's coding agent use carries over.
pikit runs pi-durable, whose conversations survive a restart and run in a Durable Object on
Cloudflare.

## Open questions
- Rate limits and admission: an `inbound.normalize` stage (a halt with a reason) or a capability of
  their own.
- Missions: whether a goal ledger is a feature of the kit's or only the user's.
