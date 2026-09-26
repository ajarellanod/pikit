# pikit — The Idea

> A source-owned toolkit for building your own agent harness on top of Pi.
> Install only what you need. Own every behavior. Run on a server or at the edge.

## The problem

There are two ways to get an AI agent running in your chat, your workflows, or your product
today:

1. **Adopt a platform** (OpenClaw, Hermes Agent). You get a complete assistant: channels,
   memory, scheduling, plugins, dashboards. You also get the platform's architecture, its
   opinions, its config format, its process model, and its roadmap. Customizing behavior
   beyond the plugin surface means forking a very large codebase.

2. **Build from a loop** (Pi, OpenAI Agents SDK). You get an excellent agent core and nothing
   else. Channels, routing, sessions, durable delivery, scheduling, approvals, deployment —
   you write all of it, again, for every project.

Nothing sits in the middle: a way to *assemble* a harness out of well-built pieces, keep only
the pieces you need, and own the code of every piece so you can shape it.

That gap is what pikit fills.

## The idea in one sentence

**pikit is to agent infrastructure what shadcn/ui is to UI components: a small, stable core
plus a registry of components you copy into your project and own.**

## Two philosophies combined

### From Pi: moldable software

Pi's agent runtime is built around a lifecycle of typed events that extensions can observe,
intercept, and transform. Almost nothing is hard-wired; almost everything is reachable. Pi has
also been separating its core from Node — abstract execution environment, pluggable session
storage, transport-neutral protocol — so the same loop can run in different places.

pikit extends that philosophy from the *agent loop* to the *whole harness around it*. The
lifecycle of a message entering a channel, being routed, running through an agent, and being
delivered back is modeled as the same kind of observable, interceptable event stream.

### From shadcn/ui: installable by parts, owned by you

shadcn/ui proved that developers prefer copying well-written source into their project over
depending on a black-box library — as long as the pieces are small, consistent, and built on a
shared foundation.

pikit applies the same distribution model to infrastructure. `pikit add channel-telegram`
does not add a dependency; it adds files to `src/pikit/channel-telegram/` that you can read,
edit, and delete.

## What you get

```bash
curl -fsSL https://get.pikit.dev | sh
pikit new my-agent --preset telegram
cd my-agent
pikit configure
pikit up
```

Five minutes to a running agent on a VPS. This is deliberate and it is a differentiator:
the onboarding of a product (OpenClaw, Hermes) with the ownership of a kit. Frameworks like
Flue leave you with a Vite project and a deployment to figure out; pikit leaves you with a
running service, and *then* lets you reshape it. And every behavior — how messages are
routed, how sessions are stored, how replies are delivered, what gets approved — lives in
your repository as code you own.

Then, as needs grow:

```bash
pikit add outbound-durable        # reliable delivery with retries
pikit add scheduler             # cron-style routines
pikit add approvals             # human-in-the-loop decisions
pikit add sessions-postgres     # swap SQLite for Postgres
pikit remove sessions-sqlite    # and nothing else changes
```

And when the shape changes entirely:

```bash
pikit add deployment-cloudflare
pikit add sessions-cloudflare-do
pikit deploy --profile cloudflare
```

Same agents, same routing, same channels. Different infrastructure underneath.

## What pikit is

- **A tiny core** (`@pikit/core`): typed events, ordered pipelines, named capabilities,
  component lifecycle, configuration, diagnostics. Nothing domain-specific.
- **A Pi adapter**: the bridge between pikit's harness lifecycle and Pi's agent runtime
  (`AgentHarness`, `ExecutionEnv`, `SessionStorage`).
- **A registry of components**: channels, routers, session stores, outboxes, schedulers,
  approval engines, executors, workspaces, deployment targets. Each one is source you copy.
- **A CLI**: `new`, `add`, `remove`, `diff`, `upgrade`, `doctor`, `up`, `deploy`.
- **Two first-class runtimes**: a long-running server (Bun/Node, Docker, systemd) and
  serverless Cloudflare Workers + Durable Objects (optionally with Containers for shell
  access).

## What pikit is not

- Not a coding agent. It does not compete with Pi, Claude Code or Codex; it uses Pi as its
  engine and runs agents as a service.
- Not a complete assistant. It does not try to match OpenClaw's or Hermes' feature lists —
  but it does match their *time to first running agent*.
- Not a new agent loop. Pi is the runtime.
- Not a plugin system. Components are installed at development time and compiled into the
  deployment; nothing is loaded dynamically in production.
- Not a hosted service. Registries are Git repositories or static files.

## Why now

- Pi has reached the point where its core is runtime-neutral: `pi-agent-core` has no Node
  imports at its root, `ExecutionEnv` abstracts filesystem and shell, `SessionStorage` is a
  pluggable interface with a published conformance suite, and `pi-protocol` / `pi-client`
  are transport-neutral. The foundation for "run anywhere" exists.
- Cloudflare Durable Objects provide exactly the primitive an agent session needs: a single-
  threaded, globally addressable object with its own SQLite, alarms, hibernating WebSockets,
  and an optional attached Container.
- The platform space is consolidating around large, opinionated products. The demand for
  something smaller and more malleable is real and currently unmet: AgentCN distributes
  agent *recipes* shadcn-style but no infrastructure; Eve is a filesystem-convention
  framework with a workflow engine at its center; OpenClaw and Hermes are products; Flue
  is built on Pi too, but owns the harness and has chosen a "React for agents" model (see
  below).

## Positioning against Flue

[Flue](https://github.com/withastro/flue) is the closest existing project and deserves a
direct answer. It is built on `@earendil-works/pi-agent-core`, targets Node and Cloudflare,
ships channels, persistence adapters, sandboxes, durability, and a blueprint mechanism that
generates versioned integration files into the user's project. Much of what pikit describes,
Flue already does well.

The difference is not a feature list. It is two decisions Flue made and pikit makes the
other way:

**1. Who owns the center.** In Flue, `@flue/runtime` owns the loop, sessions, dispatch,
durability, routing, and the HTTP server; you own agents, channel wiring, tools, and
adapters — the edges. Flue 2 showed what that means in practice: the programming model was
replaced (`defineAgent` and `defineWorkflow` removed, CLI build commands removed) in a major
release, and every project migrated on Flue's schedule. In pikit, the center is a small
core of events, pipelines, and capabilities; the harness pieces — router, session store,
outbox, scheduler, approvals, channel ingress — are source in your repository. When the
model of one of them needs to change, you change it.

**2. Magic or not.** Flue 2 is explicitly "React for agents": a `'use agent'` directive, hooks
with implicit context (`useModel`, `usePersistentState`, `useAgentStart`), a mandatory Vite
plugin, agents as functions that re-run. That is a coherent design with real strengths.
pikit takes Pi's opposite instinct: plain modules, explicit composition, an event stream you
can read, nothing a compiler has to reinterpret. Pi coexists with Claude Code, Codex, and
OpenCode on the strength of that instinct alone; pikit bets the same holds for harnesses.

Flue's own release note says: *"Flue deletes its own surface wherever the ecosystem already
has a better one — Vite owns build, Hono owns routing, Pi owns providers."* pikit agrees and
goes one step further: Pi owns the loop, and you own the harness.

In one line: pikit continues the explicit, declarative spirit of Flue 1 (`defineAgent` you
can read top to bottom), keeps what Flue 2 got right (agents must be dynamic; workflows are
state, not graphs; delete your own surface), rejects the hooks mechanism, and adds two
things Flue never set out to do: a five-minute deployment path and a stability promise.

What pikit should borrow from Flue rather than reinvent: versioned markers in generated files
with a cumulative upgrade guide, and contract test suites shipped for storage adapters.

## Stable on purpose

A harness is the part of your system you least want to rewrite. pikit commits to a
programming model that does not change within a major version: additive evolution, real
deprecation periods, rare majors with migrations. The core is small precisely so that it can
afford to be boring. Excitement belongs in the components — which are yours, and which you
upgrade when you decide. See `SPEC.md` §12a.

## Who it's for

- Developers who want an agent in their chat, product, or workflow and want to understand
  every line of how it behaves.
- Agencies and platform teams that run the same harness for many clients with client-specific
  routing, permissions, and integrations, and need to modify internals without forking a
  platform.
- Companies that maintain private component registries: their auth, their observability,
  their approval policies, reused across every internal agent.
- Anyone who has looked at a large agent platform and thought: *I need a third of this, and I
  need that third to behave differently.*

## What's ours

The problem is new and nobody has the answer yet, so the useful thing is to put specific
ideas on the table and see which ones hold. These are pikit's:

1. **Five minutes, then it's yours.** Product-grade onboarding that leaves you with a
   source-owned project, not a black box.
2. **Pi owns the loop; you own the harness.** A core reduced to events, pipelines, and
   capabilities; every harness piece is a component you copy.
3. **Absence, not flags.** What you did not install does not exist — no tables, timers,
   config keys, or imports.
4. **Dynamic agents without hooks.** `prepare(state) → TurnConfig`: the power of a
   re-executed agent function, with an explicit input, output, and moment — and a per-turn
   record in the transcript of what the agent actually had.
5. **Workflows are state, not graphs.** No DSL; `state.phase` plus conditional tools plus
   durability.
6. **Deterministic add/remove, LLM only for conflicts.** Hashes in `pikit.json`, three-way
   diffs, clean hunks applied by the CLI, and Pi as the merge tool of last resort.
7. **Open registries.** Official, private (Git over SSH), and local registries are equal
   citizens; any kind of component, not a fixed list.
8. **Operational components from production.** Approvals with delivery-time binding to the
   surface where a human can answer, outbox with real delivery semantics, file-defined
   routines, session continuity that survives eviction, role-based tool policy.
9. **A stability promise.** The 1.x model does not get rewritten. Boring on purpose.

If some of these turn out to be right, others will adopt them — Flue included — and that is
a fine outcome. If some turn out to be wrong, we will have learned it cheaply. pikit is a
small competitor by design: guided by what Flue and the larger platforms get right, and
free to disagree where we think they got it wrong.

## The bet

The bet is that **malleability beats completeness** for a meaningful set of technical users,
and that the shadcn model — small stable core + copied source + a good CLI for diffs and
upgrades — makes malleability practical for infrastructure, not just UI.

The known risk is that infrastructure changes faster than UI, so copied code rots. pikit
takes that seriously: the CLI tracks installed versions and hashes, shows upstream diffs,
and can apply safe upgrades or hand a three-way merge to Pi itself.

And it is a project, not a company. Being wrong is allowed.

## Where the ideas come from

pikit is informed by building and operating a multi-agent chat platform in production for
over a year: tenant-per-chat-space routing, a deterministic decision lifecycle with
delivery-time approval binding, durable outbound delivery, long-lived session continuity,
role-based tool gating, file-defined routines. Those subsystems worked. What did not work was
having them fused into one monolith that could not be reshaped. pikit is the reshaping.

## Name

**pikit** — a kit for Pi. Pi is the agent; pikit is the kit that lets Pi run as a robust,
multi-agent service in the cloud, and nothing Pi already does. A set of parts you assemble,
not a machine you buy.

## Next steps

See `MANIFESTO.md` for the principles, `SPEC.md` for the technical specification, and
`ROADMAP.md` for the standards every milestone must meet and what each one proves.
