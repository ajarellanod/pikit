# The pikit Manifesto

## Software should be moldable

Most software is delivered as a finished shape. You configure it, you extend it through the
holes its authors left for you, and when your needs outgrow those holes you fork it or leave.

We think infrastructure for AI agents should work differently. An agent harness is not a
product you install; it is a system you grow. It should start small, fit your hand, and change
shape as your needs change — without a fight.

This is what we mean by **moldable software**: a firm core, honest contracts, and everything
else owned by you.

## Principles

### 1. A firm core, not a big one

The core is the part everyone depends on, so it must be small, stable, boring, and
well-reasoned. It defines the *language* components use to talk to each other — events,
pipelines, capabilities, lifecycle — and nothing more.

The core does not know what a Telegram channel is. It does not know what SQLite is. It does
not schedule anything. It does not ship a scheduler "just in case". Strength comes from what
it refuses to include.

Firm also means firm over time. The model you learn for 1.0 is the model for all of 1.x.
We would rather ship a small thing that stays the same than a large thing that gets
rewritten. A harness is the part of your system you least want to rewrite; ours should
never make you.

### 2. Everything else is yours

Anything that is not core is a component, and components are installed as source into your
project. You read the code. You edit the code. You delete the code. There is no
`node_modules/` layer between you and the behavior of your own system.

A component is not a plugin that runs inside someone else's box. It is code that becomes part
of your box.

### 3. If you don't need it, it doesn't exist

Not "disabled". Not "behind a flag". Not "loaded but idle". Absent.

A harness that does not install a scheduler has no scheduler tables, no scheduler timers, no
scheduler config keys, no scheduler dependencies. The cost of a feature you do not use must be
zero — in code, in memory, in attack surface, and in the number of things you have to
understand.

### 4. Contracts are stable; implementations are replaceable

Components talk to each other only through typed events and named capabilities. The contract
is the only thing that must stay compatible over time. The implementation behind it is free
to be swapped: SQLite for Postgres, local shell for a remote container, Bun on a VPS for a
Cloudflare Durable Object.

Replacing one component must never require touching another. This is the main test of
whether the design is honest.

### 5. Grow by adding, shape by editing, simplify by removing

Three operations, all first-class:

- **Add** a component to gain a capability.
- **Edit** the installed source to make it behave the way *you* need.
- **Remove** a component when you no longer need it, and be left with a clean project.

If any of these is painful, something is wrong with the design.

### 6. The core is editable too

"Firm" does not mean "sacred". The core is also source. If you truly need to change it, you
can — and the project should make that possible without turning into a fork you can never
reconcile. But changing the core should be rare, deliberate, and visible. When you find
yourself needing to, that is a signal to either re-examine your problem or send the change
upstream.

### 7. Composition over configuration

Behavior that varies should be expressed as code you own, not as ever-growing YAML with a
hundred keys. Configuration is for values — ports, tokens, model names. Behavior is for
components and extensions.

### 8. No magic

Code you own is only useful if you can read it. pikit has no directives, no compiler
transforms, no hooks with hidden context, no build plugin you must adopt, no lifecycle you
cannot trace by reading `pikit.config.ts` and following imports. A component is a plain
TypeScript module that registers plain functions. What runs is what you see.

This is the same instinct that shaped Pi: a minimal, explicit tool that you can extend with
ordinary files rather than a framework that reinterprets your code. "React for agents" is a
legitimate design; it is not this one.

### 9. Build on what exists; don't reinvent the loop

pikit does not implement an agent loop. Pi already does that extremely well, with a runtime
that has been designed to be neutral about where it runs and how it persists. pikit builds the
harness around it: channels, routing, sessions, delivery, scheduling, approvals, deployment.

We prefer standing on one deliberately chosen foundation over abstracting every foundation.

### 10. Run where you want

The same project must be able to run on a single server, in Docker, or as serverless Durable
Objects at the edge. This is not a feature; it is the proof that the contracts are real. A
system that only runs in one place has hidden dependencies it has not admitted to.

### 11. Fast to start, yours to keep

Ownership is not an excuse for a slow start. A preset must take you from an empty server to
a running, reachable agent in minutes — the onboarding of a finished product. The difference
is what you are left with afterwards: not a black box to configure, but a project to
reshape. Presets are shortcuts, never modes; everything they install can be edited or
removed like anything else.

### 12. Simplicity is measured by what you can remove

We do not measure the project by how many things it can do. We measure it by how much a user
can remove, replace, or rewrite without the rest of the system noticing.

The best compliment pikit can receive is: *"I deleted half of it and everything still
worked."*

## What we are not

- We are not a complete assistant product. If you want something that works out of the box
  with every channel and every feature, use OpenClaw or Hermes. They are excellent.
- We are not a plugin marketplace. Registries exist to *distribute source*, not to run code
  on your behalf.
- We are not a framework that owns your application. Your project owns pikit, not the other
  way around.

## Who this is for

People who build systems and want to keep understanding them. Developers, agencies, platform
teams, and anyone who has looked at a large agent platform and thought: *I only need a third
of this, and I need that third to behave differently.*

---

Build your own harness. Install only what you need. Own every behavior.
