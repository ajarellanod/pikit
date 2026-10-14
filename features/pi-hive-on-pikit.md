# pi-hive on pikit: a team of work agents built on the bases

**Public appeal:** — (an operator's team of agents: a trader, a designer, a developer, an
orchestrator, each with its own skills, tools and permissions, in the chats a company already uses)

**Specified:** no. A map, not one component: which of pi-hive's pieces the bases already give, which
have a design note, and which have none yet. pi-hive is the user's single-process platform on Pi
(Bun, YAML config, SQLite): `config/agents.yaml`, `agents/<name>/`, `config/agent-roles.yaml`,
`config/routes.yaml`, `src/`.

**Needed by:** nothing required. It orders the notes it links, for a user who builds this.

## What it gives
pi-hive's work, on bases that are durable (a run survives a restart), deploy to a server or to
Cloudflare, change themselves through a reviewed proposal (SPEC §6), and come with conformance suites.
What pi-hive configures in YAML becomes components a project installs and agents that name what they
may use.

## The map

| pi-hive | pikit today | Where it goes |
|---|---|---|
| Agents in `agents.yaml`, `agents/<name>/` by convention (prompt, skills, extensions, context) | `defineAgent` per agent (allow-lists of tools and extensions), agents-live for the dashboard's | [agent folders](agent-folders.md) |
| Skills per agent (symlinks into a shared `.agents/skills/`) | built: the project's catalog (`agent.skill`), each agent names its skills, live agents and overrides too | [skills catalog](completed/skills-catalog.md); filled from folders: [agent folders](agent-folders.md) |
| `tools` / `builtin_tools` per agent | built: an agent has the tools it names (`tool-*`, `tool-mcp`) | — |
| Roles: bash and path rules (`agent-roles.yaml`) | `extension-house-rules` (tools by name, by sender) | [policy-tools](policy-tools.md) |
| `isolated_workspace` per space, `context/` copied in | `workspace-local`, a directory per agent; `ConversationRef.channel` built | [channel context](channel-context.md), [agent folders](agent-folders.md) |
| Channels: Google Chat, HTTP API, Telegram, ClickUp | channel-http, channel-telegram (polling and webhook) | [channel-google-chat](channel-google-chat.md); ClickUp has no note |
| Routes (`routes.yaml`, stored routes) | router-basic, router-rules (Routing in the dashboard) | — |
| Idempotency, per-conversation serialization | built: request ids deduplicated by the runtime, one owner per conversation | [inbound-dedup](inbound-dedup.md) for transports |
| Rate limits, admission control | none | no note yet |
| Slash commands, `/prompt` templates | `/new` in the channels; Pi extensions' commands not | [slash-commands](slash-commands.md) |
| Delegation (`request_task`), background tasks | `tool-delegate`: run or start, depth limit, answers to the parent | [subagents](subagents.md) |
| Decision gateway (proposals, supervision, auto-approve with a veto window) | the self-change gate only (SPEC §6) | [approvals](approvals.md) |
| Missions (goal ledger, checkpoints, ClickUp projection) | none | no note yet |
| Memory: summaries, search, rules, preferences | none | [memory](memory.md) |
| Routines (cron), followups (one-shot, agent-made) | `wakeups-timers` (the runtime's own) | [scheduler](scheduler.md) |
| Reply context (a terse reply to a routine's message) | none | with [scheduler](scheduler.md) |
| `js_exec` (a persistent JavaScript worker) | none | [codemode](codemode.md) |
| MCP servers per agent | `tool-mcp` | — |
| Browser (cloud sessions) | none | [browser](browser.md) |
| Attachments, assets, size limits | images in `AgentRequest` | [rich-content](rich-content.md) |
| Durable outbound delivery | `outbound-durable`, `startAnswerDelivery` | — |
| Model fallback, provider account failover | Pi's retries with backoff | no note yet |
| Dashboard, monitor | the dashboard (`src/dashboard/`, admin-api): chat, agents, settings, proposals | — |
| Metrics (`/metrics`), observability | `log-events`, health | [health](health.md) |
| Disk hygiene, retention | none | no note yet |
| A developer agent that changes the platform | the steward, a proposal approved in the dashboard (SPEC §6) | [self-improvement](self-improvement.md) |

## How it fits pikit
- **Agents first**: [agent folders](agent-folders.md), the [skills catalog](completed/skills-catalog.md) (built) and
  [channel context](channel-context.md) make pi-hive's agents expressible: each agent a folder, what it
  may use named in it, what it knows next to it. The contract that tells channels apart is built.
- **Then the daily work**: [scheduler](scheduler.md) (routines and followups), [memory](memory.md),
  [approvals](approvals.md) (the decision gateway's core), [policy-tools](policy-tools.md). Each is a
  component on an existing contract or a new one with its suite (the contract rules of `AGENTS.md`).
- **Then the channels** pi-hive's users are in: [channel-google-chat](channel-google-chat.md), and
  ClickUp as a channel of its own (comments in, comments out).
- **pi-hive's business stays the user's**: its skills (DV360, Google Ads, Sheets…) are Agent Skills
  folders and move as they are; missions and its ClickUp projection are the user's components, built on
  the scheduler and the approvals.
- **Not a migration tool**: conversations, memories and routes of a running pi-hive stay there.
  [import-from-openclaw-hermes](import-from-openclaw-hermes.md) is the nearest note, for prompts and skills.

## Pi first
Both are built on Pi. pi-hive drives Pi's coding agent in sessions; pikit runs pi-durable, whose
conversations survive a restart and run in a Durable Object on Cloudflare. Skills, MCP and
extensions are Pi's in both, so what pi-hive's agents use carries over.

## Open questions
- Model fallback across providers: a runtime option (`AgentDefinition.fallback`), a model provider
  that wraps others, or Pi's own once it has one.
- Rate limits and admission: an `inbound.normalize` stage (a halt with a reason) or a capability of
  their own.
- Missions: whether a goal ledger is a feature of the kit's or only the user's.
