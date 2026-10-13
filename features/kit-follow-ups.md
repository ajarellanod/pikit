# Kit follow-ups

Work on the kit itself that is not a feature: nothing a user installs, but something pikit owes
itself. Features have their own files ([README](README.md)); no file tracks status, so an item
leaves this list when its change lands (and the CHANGELOG says so). Each item says why, when and
how big.

## Upstream proposals for pi-durable (pending the owner's decision to send)
Every gap pikit works around in Pi's packages (pi-durable, Chord, pi-mcp, pi-ai), with problem,
evidence, workaround, ask, priority and status, is listed in
[`docs/upstream/README.md`](../docs/upstream/README.md) so that none is lost; the longer ones have
their own file there. Each one Pi ships removes a workaround in the adapter or a limit of the kit.
- **Size:** small to write; each is sent when the owner decides.

## Publish the kit to npm; then upgrade the deployed bot
- **Why:** generated projects get the kit as tarballs vendored from a commit (`vendor/*.tgz`,
  `pikit.json`'s `kit.commit`), so a project's dependencies are pinned to source text from this
  repository's commits. Published `@pikit/*` packages make them ordinary versioned dependencies.
- **The deployed bot** (`pikit-telegram-cloudflare`, the first preset's template) is upgraded to
  the pi-durable kit, and its code improved, once everything is on npm, not from commits.
- **When:** now that the kit runs on pi-durable (the switch-over is done:
  [pi-durable migration](completed/pi-durable-migration.md)).
- **Size:** medium: package publishing, `pikit new`/`upgrade` resolving versions instead of commits.

## Before publishing `@pikit/contracts`: review its public surface
- **Why:** until the kit is published, removing or renaming an export costs nothing (no
  compatibility, pikit is unreleased); after, every export is a promise. Interchangeability is not at
  stake: it rests on the conformance suites, `checkStability` and `checkImports`, which hold today.
- **What to look at:**
  - Done (the contracts audit): `REDACTED`, `HTTP_ROUTE_KEY` and `commandProblem` are internal;
    `AgentImage` (part of `AgentRequest`) is exported; `InboundMessage` lost `raw` and `receivedAt`,
    which nothing read.
  - Keep `answerKey`, `COMMAND_NAME`, `CONVERSATION`, `ChannelTransport.idempotent` and
    `whenBusy: "steer"`: nothing uses them yet, but they are API kept on purpose for future
    components (transports' idempotency keys, slash commands run from a chat, memory's tools, a
    channel whose messages steer a run), which `docs/` and `features/` cite.
  - `agent.conversations` has no suite of its own: only `agent.observe`'s suite exercises it. Its one
    provider is runtime-pi, for good (Pi is the only agent runtime, SPEC §3.3), so it gets one only
    if its guarantees grow.
- **Not on this list, on purpose:** the feature contracts that would leave the package
  (`proposals`, `github`, `agent.directory`: [contract packages](contract-packages.md)), the
  runtime's Pi-shaped contracts (Pi is their only provider, by decision: SPEC §3.3), `storage.kv`
  (a contract only if a native KV provider is wanted), and the dashboard's
  request-id prefix in `delivery.ts` (a guarantee shared by every channel; revisit with a second
  operator interface or commands run from a chat).
- **When:** before the first publish ([above](#publish-the-kit-to-npm-then-upgrade-the-deployed-bot)).
- **Size:** small.

## Dashboard and deployment stay open
- **Decided:** the operator dashboard is a project's choice (`pikit new --ui`, `pikit ui on|off`), a
  shadcn/ui project of its own in `src/dashboard/` over a component, `admin-api` (SPEC §5), designed
  for every host: `admin-api`'s `http.route` handlers, server-sent events, no host API; deployment is never
  closed to server and Cloudflare (Vercel, E2B, exe.dev, Modal are expected), see
  [deployment targets](deployment-targets.md).
- **A base UI with shadcn/ui, extensible by components.** Not the largest interface: enough to
  start, and every other view comes from a component that brings it (SPEC §5). No platform
  under pikit (Pi Durable, Cloudflare, Rivet) offers an interface that is the user's to extend.
- **Pi first, watched:** Pi's `pi-server` (clients attached to durable sessions), the closest thing
  Pi had to the admin API's live part, was removed in Pi 1.2.0 with `pi-client` and `pi-protocol`;
  Chord 1.2.0's hosts link over WebSockets (`webSocketLink`, `acceptWebSockets`), with nothing for a
  browser or authentication yet. Re-check at each Pi bump: when Pi serves sessions to a browser with
  authentication, admin-api's events and actions move onto it and pikit's own transport goes. The coding agent's RPC
  mode is for one process over stdio; its event vocabulary is the one `agent.observe` forwards.
- **When:** in phases, each one usable. The first two have landed (CHANGELOG): `admin-api`,
  `src/dashboard/` (`registry/dashboard/`) and `pikit new --ui` / `pikit ui on|off` on a server, with
  the conversations, one live, steer, abort and reset, cost and the composition. Next:
  2. Landed too: pikit's UI pieces and views as shadcn items (`@pikit`), components with a view
     through `pikit add`, the `pikit-view` skill, and the Health (`health-registry`) and Delivery views.
  3. Landed too: Cloudflare, a conversation's object read, acted on and followed (polled) from the
     Worker by `actor.mailbox.call`, and [the index](cloudflare-conversation-index.md), an actor, to
     list them all; the dashboard's files bundled as a module on every host.
  4. The agent changing its own UI, through SPEC §6's gate.

## Building on the bases must be the easy path
- **Why:** pikit gives the bases and the user builds their assistant on them (SPEC P1, MANIFESTO
  principle 13). That only holds if a person or their AI agent can build a component that comes
  out right: [building components](building-components.md).
- **What:** skills for AI agents in every project (write a channel, a tool, a store, a dashboard
  view, a feature from its design note); a conformance suite for every contract (the execution
  environment and the tool shape still lack one in `@pikit/contracts`); each ⭐ feature note as a
  build guide (contract, Pi pieces, guarantees, tests); Git registries to share what users build.
- **Where it stands:** two skills, `pikit-component` and `pikit-extension` (`.agents/skills/`), are
  written and `pikit new` copies them into every project; `extension-house-rules` is the reference
  agent extension; [memory](memory.md) is the first ⭐ note written as a build guide; the contracts
  still without a suite are listed in [building components](building-components.md).
- **When:** the other skills with what they teach (adding a view with the dashboard).

## Chord: through the adapter and components, never in `@pikit/core`
- **Decided (validated against Chord 1.2.0, 2026-10-13, with a spike that ran the whole repository over a Chord-backed kernel):**
  `@pikit/core` stays, and Chord does not enter the kernel. The gates that must pass first, the check
  for each, what each validation found and how to re-run the spike are in
  [docs/chord-decision.md](../docs/chord-decision.md); it is re-validated at every Pi pin bump.
- **Keep:** aligning `Context` with Chord's shape.
- **Candidate**, through the adapter, when its feature is built: the operator UI's live state
  (SPEC §5), pi-durable's `watch()` and `taskGraph()` mapped through the `agent.observe` contract. pikit
  serves no Chord objects (hosts, facets), so nothing else of Chord's is a candidate.
- **Open:** Chord's semver ([docs/upstream](../docs/upstream/README.md), proposal 10; gate G1).
- **Size:** none now; each candidate is weighed with its feature.

## No code hot reload
- **Decided:** a reload is a restart. pi-durable checkpoints every step, so a restart loses nothing
  (K6). Code hot reload could never be cross-target (Workers forbid `eval` and `new Function`), and
  it contradicts "nothing is loaded dynamically in production" (MANIFESTO) and "the agent never edits
  what runs" (SPEC §6).
- **Yes to:**
  - a fast restart in development: `pikit dev` with watch, and a test that a restart mid-turn loses
    no message;
  - behaviour changes as data, applied live: per-conversation `configure()`, settings read through
    live getters, skills and memory as documents or files (editable later from the operator UI);
  - deploys that lose nothing.
- **Revisit** only for a marketplace of third-party plugins installed live, which is not pikit's
  model.
- **Size:** the restart test is small; the rest comes with the features that use it.

## Leftovers of the § reference pass
- **The properties lost their checks.** SPEC §2's table named, for each property, the standard in
  the former ROADMAP that enforced it (S1–S16, M3, M4, track S). ROADMAP is gone, so the column
  went. Whether each property should name its check again (`scripts/boundaries.test.ts`,
  `registry validate`, the removal test…) is open. *Size:* small, but it is a SPEC decision.
- **References outside the docs pass.** About 380 references to sections of the former SPEC (and to
  `SPEC-CORE.md`, `ROADMAP.md`, `AGENTS.md`) remain in code comments and READMEs: `registry/`
  (component READMEs, schemas, presets), `packages/cli`, `packages/pi-adapter` (besides `state.ts`),
  `packages/core`, `samples/http`, `scripts/`, `IDEA.md` and `installer/README.md`. They need the same
  mapping (current decision, contract file, or no number). *Size:* medium, mechanical, one package
  at a time.
- **CHANGELOG's older entries** cite the former SPEC's sections as they were when written; they are
  history and stay.
