<p align="center"><img src="assets/banner.svg" alt="Pikit: Pi as a service. Built from parts you own." width="100%"></p>

# pikit

A kit to run the [Pi](https://github.com/earendil-works/pi) agent as a durable, multi-agent service:
reachable from your chats and products, remembering conversations, delivering replies reliably. Pi
is the agent; pikit is everything Pi needs to run as a service in the cloud, and nothing Pi already
does. Like shadcn/ui, it is a small core plus a registry of components copied into your project as
source you own: channels, routing, storage, delivery, deployment on a server (Docker) or on
Cloudflare (a Durable Object per conversation). You build the assistant you need on those bases,
with your AI, one component at a time. Unreleased: nothing is published to npm yet.

## Five minutes

```sh
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh                  # then `pikit new`, guided
curl -fsSL https://raw.githubusercontent.com/ajarellanod/pikit/main/installer/install.sh | sh -s -- --durable   # a Telegram bot on Cloudflare
```

The installer puts the CLI in `~/.pikit/bin/pikit` (a checkout in `~/.pikit/pikit`) and runs
`pikit new`, which asks where the agent runs, where you talk to it (Telegram, HTTP, or both) and
what it can do (a dashboard, routing rules, MCP tools, web search…), then configures and starts it
([installer/README.md](installer/README.md)). By hand, in a project:

```sh
pikit new my-agent --preset telegram         # or http; --target durable --preset telegram-cloudflare
                                             # --with channel-telegram --with channel-http: both; --with tool-mcp, --ui: features
cd my-agent
pikit configure                              # secrets and the model login
pikit dev                                    # run it here; `pikit up` deploys (Docker or Cloudflare)
pikit add <component>...                     # and remove, upgrade, doctor, logs: `pikit --help`
```

## The repository

| Path | What |
|---|---|
| `packages/core` | `@pikit/core`: the kernel (events, pipelines, capabilities, lifecycle); `typebox` only |
| `packages/contracts` | `@pikit/contracts`: the capabilities components agree on, the delivery helpers, and their conformance suites (`/testing`) |
| `packages/pi-adapter` | `@pikit/pi-adapter`: the only package that imports Pi (pi-durable, pi-ai, pi-mcp) |
| `packages/cli` | the `pikit` CLI: `new`, `add`, `remove`, `upgrade`, `doctor`, `configure`, `dev`, `up`… |
| `registry/` | the components (`components/<name>/`), presets, schemas and the dashboard template |
| `templates/` | "Deploy to Cloudflare" templates, made from `pikit new` |
| `samples/http` | a fixture: an agent over HTTP composed straight from `registry/`, with its scenario tests |
| `tests/workerd` | the Cloudflare components' suites inside workerd, on a real Durable Object |
| `installer/` | `install.sh` and its tests |
| `features/` | a design note per feature, built (`completed/`) or not; kit follow-ups |
| `docs/` | upstream proposals to Pi (`docs/upstream/`), architecture audits |
| `.agents/skills/` | skills for AI agents (`pikit-component`, `pikit-view`, `pikit-extension`), copied into every project |

## Read next

- [docs/README.md](docs/README.md): how pikit works: concepts, components, contracts, pipelines, a
  message end to end, targets, the CLI, the dashboard.
- [MANIFESTO.md](MANIFESTO.md): what pikit is for, and its principles.
- [SPEC.md](SPEC.md): what must hold (the kernel, contracts, targets, the CLI).
- [features/README.md](features/README.md): every feature, one note each, and how they are built.
- [features/building-components.md](features/building-components.md): how a component is made.
- [.agents/skills/pikit-component/SKILL.md](.agents/skills/pikit-component/SKILL.md): the same, as
  steps for an AI agent.
- [CHANGELOG.md](CHANGELOG.md): the current state, by area. [AGENTS.md](AGENTS.md): lessons for agents
  working on this repository.

## Tests

Bun >= 1.4; Node >= 22 for the workerd lane.

```sh
bun install
bun run typecheck                 # tsc over the workspace
bun test                          # every package, component, sample and script
bun run test:workerd              # the Cloudflare suites inside workerd (offline)
bun run registry validate         # every component, preset and schema
```
