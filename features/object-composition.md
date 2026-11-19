# Object composition: each Durable Object runs only what its key needs

**Public appeal:** — (latency: a message that wakes ten idle objects waits for ten whole-App starts)

**Specified:** no. A design, 2026-11-19, from neural-agents' measured critical path
(`agents/src/pikit/channel-google-chat/LATENCY.md` there).

**Where it stands (2026-11-19, the operator's decision):** the per-kind reduced App is **parked**. The bench
(`scripts/bench-object-start.ts`, `docs/benchmarks/object-start.md`) measured a whole App's start at 16–18 ms
locally: a cold object's cost is the number of objects on the path, not each one's App. Built and kept: the lazy
starts that take objects off that path (runtime-pi reads no credentials and asks no drive at start; provider-failover's
shared cooldowns read at the first model request; memory-recall and projects-context ask fewer lists per run), the
bench, and `pikit: object started`'s `isolate` (`new`/`warm`) and `startMs` (the start's waits) to measure production.
The mechanism (T1: `actor.kind`, `actorComposition`, the host) and the started parts of T6, T8, T9 and T10 stay on
their branches (`agent/comp-t1-mechanism`, `agent/comp-t6-cli-apps`, `agent/comp-t8-celld`, `agent/comp-t9-doctor`,
`agent/comp-t10-declarations`), unmerged: resume them only if production shows the App's start is the cost.

**Since:** admin-api's index, which the tables below name (`admin-api:index`, its awaited backfill `seen`
and titles), is replaced by the [conversation directory](completed/conversation-directory.md): its actor
`conversations-directory:index` is told from each conversation's outbox by a wakeup, never on a
message's path, and its start's backfill calls nothing when nothing is new.

**Needed by:** nothing required. SPEC §4's budget "cold start ≤ 1 s" is per object; a message that
crosses ten cold objects in series is ten of them, which no budget covers today.

## The problem

On the `durable` target every Durable Object composes and starts the project's whole default export
on its first event, whatever its key (`createObjectHost` in deployment-cloudflare's `host.ts`, the
same in deployment-celld's copy). That App is the conversation's: in neural-agents it has 66
components. Many keys are not conversations but one-purpose actors, each the owner of some state
(C2's "an actor key need not be a conversation's"):

| Key | Owner (kit or project) | What it answers |
|---|---|---|
| `credentials-do` | credentials-do | model credentials, the refresh lock |
| `provider-failover:cooldowns` | provider-failover | shared cooldowns |
| `tool-mcp-oauth` | tool-mcp-oauth | MCP logins |
| `settings-store:settings` | settings-store | live settings |
| `admin-api:index` | admin-api | the conversation index |
| `memory:space:<s>`, `memory:person:<u>`… | memory-sql | memory |
| `projects:index`, `projects:space:<s>` | projects-sql | projects |
| `space-files:<s>` | tool-space-files | a space's saved files |
| `approvals-sql:approvals`, `repo-github-app:credentials`, `scheduler-routines:routines`, `channel-web:accounts` | their components | their records |
| `people:directory`, `rooms:index`, `neural-admission:*`, `neural-metrics:counters`… | neural-agents' own | its records |

Each of them, once evicted (production evicts an idle object in about 20 to 40 s), costs a whole
start on its next call: 66 components' `start`s, and the start-time calls some of them make to other
objects, which may be cold too:

- **runtime-pi** checks every agent's provider (`checkAuth`) and then every provider again for the
  settings overrides (`usableProviders`), awaited and one after the other: with `model.credentials`
  installed each is a `credentials-do.read` call (cached 60 s per object), so the first one starts
  the `credentials-do` object if it is cold. In a non-conversation object none of this is used.
- **runtime-pi** also asks, at every object's start, for its drive wakeup at once (what a previous
  instance left pending is resumed from an alarm): so every object, an owner too, gets an alarm right
  after its start, which reads runtime-pi's settings overrides (a `settings-store.read` call) and opens
  pi-durable over the object's SQL.
- **provider-failover** starts its first sync of the shared cooldowns (not awaited by start, but a
  call, so a start of `provider-failover:cooldowns` and a subrequest) in every object.
- **admin-api** awaits its backfill in every conversation object's start: a `seen` to
  `admin-api:index` (and a title's `model.complete` for a conversation with none).
- **tool-mcp** reaches its servers (and `mcp.auth`, so `tool-mcp-oauth`) only when neither the kept
  listing nor `seed.ts` has them: a local dev stack with no `pikit up` yet.

So `settings-store:settings` cost 930 ms in the modelled cold measurement (its own start, then
`credentials-do`'s), and a cold Google Chat message woke 10 to 12 objects in series before its
model call. The composition itself is cheap (about 3 ms: setups only, the bundle is already loaded);
what costs is the starts and the calls they make.

## What it gives

- **An object whose key belongs to an actor kind runs only that kind's App**: the components that
  declared the kind, plus what they use, transitively, through the capability graph. A
  `memory:space:<s>` object starts memory-sql, storage-do and actors-do (3 components, no call to
  another object) instead of 66.
- **Nothing changes for conversations** (a key no kind declares runs the whole default export, as
  today), **for servers** (one process is every key's actor), or **for what any actor answers**.
- **Starts make no calls to other objects**: the reads that a start made for later (credentials,
  cooldowns, the index's backfill) happen at first use, prefetched where a later step will need
  them, so cascades of cold objects disappear from every path.
- **`pikit doctor` shows each kind's App** and fails when one does not compose.
- **No change to a project**: `pikit upgrade` brings the declarations; a project keeps any kind whole
  by deleting one line.

## Decisions

### 1. An object knows its kind from its key; components declare kinds

A kind is a set of keys one component (or several) owns. The owning component declares it, in its
`setup`, as a keyed capability under its own name:

```ts
// packages/contracts/src/actor-kind.ts (new; exported from @pikit/contracts)
/**
 * The actor keys a component owns: an object of one of them runs this component and what it uses,
 * not the whole App (SPEC C9). Provided under the component's own name.
 */
export interface ActorKind {
  /** Keys it answers, exactly: `["credentials-do"]`. */
  readonly keys?: readonly string[];
  /** Key prefixes: every key that starts with one, `["memory:"]`. */
  readonly prefixes?: readonly string[];
}

declare module "@pikit/core" {
  interface AppKeyedCapabilities {
    "actor.kind": ActorKind;
  }
}
```

```ts
// credentials-do's setup
pikit.provideKeyed("actor.kind", "credentials-do", { keys: [CREDENTIALS_KEY] });
// memory-sql's setup
pikit.provideKeyed("actor.kind", "memory-sql", { prefixes: ["memory:"] });
```

- **Matching** (one shared function, below): an exact key wins over any prefix, the longest prefix
  over shorter ones; components that declare the same pattern own it together (a project's
  component that answers calls on a kit kind's keys declares the same pattern: neither is told about
  the other). A key that matches nothing is a conversation's, or any other actor's that declared
  nothing: the whole App. That default is what makes the change safe to roll out: only a declaration
  reduces anything.
- **Refused, loudly** (`actorKindProblems`): a capability key that is not its provider's name, an
  empty kind, an empty or `pikit:`-prefixed pattern (the host's own: `pikit:health`). A problem fails
  every object's start of that deployment, so `/health` fails and the deploy is rolled back (C8).
- **Why a capability, not a manifest field or the config.** The host reads it at run time, where
  there is no `component.json` and no generated file (K13's reasons); it is in the composition, so
  `describe()`, the dashboard and `pikit-self` see it; and it is the component's own fact (which keys
  its handlers answer), written beside the handlers. Its consumer is the deployment host, and
  `pikit doctor`. On a server nothing reads it: a declaration is a value, not a loaded part.
- **Why keyed by the component's name, with the patterns in the value**: so several components may
  own one pattern, which keying by the pattern would forbid (one provider per key).

How the host learns an object's key, before it composes anything:

1. **The event's own key**: `deliver`, `call` and `stream` carry it. The host checks it is the
   object's (`env.CONVERSATION.idFromName(key)` equals its id) and refuses another loudly: a wrong key
   must never choose a composition.
2. **`ctx.id.name`** for an alarm (and any event without a key): Cloudflare gives a Durable Object
   its `idFromName` name since March 2026.
3. **The key kept in the object's storage** (`pikit:key`), written once, at the first keyed event,
   where the platform gives no name (celld until it does, workerd's older versions).
4. **None known** (an object made before this change whose first event after the deploy is an
   alarm): the whole App, as today.

`GET /health`'s own object (`pikit:health`) always runs the whole App: it is the proof that the
conversations' App starts.

Alternatives weighed:

- **The config names an App per kind** (`export const actors = { "memory:": defineApp({...}) }`):
  the most explicit, and rejected. Each list repeats storage, the inbox, secrets and every
  transitive provider by hand; `pikit add` would edit a list per kind; a provider missed is a failure
  at run time; and which keys a component's handlers answer is the component's fact, not the
  project's. It also makes a project change for a gain the kit can give with none.
- **A Durable Object class per kind**: a binding and a migration each (wrangler.jsonc is the
  deployment's, the same for every project), migrations cannot be rolled back (C8), and actors-do
  routes every key to one namespace. Rejected.
- **The first message's type** (`memory.list` belongs to memory-sql): types are a component's, keys
  are the actor's identity; an object's composition must be fixed by what it is, not by what it was
  asked first. Rejected.
- **Starting components lazily inside one App**: a kernel change to the lifecycle (K2, K6) with an
  order nobody can read. Rejected. The lazy reads below are each component's own choice.

### 2. A kind's App is the closure of its owners over the capability graph

One pure function in `@pikit/contracts`, over the whole App's `describe()` (K13), so the hosts and
`pikit doctor` cannot disagree:

```ts
// packages/contracts/src/actor-kind.ts
import type { AppDescription } from "@pikit/core";

export interface ActorKindDeclaration extends ActorKind {
  /** The component that provides it (the capability's key). */
  readonly component: string;
}

export interface ActorKindMatch {
  /** The pattern that matched: the key itself, or the longest prefix. */
  readonly pattern: string;
  readonly exact: boolean;
  /** Every component that declares that pattern, in the App's start order. */
  readonly owners: readonly string[];
}

/** The kind `key` belongs to, or `undefined`: the whole App. */
export function actorKindOf(declarations: readonly ActorKindDeclaration[], key: string): ActorKindMatch | undefined;

/** What is wrong with a set of declarations, one line each, never a secret. Empty when nothing is. */
export function actorKindProblems(declarations: readonly ActorKindDeclaration[]): string[];

/**
 * The components of a kind's App, by name, in `description`'s start order: the owners, the providers
 * of `actor.inbox` and `wakeups` (the object's RPC and alarm), and, transitively, for every
 * capability an included component uses (`requires`, `optional`, keyed): the selected provider of a
 * single one when it is installed, every provider of a keyed one.
 */
export function actorComposition(description: AppDescription, owners: readonly string[]): readonly string[];
```

- **Optional uses are followed when installed.** A component's behaviour may depend on a
  `useOptional` (that is the verb's job), so a kind's App must give it what the whole App gives it.
  This keeps behaviour, at the price of a larger App where an optional use is heavy. Where that price
  is real, the owner is split into its own part (decision 5), never made blind to what is installed.
- **A single capability provided by several included components** keeps its selected provider too,
  so `config.capabilities` stays valid.
- **Events and pipeline stages are not followed.** They are not in the capability graph (K3: no
  registered events), and following every stage would pull the conversation's routers into every
  object. The rule an owner keeps instead, written in the contract: *an actor kind's handlers depend
  only on the capabilities its components use; never on another component's listener or pipeline
  stage running in its object.* Every kit owner keeps it today (checked by reading each, below); the
  one known exception is a project's (neural-agents' `channel-google-chat:access`, a dry run of the
  routers): `ActorKind` gets a `pipelines` field, whose stages join the closure, when that actor comes
  to the kit, not before (contract rule 1).
- **Settings declarations** were a hidden coupling of the same sort: settings-store's object
  validates against its own App's declarations (decision 6 removes it).

The host builds the kind's App from the project's own definitions and config, never a component of
its own: the subset of `definition.components` the closure names, in the same list order (so the
same start order), with `definition.config` reduced to those components' keys and the selections
whose provider is included.

### 3. What changes in deployment-cloudflare's host (and deployment-celld's copy)

```ts
// host.ts, sketched
export interface ObjectState {
  id: { toString(): string; name?: string };   // ctx.id.name
  storage: ObjectStorage;                       // gains put(key, string) for "pikit:key"
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** Per isolate: the whole App composed once (setups only, never started) to read the kinds. */
interface Kinds {
  description: AppDescription;
  declarations: readonly ActorKindDeclaration[];
  /** The kind's AppDefinition, made once per kind per isolate; the whole one when `key` has none. */
  definitionFor(key: string | undefined): { definition: AppDefinition; kind: ActorKindMatch | undefined };
}
```

- **Once per isolate**, on its first object event: the whole default export is composed (`create()`,
  every setup, no start) with one reader component of the host's (`useKeyed("actor.kind")`, named
  `deployment-cloudflare` as the Worker's server is), its `describe()` and declarations kept, the App
  dropped. Declaration problems throw there: every start fails, loudly.
- **Per object**, inside `blockConcurrencyWhile` as today: the key (decision 1), the kind's
  definition, `create()` and `start()` with the same deadlines, guard alarm and rollback. The log line
  `pikit: object started` gains `kind` (the pattern, or none), `components` (how many), `composeMs`
  and `startMs` (not the key: below).
- **`GET /health`** starts the whole App in `pikit:health`, as today, and also `create()`s every
  kind's App there (no start): a deploy whose kind does not compose fails `/health` and is rolled
  back.
- **A call or delivery with no handler in a kind's object** keeps its loud failure, and the host adds
  to actors-do's message which kind the object runs and its components: "this object runs the actor
  kind `memory:` (memory-sql, storage-do, actors-do); a component that answers `<type>` on these keys
  declares `actor.kind` for them too".
- **No option to turn it off.** A switch in `worker.ts` would be a flag choosing a strategy
  (principle 8). A project keeps a kind whole by deleting that component's declaration, its own
  source; a measurement compares two kit revisions (below).

The key in the log: object keys may hold a person's identifier (`memory:person:<user>`). The log
carries the kind's pattern and the object's id, never the key.

### 4. What stays in every object

The provider of `actor.inbox` and of `wakeups` (actors-do: the RPC's other end and the alarm's one
owner, so a kind's object still answers, wakes and runs the guard-alarm logic) and what they use.
Everything else joins by use: every kit owner uses `storage.sql` (storage-do), most `secrets`
through what they use. The host's own parts (deadlines, guard alarm, start-failure count) are
unchanged.

### 5. Owners whose component is heavy get an owner part

A kind's App holds its owner whole, with every required capability (a `use` must be satisfied, or the
App does not compose). An owner whose component is a conversation's part (admin-api's object half
requires `agent.observe` and `agent.runtime`; channel-web requires the runtime) would pull
runtime-pi and half the App back in. Such an owner becomes a part of its component: another export,
its own `ComponentDefinition` (`admin-api-index`), with only what the owner uses, listed in the
default App beside the component, as a Worker half is listed in the Worker's. neural-agents already
writes this by hand (`rooms, { owner as roomsIndex }`); the CLI learns it: `component.json`'s `apps`
values become a name or a list of names (`"apps": { "default": ["default", "index"], "worker":
"worker" }`), and `pikit add`, `remove` and `upgrade` list, unlist and merge each, `halves` generated
per export as they are for the Worker's.

From reading each owner's `component.json` (`halves.default`), the kit's kinds and their Apps:

| Kind (component) | Pattern | Its App beyond storage-do and actors-do | Part needed |
|---|---|---|---|
| credentials-do | key `credentials-do` | none | no |
| memory-sql | prefix `memory:` | none | no |
| approvals-sql | key `approvals-sql:approvals` | none | no |
| repo-github-app | key `repo-github-app:credentials` | secrets-workers | no |
| tool-mcp-oauth | key `tool-mcp-oauth` | admin-auth-token, secrets-workers, a `health` provider if installed | no |
| projects-sql | prefix `projects:` | memory-sql, admin-auth-token, secrets-workers | no |
| scheduler-routines | key `scheduler-routines:routines` | scheduler-sql and its uses | no |
| provider-failover | key `provider-failover:cooldowns` | every `model.provider`, credentials-do, secrets-workers, `health` | no: its start reads nothing once decision 7 lands |
| tool-space-files | prefix `space-files:` | `execution`, `storage.blob` and their uses, `projects`, `document.convert` | no (to measure: execution-remote and the blob store start nothing remote) |
| settings-store | key `settings-store:settings` | admin-auth-token, secrets-workers | no, after decision 6 |
| admin-api | key `admin-api:index` | (the runtime, the whole conversation side) | yes: `admin-api-index` |
| channel-web | key `channel-web:accounts` | (the runtime) | yes: `channel-web-accounts` |

A project's own owners declare the same way (neural-agents: `people:directory`, `rooms:index` on its
existing `owner` part, `neural-admission:`, `neural-metrics:counters`, `files-storage`, the ledgers of
decisions, missions and request-task, `routine-pipelines:routines`).

### 6. settings-store: values in one object, declarations in another

Today the settings object answers `read` (every admission reads it, and channel-google-chat's Worker
route reads the `conversations` setting before handing a message on), `sections` and `set`, and it
validates against its own App's declarations, made by every component's `start` (runtime-pi's
overrides schema among them, built from the providers with credentials: so its start reads
`credentials-do`). A kind's App would have no declarations but settings-store's own.

- **`settings-store:settings` keeps the values** and becomes settings-store's kind: `read` (as now)
  and a new `settings-store.put` `{ component, value, operator }` that writes a value already
  validated and bumps the version. It needs no declaration: a conversation's object validates what it
  reads against its own declarations, as today.
- **`settings-store:catalog` answers `sections` and `set`**, not a kind, so the whole App, whose
  components declare: `set` validates there, then `put`s to the values object. The Worker's half asks
  the catalog for the Settings dialog and the values object for reads. The operator's path costs a
  whole start after idleness, as today; every message's path no longer does.
- **Declarations may be lazy**: `@pikit/contracts`' `Settings.declare(component, schema | (() =>
  Promise<TSchema>), defaults)`; the store resolves a lazy schema when it first needs it (`sections`,
  `set`, the validation of that component's `get`). runtime-pi declares its overrides lazily, so its
  start reads no credentials (decision 7).
- **The Worker's half reads the values once per request** (LATENCY's smaller win: six reads today).
- No data moves: the values stay in the same object and table; declarations were never stored.

### 7. Starts read nothing they do not need: first use, prefetched

Each is the owning component's change, independent of composition, and helps conversation objects
too:

| Component | Today | After |
|---|---|---|
| runtime-pi | `checkAuth` per agent's provider, then `usableProviders` per provider, awaited in series (each a `credentials-do.read` with a store) | With `model.credentials` installed, nothing awaited at start: one `credentials.list()` is started (not awaited) and kept; the agents' check runs against it at the first admission (a missing provider still warns and its runs fail, as today); the overrides schema is declared lazily over the same list. Without a store (keys in `secrets`, local) the check stays at start and still refuses the start. |
| provider-failover | first cooldowns sync started at start | first sync at the first `ready()` (the first model request), still bounded by `firstWaitMs`: the same promise ("an App's first requests wait at most 1 s for its first read"), and no call from an object that never asks a model |
| admin-api | backfill (`seen` to the index, titles) awaited in each conversation object's start | a `wakeups` request a few seconds after start runs it from the alarm (it repairs missed events, which may be late: cloudflare-conversation-index.md says so); `seen` on `agent.dispatched` sent without being awaited before `agent.started` |
| tool-mcp | describes from the kept listing or the seed; reaches the server without them | unchanged: a project that never ran `pikit up` has no seed (`pikit dev` says so already) |

And two smaller wins of the same measurement, each its own component's: memory-recall lists each
owner once per run (four identical `memory.list` today), projects-context looks its project up once
per run (three today).

### 8. A server is unchanged

One process is every key's actor (`mailbox-local`, scope `"all"`): there is nothing to reduce, and
nothing reads `actor.kind`. `pikit doctor` still checks the declarations (a project may move to the
`durable` target), and prints the kinds only for a durable project. The lazy reads of decision 7
apply on both targets (they are the components', not the host's).

### 9. `pikit doctor` and `registry validate`

- **The probe** (`packages/cli/src/project/probe.ts`, in the project's own process) composes the
  default App as today, reads the declarations (a reader component, as the host does), and for each
  kind computes `actorComposition` with the project's `@pikit/contracts` and `create()`s that App:
  `kinds: [{ components: owners, keys, prefixes, app: string[], problem? }]`.
- **`doctor` fails** on a declaration problem or a kind's App that does not compose (naming the kind
  and the first error), before any hook runs; and notes, per kind, one line: `actor kind memory:
  (memory-sql): 3 of 66 components (memory-sql, storage-do, actors-do)`. A kind whose App holds
  `agent.runtime`'s provider is noted as "the whole conversation side: give its owner a part of its
  own" (decision 5).
- **`registry validate`** runs `actorKindProblems` over each component's declarations with its default
  config and examples, and refuses two kit components that declare the same pattern (co-owners are a
  project's choice, never the kit's).

## Where it bends the manifesto, and why

- **No magic (principle 9).** What runs in a kind's object is computed, not listed. It still holds
  literally: everything that runs is imported from `pikit.config.ts`, and an object runs a subset of
  what is listed, never more. The rule is one pure function, written in SPEC (C9), shown by `pikit
  doctor` per kind, and visible in the object itself (its `APP_DESCRIPTION` is its own App's, K13).
- **SPEC C1** says the default export is "the Durable Object's App". It becomes: the conversation
  objects' App, and the source of each actor kind's App (C9). K7 already leaves the split of
  components between Apps to the target and the components; the kernel does not change.
- **Fail loudly (principle 10)** is kept, and sharpened: a declaration problem or a kind that does not
  compose fails `/health` (the deploy rolls back), and a call a kind's object cannot answer says which
  kind it runs and what to declare.
- **Contracts are the only coupling (principle 6).** A kind's App follows capabilities only, and no
  component names another (co-owners declare the same pattern, each for itself).

## Measurement

What costs in production's ~0.4 to 0.6 s per cold object is not known yet: the isolate's script start
(the whole bundle, which composition does not shrink), the App's start (its components' local work),
and the calls the start awaits (each possibly another cold object). The plan separates them before
the bigger phases are built.

- **Two clocks.** Inside workerd and on Cloudflare, `Date.now()` moves only on I/O: `startMs` logged by
  the host measures the start's waits (calls, fetches), not its CPU. CPU and the whole is measured
  from outside, by the client's wall clock.
- **`scripts/bench-object-start.ts`**, like `scripts/bundle-size.ts`: makes a project (`pikit new
  --target durable --preset cloudflare --with` memory, projects, approvals, provider-failover,
  tool-mcp-oauth, credentials-do, with provider-faux) from a given kit revision (a `git worktree` of
  `--base`, and the working tree), adds a bench part (a Worker route `POST /bench/call` behind a token:
  `actor.mailbox.call(key, type, message)`), runs `wrangler dev`, and measures from Bun:
  1. a fresh owner key's first call (`memory:space:bench-<n>`, `memory.list`), 30 times: a cold object
     in a warm isolate, with no cascade;
  2. the fixed owners cold (`wrangler dev` restarted between rounds): `settings-store.read`,
     `credentials-do.read`, `provider-failover.sync`, `admin-api.list`, `projects` lookup, in series:
     the cascades;
  3. a fresh conversation's first message through `channel-http` to `faux/scripted`: the
     conversation object's start;
  4. per scenario, from `wrangler dev`'s output, how many objects started (`pikit: object started`,
     already logged before this change) and, after, their `components`, `composeMs` and `startMs`.
  It prints a table, base against head, and writes it as JSON (`.bench/`, gitignored). The modelled
  figure (each object start +400 ms, LATENCY's model) is computed from the counts, not injected.
- **Production** (the operator's to allow): the same log line from a deploy of neural-agents, with an
  `isolate` field (the first object of its isolate, or not) to tell script start from App start.

Expected, to be confirmed by the bench (neural-agents' numbers from LATENCY.md):

| | Before | After (expected) |
|---|---|---|
| Components started in a kind's object | 66 (neural-agents), ~25 (cloudflare preset with the features above) | 3 to 12 |
| Calls a kind's object's start makes to other objects | 2 to 5 (credentials reads in series, the cooldowns sync), then an alarm at once (runtime-pi's drive: a settings read) | 0, and no alarm |
| Calls a conversation object's start awaits | 2 to 5 (credentials reads, admin-api's `seen`, a title) | 0 (credentials prefetched in parallel) |
| Fresh owner key, first call, raw local (scenario 1) | 20 to 50 ms | under 10 ms |
| `settings-store:settings` cold, modelled | 930 ms (its start, then credentials-do's) | ~420 ms (its own start only) |
| Objects started by one cold neural-agents message | 10 to 12 | 8 to 10 (no credentials-do or cooldowns cascade) |
| Cold message, webhook to answer, modelled (400 ms an object start) | 3.64 s | ~2.3 to 2.8 s (cascades, the conversation's own awaited reads, admin-api's awaited `seen`) |
| Same, if production's ~0.45 s an object is mostly its App's start | ~4.5 s (production tail) | ~1 to 1.5 s |

If production shows the isolate's script start dominates, composition saves only the cascades and
starts' calls (the middle rows); the lever is then the bundle that owner objects load, which is
another note (open questions).

## Migration

- **Existing projects: nothing to do.** `pikit upgrade` brings the declarations and the hosts; from
  the next deploy, a kind's keys start their kind's App. The objects and their data are the same
  (same keys, same ids, same tables).
- **What an old object keeps**: tables that excluded components made in it (runtime-pi's, in a
  `credentials-do` object) stay, unused; a wakeup row of an excluded component that is still there
  (runtime-pi's drive, asked for at every start today, if an eviction cut its alarm) makes one alarm
  that finds no handler, after which actors-do sets no more. Neither needs cleaning.
- **A project's component that answers calls on a kit kind's keys** must declare the same pattern,
  or its calls fail with `no_handler` after the upgrade, with the message above saying so. The
  upgrade's notes list the kit's patterns. neural-agents: none of its components answer on kit keys
  (checked against its extensions' key constants); its own owners are its follow-up (decision 5).
- **To keep a kind whole**: delete its `provideKeyed("actor.kind", …)` line (the component's source,
  yours). No config line exists or is needed.
- **The settings split and the owner parts** keep their keys and tables; `pikit upgrade` of admin-api
  and channel-web adds their parts to the default App (`pikit.config.ts` gains one entry each, as an
  `add` writes it).

## Tests

- **The pure function** (`packages/contracts/src/actor-kind.test.ts`): matching (exact over prefix,
  longest prefix, co-owners, no match), problems (key not the component's name, empty kind or
  pattern, `pikit:`), closure (required, optional installed and not, keyed: every provider, a
  selected provider among several, the selected peer of an included provider, `actor.inbox` and
  `wakeups` always, start order). Each case checked against a broken implementation (drop optional
  uses, drop keyed providers: the cases fail).
- **The equivalence suite** (`createActorKindConformance`, `@pikit/contracts/testing`): with a
  fixture that composes a key's object as the whole App and as its kind's App, the same calls and
  deliveries give the same outcomes and the same stored rows, and the kind's start makes no call to
  another key. Negative: a co-owner that does not declare is caught (its call is `no_handler` in one
  and answered in the other).
- **The host under Bun** (`host.test.ts`, both deployments): a kind's key composes its closure only
  (the object's `describe()`), a conversation's the whole App; an alarm finds its key by `id.name`,
  then `pikit:key`, else the whole App; a key that is not the object's is refused; a declaration
  problem fails every start; `/health` fails when a kind does not compose; a missing handler names the
  kind; the whole App is composed once per isolate, not per object.
- **workerd** (`tests/workerd/test/deployment-cloudflare.workerd.ts`, then
  `object-composition.workerd.ts`): on the real class, a kind's object evicted and woken by its alarm
  composes its kind again (from `ctx.id.name`); every kit kind's equivalence suite through real RPC;
  zero calls during a kind's start (a recording namespace).
- **doctor** (`doctor.test.ts`): the kinds listed; a declaration problem and a kind that cannot
  compose fail; a kind holding the runtime noted.
- **Each declaring component**: its declaration and its kind's App (the function over a small App of
  it and its providers) hold what the table above says, and its start calls no other key.
- **The bench is not a test**: timings are not asserted; the counts it reads are, by the tests above.

## Build plan

Each task is one worktree and one branch, owns exactly the files listed (no task touches another's
in the same phase), and leaves the kit green (`bun test` bounded, `bun run registry generate` and
`validate`, the workerd lane where it touches Cloudflare components). `registry generate` rewrites
only the `component.json` of components whose setup changed.

**Phase 1, in parallel** (T1 is the only one that needs nothing; the others need no contract):

| Task | What | Owns |
|---|---|---|
| T1 the mechanism | `actor.kind`, the three functions and the suite; deployment-cloudflare's host (decision 3); credentials-do's declaration as its first provider (contract rule 1: with a producer and a consumer); SPEC C1 amended, C9 written; the docs | `packages/contracts/src/actor-kind.ts` (+ test), `packages/contracts/src/index.ts`, `packages/contracts/src/testing/actor-kind.ts`, `packages/contracts/src/testing/index.ts`, `packages/cli/src/registry/capabilities.ts`, `docs/contracts.md`, `docs/targets.md`, `docs/concepts.md`, `SPEC.md`, `registry/components/deployment-cloudflare/**`, `registry/components/credentials-do/**`, `tests/workerd/test/deployment-cloudflare.workerd.ts`, `tests/workerd/src/deployment.ts`, `tests/workerd/src/worker.ts` |
| T2 the bench | the bench and the baseline, measured at `feat/projects` before T1 merges | `scripts/bench-object-start.ts`, `scripts/bench/**`, `docs/benchmarks/object-start.md`, `.gitignore` (`.bench/`) |
| T3 runtime-pi, first step | no credential read awaited at start with a store: `list()` prefetched, the agents' check at the first admission, `usableProviders` over the one list | `registry/components/runtime-pi/**` |
| T4 provider-failover's sync | the first sync at the first request | `registry/components/provider-failover/files/src/pikit/provider-failover/shared.ts`, its tests, README |
| T5 admin-api's start | backfill in a wakeup; `seen` not awaited before `agent.started` | `registry/components/admin-api/**`, `tests/workerd/test/admin-api.workerd.ts` |
| T6 the CLI's parts | `apps` values as a name or a list; add, remove, upgrade, halves | `registry/schema/component.schema.json`, `packages/cli/src/registry/manifest.ts`, `packages/cli/src/project/apps.ts`, `packages/cli/src/project/config-file.ts`, `packages/cli/src/commands/{add,remove,upgrade}.ts` and their tests, `packages/cli/src/commands/two-apps.test.ts` |
| T7 the smaller wins | one `memory.list` per owner per run; one project lookup per run | `registry/components/memory-recall/**`, `registry/components/projects-context/**` |

**Phase 2, in parallel, after T1** (and T2's baseline):

| Task | What | Owns |
|---|---|---|
| T8 celld's host | decision 3 in deployment-celld's copy, with `pikit:key` (celld's `id.name` unverified) | `registry/components/deployment-celld/**` |
| T9 doctor and validate | decision 9 | `packages/cli/src/project/probe.ts`, `packages/cli/src/commands/doctor.ts` (+ tests), `packages/cli/src/registry/checks.ts` (+ tests), `docs/cli.md` |
| T10 the small owners | declarations of memory-sql, projects-sql, approvals-sql, repo-github-app, scheduler-routines, tool-space-files, tool-mcp-oauth, provider-failover (its `index.ts` only: T4 is merged), each with its test and README line | those components' `index.ts`, tests, READMEs, `component.json` |
| T11 settings-store | decision 6: values and catalog, `put`, lazy declarations in the contract, one read per Worker request; its declaration | `packages/contracts/src/settings.ts` (+ test, its suite in `testing/`), `registry/components/settings-store/**`, `tests/workerd/test/settings.workerd.ts`, `tests/workerd/test/settings-operator.ts` |

**Phase 3, in parallel, after T6 and T11:**

| Task | What | Owns |
|---|---|---|
| T12 admin-api's index part | `admin-api-index` (`apps.default: ["default", "index"]`), declaring `admin-api:index` | `registry/components/admin-api/**`, `registry/dashboard/dashboard.json` if its list changes, `tests/workerd/test/admin-api.workerd.ts` |
| T13 channel-web's accounts part | `channel-web-accounts`, declaring `channel-web:accounts` | `registry/components/channel-web/**`, `tests/workerd/test/channel-web.workerd.ts` |
| T14 runtime-pi, second step | the overrides schema declared lazily: no credentials call left on the start path | `registry/components/runtime-pi/**` |

**Phase 4, one task, after all:**

| Task | What | Owns |
|---|---|---|
| T15 the proof | every kit kind's equivalence in workerd, zero start calls; the bench, base against head; the numbers; this note to `completed/` | `tests/workerd/test/object-composition.workerd.ts`, `tests/workerd/README.md`, `docs/benchmarks/object-start.md`, `features/object-composition.md` (moved), `features/README.md`, `CHANGELOG.md` |

A check between phases 1 and 2: T2's baseline and T1's log line on the bench (and, if allowed, in
production) say how much of a cold object is its App's start. If it is little, phases 2 and 3 still
remove the cascades, and the open question on the bundle comes first.

## Pi first

Nothing in Pi: one Pi process knows nothing of Durable Objects or of other actors' keys. pi-durable's
storage and runtime open only in objects whose kind uses `agent.runtime`, that is in conversations'.

## Open questions

- **Production timing.** May an instrumented build (the log line's `isolate`, `composeMs`, `startMs`)
  be deployed to neural-agents, or a staging Worker of it, to split script start from App start?
  Local workerd cannot show isolate placement.
- **The settings catalog.** Decision 6 adds a second settings object whose first open after idleness
  costs a whole start (the Settings dialog, as today). The alternative is to keep the settings object
  whole and win nothing on the path that reads it before every Google Chat hand-off.
- **Routing's dry run.** neural-agents' `channel-google-chat:access` actor (a dry run of the routers
  before "Thinking…") needs the routers' pipeline stages, which a kind does not follow. Should that
  actor move into the kit's channel-google-chat, with `ActorKind.pipelines`, or stay the project's
  (its object whole)?
- **If script start dominates**: a second, smaller Worker script for the owners (their own class and
  bundle) would be the next lever. It costs a binding, a migration and a second deploy unit; worth a
  note of its own only if the numbers say so.
