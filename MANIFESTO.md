# The pikit Manifesto

**Your own agent harness, in the cloud, made of parts you own.**

pikit runs your AI agents as a service: reachable from your chats and products, remembering
conversations, delivering replies reliably, acting on a schedule, asking a human when it
must. It is the base for assistants like OpenClaw and Hermes, not another one of them: it
gives you a durable, moldable foundation (the core, the contracts, channels, deployment, the
installer and a base dashboard) running on your own infrastructure in minutes, and you build
the assistant you need on it, with your AI, one component at a time. What you are left with is
a project you can reshape, not a product you have to configure.

**Pi is the agent. pikit is the kit.** As its name says, pikit is a kit for Pi: everything Pi
needs to run as a robust, multi-agent service in the cloud, and nothing Pi already does.
It is not a coding agent and does not compete with Pi, Claude Code or Codex.

This repository is the idea made real. If the code and this text disagree, one of them is
wrong, and we fix whichever it is.

---

## The principles

### 1. Pi is the agent. pikit is the kit.

Pi is our agent. Through its durable runtime it owns the loop, the models, durability and
resume, compaction, retries, steering, its inbox, subagents, tasks and its conversations. We
never build agent behavior. Before we build anything for the agent, we check
whether Pi already does it:

- If Pi does it, we use it.
- If Pi almost does it, we improve it upstream.
- We only build what one Pi process cannot give itself: channels, routing between agents,
  ownership across machines, reliable delivery, scheduling, approvals, deployment, and the CLI
  that gets you there.

When Pi learns something we built, we delete ours. That is what makes pikit a kit and not a
framework: Pi runs the agent, and the kit is yours, piece by piece.

### 2. Conversations are actors. Machines are workers.

A conversation has an identity, a durable state (its Pi conversation) and a mailbox (Pi's inbox).
A worker is wherever the conversation's steps happen to run: a process, a Durable Object.
Any worker can pick up any conversation, and only one at a time. Losing a worker loses
nothing, and an idle conversation costs nothing but storage.

### 3. A firm core, not a big one.

The core is the language the parts speak: events, pipelines, capabilities, lifecycle. Nothing
else. It does not know what Telegram or SQLite is, and it schedules nothing. Its strength is
in what it refuses to include.

### 4. Everything else is source you own.

Anything that is not core is a component, and components are copied into your project as
source. You read them, edit them and delete them. No black box sits between you and the
behavior of your own system.

### 5. If you don't need it, it doesn't exist.

Nothing is disabled or hidden behind a flag or left loaded but idle: what you did not install
is absent. It has no table, timer, config key, dependency or import. A feature you do not use
costs nothing.

### 6. Contracts are the only coupling.

Parts talk through typed events, pipelines and named capabilities, never by reaching into
each other's files. Replacing one part never requires touching another. That is the test
that shows the design is honest.

### 7. Add, edit, remove: all first-class.

Add a component to gain a capability, edit it to make it yours, and remove it to be left
with a clean, working project. We measure simplicity by how much you can remove without the
rest noticing.

### 8. Values in config, behavior in code.

Configuration holds ports, tokens and model names. Behavior lives in components and code you
own. When a config key starts choosing between strategies, those strategies should be
components.

### 9. No magic.

pikit has no directives, no hooks with hidden context, no compiler transforms and no
mandatory build plugins. It never registers anything as a side effect of an import. Open
`pikit.config.ts` and follow the imports: that is everything that runs.

### 10. Fail loudly. Recover honestly.

A harness is a service, and a service that half-works is worse than one that stops. If a
part fails to start, the harness does not start. We never fall back silently to a
best-effort substitute. Delivery guarantees are stated, never implied: at-least-once, with
idempotency keys for anything with an effect. A restart, eviction or retry never loses a
conversation and never pretends a message was answered.

### 11. Run where you want.

The same agents, routing and contracts run on a single server, in Docker, or on Cloudflare
Durable Objects. This is not a feature. It is the proof that the contracts are real, because a
system that runs in only one place has hidden dependencies it has not admitted to.

We say exactly how far it goes. A project is made for one runtime model (`pikit new --target`): a
long-lived process, or an actor per conversation. Most components run on both. The few that touch
how code lives come in one per model, and their manifest says so: Telegram by long polling on a
server and by webhook on Cloudflare, local execution on a server and execution inside the object on
Cloudflare. Moving a project is swapping those few, never rewriting an agent, a route or a
contract.

### 12. Five minutes, then it's yours.

Ownership is no excuse for a slow start. One command takes you from an empty server to a
running, reachable agent: the CLI and the installer exist so that nothing stands between
installing pikit and an agent that answers. Presets are shortcuts, never modes: everything they install can be
edited or removed like anything else.

### 13. Built to be built on.

pikit gives the bases; the assistant is yours to build. So building on it must be easy for a
person and for the AI working with them: every contract has a conformance suite that says
whether a new component is right (the few still missing are listed, in
`features/building-components.md`, until they are written), every feature has a design note that says how to build it,
the repository carries skills that teach an agent to write a channel, a tool, a store or a
dashboard view, and durability comes with the contracts, so a component never has to think
about crashes. What one user builds, others can install from that user's own registry.

### 14. Boring on purpose.

The model you learn for 1.0 is the model for all of 1.x. The harness is the part of your
system you least want to rewrite, so pikit will never make you rewrite it. Excitement belongs
in components, which you upgrade when you decide to.

---

## What pikit is not

- **Not a second agent.** Pi is the agent. pikit is the kit that runs it as a service.
- **Not a finished product.** It does not chase OpenClaw's or Hermes' feature lists: a user
  who wants an assistant of that size builds or installs the components for the features they
  need on pikit's bases, and nobody carries all of them. pikit matches their time to a first
  running agent and then gets out of your way.
- **Not a framework that owns your application.** Your project owns pikit, not the other way
  around.
- **Not a plugin marketplace.** Registries distribute source. Nothing is loaded dynamically
  in production, and code is never hot-reloaded: a reload is a restart, and a restart loses
  nothing.

## Who it is for

People who build systems and want to keep understanding them: developers, agencies, and
platform teams who looked at a large agent platform and thought, *"I only need a third of
this, and I need that third to behave differently."*

---

We lay the bases. You build your assistant. Install only what you need. Own every behavior.
