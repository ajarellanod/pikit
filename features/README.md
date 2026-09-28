# Features

Everything `SPEC-CORE.md` does not require is a feature (SPEC-CORE §7), and each one has a file
here. Features have no order: one is built when a user needs it, contracts first, as a component
or a CLI command that stays removable (S3). A file says what the feature gives, how it fits
pikit, what Pi already does (rule zero), and what is still open; text moved out of `SPEC.md` is
kept in it verbatim. A feature may never require changing SPEC-CORE §1–§6: if one seems to, the
change is proposed there first. The contracts a feature needs are written in `SPEC.md` when it is
built; what is built is tracked in `ROADMAP.md` only.

**Legend.** ⭐ marks what makes OpenClaw or Hermes attractive to the public. It says what people
look for, not what comes first; matching them feature for feature is a non-goal (SPEC §1).

| Feature | ⭐ | One line | Needed by required work? |
|---|---|---|---|
| [approvals](approvals.md) | ⭐ | Decisions a person answers from the chat, days later, bound to the message that asks | Open: track S's approval may use it |
| [browser](browser.md) | ⭐ | A tool to read and act on web pages | No |
| [channel-discord](channel-discord.md) | ⭐ | A Discord bot, in DMs, channels and threads | No |
| [channel-email](channel-email.md) | ⭐ | An address for the agent; replies in the thread | No |
| [channel-slack](channel-slack.md) | ⭐ | A Slack app, by Events API or Socket Mode | No |
| [channel-whatsapp](channel-whatsapp.md) | ⭐ | WhatsApp, by the Cloud API or a linked device | No |
| [import-from-openclaw-hermes](import-from-openclaw-hermes.md) | ⭐ | `pikit import`: persona, skills, memories, channels from an existing setup | No |
| [learned-skills](learned-skills.md) | ⭐ | Skills the agent writes from experience, through the self-change gate | No; builds on track S |
| [mcp](mcp.md) | ⭐ | Tools of remote MCP servers for the agents that name them | No |
| [memory](memory.md) | ⭐ | Memory and user profiles across conversations and channels | No |
| [pairing](pairing.md) | ⭐ | Unknown senders approved by the owner from the chat | No |
| [rich-content](rich-content.md) | ⭐ | Images, files and buttons; the shape is decided in SPEC §5 | No |
| [sandboxed-execution](sandboxed-execution.md) | ⭐ | Commands in a container, VM or remote host | Partly: track S requires `execution-cloudflare-sandbox`, specified there |
| [scheduler](scheduler.md) | ⭐ | Scheduled prompts and file-defined routines, answered in the chat | No |
| [skills-hub](skills-hub.md) | ⭐ | Install shared skills as owned source | No |
| [streaming-replies](streaming-replies.md) | ⭐ | A preview message edited as the answer is written | No |
| [subagents](subagents.md) | ⭐ | Delegation to helpers (Pi's) and to other agents (pikit's) | No |
| [voice](voice.md) | ⭐ | Voice notes in, transcribed; voice notes out | No |
| [channel-google-chat](channel-google-chat.md) | | Google Chat by webhook, an agent per space | No; ROADMAP M2 places it next |
| [cloudflare-conversation-index](cloudflare-conversation-index.md) | | A global list of conversations on Cloudflare | Open: track D and resuming on Cloudflare |
| [config-files](config-files.md) | | YAML values and profiles, read by the CLI | No |
| [deployment-systemd](deployment-systemd.md) | | Run as a systemd service, without Docker | No |
| [health](health.md) | | Components report failures; essential ones restart the process | Yes: tracks D and S, M2 |
| [inbound-dedup](inbound-dedup.md) | | Transport deduplication for platforms that redeliver | No; the first webhook channel |
| [interaction](interaction.md) | | Pi extensions' questions answered in the chat | No |
| [multi-tenant-isolation](multi-tenant-isolation.md) | | Tenants that cannot reach each other | No |
| [open-registries](open-registries.md) | | Git, HTTP and private registries, and a gallery | Partly: M3's `upgrade` reads Git registries |
| [pipeline-anchors](pipeline-anchors.md) | | The planned pipelines, and `agent.state` outside a run | No |
| [policy-tools](policy-tools.md) | | Tool rules by role, in one place | No |
| [replicas](replicas.md) | | Several server processes, one owner per conversation | No |
| [second-agent-runtime](second-agent-runtime.md) | | Another agent loop behind `AgentRuntime` | No |
| [slash-commands](slash-commands.md) | | Pi extensions' commands from a chat | No |
| [storage-postgres](storage-postgres.md) | | Postgres behind `storage.sql` and `sessions.store` | Yes: M3's swap proof (scenario 4) |
| [threads](threads.md) | | Platform threads as conversations; replies in their thread | No |
| [workspace-snapshots](workspace-snapshots.md) | | Workspaces in git or snapshots, restored with their conversation | Open: track S's git workspace |

Other channels (Signal, iMessage, Matrix, Home Assistant…) get a file when someone needs one.

## Completed

Features already built, one file each in [`completed/`](completed/): what was built, its contract,
how it fits pikit, what Pi already does, where the code and its tests are, and what is still open.

| Feature | One line |
|---|---|
| [storage-kv](completed/storage-kv.md) | `storage.kv`: small JSON values per component, by key; `storage-kv-sql` provides it, `channel-telegram` keeps its cursor there |
| [tool-component](completed/tool-component.md) | `toolComponent`: a tool in the shape of Pi's `defineTool` as a component providing `agent.tool`, with its `replay` |
