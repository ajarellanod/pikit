# The pikit Manifesto

**Your own agent harness, in the cloud, made of parts you own.**

pikit runs your AI agents as a service: reachable from your chats and products, remembering
conversations, delivering replies reliably, acting on a schedule, asking a human when it
must. It is the moldable alternative to OpenClaw and Hermes: you get to the same place, a
running agent on your own infrastructure in minutes, but what you are left with is a project
you can reshape, not a product you have to configure.

**Pi is the agent. pikit is the kit.** As its name says, pikit is a kit for Pi: everything Pi
needs to run as a robust, multi-agent service in the cloud, and nothing Pi already does.
It is not a coding agent and does not compete with Pi, Claude Code or Codex.

This repository is the idea made real. If the code and this text disagree, one of them is
wrong, and we fix whichever it is.

---

## The principles

### 1. Pi is the agent. pikit is the kit.

Pi is our agent. It owns the loop, the models, compaction, retries, steering, its queues and
its sessions. We never build agent behavior. Before we build anything for the agent, we check
whether Pi already does it:

- If Pi does it, we use it.
- If Pi almost does it, we improve it upstream.
- We only build what one Pi process cannot give itself: channels, routing between agents,
  ownership across machines, reliable delivery, scheduling, approvals and deployment.

When Pi learns something we built, we delete ours. The kit is yours, piece by piece.

### 2. Conversations are actors. Machines are workers.

A conversation has an identity, a durable state (its Pi session) and a mailbox (Pi's inbox).
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

The same project runs on a single server, in Docker, or on Cloudflare Durable Objects. This
is not a feature. It is the proof that the contracts are real, because a system that runs in
only one place has hidden dependencies it has not admitted to.

### 12. Five minutes, then it's yours.

Ownership is no excuse for a slow start. One command takes you from an empty server to a
running, reachable agent. Presets are shortcuts, never modes: everything they install can be
edited or removed like anything else.

### 13. Boring on purpose.

The model you learn for 1.0 is the model for all of 1.x. The harness is the part of your
system you least want to rewrite, so pikit will never make you rewrite it. Excitement belongs
in components, which you upgrade when you decide to.

---

## What pikit is not

- **Not a second agent.** Pi is the agent. pikit is the kit that runs it as a service.
- **Not a finished product.** It will not match OpenClaw or Hermes feature for feature. It
  matches their time to a first running agent and then gets out of your way.
- **Not a framework that owns your application.** Your project owns pikit, not the other way
  around.
- **Not a plugin marketplace.** Registries distribute source. Nothing is loaded dynamically
  in production.

## Who it is for

People who build systems and want to keep understanding them: developers, agencies, and
platform teams who looked at a large agent platform and thought, *"I only need a third of
this, and I need that third to behave differently."*

---

Build your own harness. Install only what you need. Own every behavior.
