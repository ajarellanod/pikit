---
name: pikit
description: Build on a pikit project or registry a component (a channel, a tool, a store, a router stage, a model provider, an admin route, a deployment, or a feature's own new kind), an agent extension (prompt sections, hooks on model requests and tool calls, per-conversation state), or a dashboard view or Settings section. Use when the user asks to add behaviour to their pikit assistant, build a feature from a design note in features/, make something others can `pikit add`, or see, operate or set something of it in the dashboard.
---

# Build on pikit

pikit is a kit for Pi: the kernel (`@pikit/core`) composes components, the contracts
(`@pikit/contracts`) are the words they share, and Pi (through `@pikit/pi-adapter`, the only door to
Pi) runs the agents. Everything else is a component: source copied into the project, which the user
owns. A component that follows its reference composes, survives crashes and evictions, and can be
shared.

**Where the kit is.** `{{PIKIT_ROOT}}` is the pikit repository (the kit) this project was made with,
on this machine; online, {{PIKIT_URL}}. Its design notes are in `features/`, its decisions (the
K, C and P names READMEs cite) in `SPEC.md`, its components in `registry/components/`. (`pikit new`
writes both when it copies this skill into a project; in the pikit repository itself, they are its
root.)

## 0. Know the project before you write

```sh
pikit doctor                    # the components in start order, who provides what, what is missing
pikit registry capabilities     # every capability: what it is for, its stability, who provides it
```

Read `pikit.config.ts` (everything that runs is listed there) and `pikit.json` (what was installed,
and the target: `server` is a long-lived process, `durable` an actor per conversation on Cloudflare).
Installed components are in `src/pikit/<name>/`, each with a README and its tests; the project's own
are in `src/extensions/`. If the feature has a design note (`{{PIKIT_ROOT}}/features/<feature>.md`),
read it first: it names the contract, what must be guaranteed and the tests that prove it
(`{{PIKIT_ROOT}}/features/memory.md` is a complete worked example, built as `memory-sql`,
`memory-recall` and `memory-summaries`).

## Then read the reference of what you write

The references are in this skill's folder, `references/`: read the one the change needs (and
`component.md` before `extension.md`: an extension is a component).

| The change | Read |
|---|---|
| A behaviour: a channel, a tool, a store, a pipeline stage, an HTTP or admin route, a model provider, a deployment, a slash command, or a capability and kind of your own | `references/component.md` |
| What the agent knows in every request (rules, a persona, memories), a check or rewrite of model requests or tool calls, state per conversation | `references/extension.md` |
| Something to see or operate in the dashboard (`src/dashboard/`), or a value an operator changes live (a section of its Settings dialog) | `references/view.md` |
| An agent's model, system prompt, tools, extensions or skills | none: `src/agents/<agent>/agent.ts` (`defineAgent`; a skill's text in its own `SKILL.md`, read with `defineSkill`) |
| Config values | none: `pikit.config.ts` |

Many features are more than one: a component with its own view (`references/view.md`, "Decide where
it lives"), or an extension whose section reads a store of its own (`memory`: `memory-sql`, a store
component, and `memory-recall`, its extension).

Done means what each reference's last section says, and always: `bun test` and `bun run typecheck`
pass, `pikit doctor` is green, and `pikit remove <name>` leaves the project as it was.
