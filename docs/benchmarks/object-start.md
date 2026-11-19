# Benchmark: a Durable Object's cold start

`scripts/bench-object-start.ts` measures what a cold object costs on local workerd (`wrangler dev`):
the isolate's script start apart from the Apps' starts, and how many other objects a start wakes on
the way. It is the measurement of [object composition](../../features/object-composition.md)
("Measurement"): the whole App in every object today, against a revision where an owner's key runs
only its kind's App. Timings are printed, never asserted.

## Running it

```sh
bun scripts/bench-object-start.ts                                # this checkout only (head)
bun scripts/bench-object-start.ts --base feat/projects           # a revision against this checkout
bun scripts/bench-object-start.ts --base feat/projects --head ../pikit-comp-t1-mechanism
```

| Option | Default | What |
|---|---|---|
| `--base <rev or dir>` | none | the other side: a revision (checked out as a `git worktree` in `.bench/kits/`, `bun install`ed, removed at the end) or a kit checkout's directory |
| `--head <dir>` | this checkout | the side under test: a kit checkout, its working tree as it is (`+dirty` in the notes when it has changes) |
| `--rounds <n>` | 3 | `wrangler dev` restarts per scenario that needs everything cold (0, 2, 3) |
| `--fresh <n>` | 30 | fresh owner keys in scenario 1 |
| `--conversations <n>` | 5 | warm-owner conversations per round in scenario 3 |
| `--model-ms <n>` | 400 | the modelled cost of one object start |
| `--port <n>` | 8799 | `wrangler dev`'s port (its inspector: port + 500) |
| `--keep` | off | keep the projects (in the system's temporary directory) and the base worktree |

One full run, base and head, takes about 4 minutes on an M3. Needs only Bun and the kit's
dependencies (`bun install`): no Cloudflare account, no model key, no network but npm's cache.

What it does, per side: the side's own CLI makes a project in a temporary directory, `pikit new
--target durable --preset cloudflare --with channel-http --with agents-live --with tool-mcp`, then
`pikit add memory-sql projects-sql approvals-sql provider-failover tool-mcp-oauth credentials-do
provider-faux` (32 components in the object's App), with the steward on `faux/scripted`, the bench's
part in the Worker's App (`scripts/bench/part.ts`: `GET /bench/ping`, `POST /bench/call` behind a
token, which is `actor.mailbox.call(key, type, message)`, and `POST /bench/ids`, the object id of each
key), and the dashboard built once (`wrangler.bench.json` is the project's config without its build
command, so a restart bundles only the Worker). Then `wrangler dev` runs in a process group of its
own and is stopped at the end of each round, on error and on Ctrl-C (`scripts/bench/process.ts`).

Results: the table on stdout, and `.bench/object-start-<time>.{md,json}` (gitignored): the JSON has
every sample, with the objects each step started and every field of their log lines.

## What it measures

**Two clocks.** Inside workerd `Date.now()` moves only on I/O: a time the host logs (`startMs`, from
object composition on) is a start's waits (calls, fetches), never its CPU. Every time in the table
is the client's wall clock (Bun), which sees both; the objects each step started are counted from
`wrangler dev`'s output, one `pikit: object started` line each, named by the bench's `ids` route
(the line carries the object's id, never its key).

| # | Step | What it isolates |
|---|---|---|
| 0 | script start: `wrangler.script.json`'s first request, less a warm one | the bundle evaluated: a Worker (`scripts/bench/script-start.ts`) whose first request imports the project's whole Worker module (esbuild evaluates a dynamically imported module on that import). No App is composed. The real Worker cannot show it: `wrangler dev` evaluates its script before it prints "Ready" |
| 0 | Worker App start: the first `GET /bench/ping` after "Ready", less a warm one | the Worker's App composed and started (its isolate's script already evaluated) |
| 1 | a fresh `memory:space:<n>` key's first `memory-sql.list`, `--fresh` times, then the same key again | a cold object in a warm isolate, its owners warm: its App's compose and start, plus the RPC |
| 2 | after a restart, each fixed owner's first call, in series: `settings-store.read`, `credentials-do.read`, `provider-failover.sync`, `admin-api.list` (now `conversations-directory.list` of `conversations-directory:index`: admin-api's index is gone; the results below are admin-api's), `projects-sql.locate`, `tool-mcp-oauth.list`, `approvals-sql.list`; then all again warm | the cascades: which owners a start wakes, one after the other |
| 3 | after a restart, a fresh conversation's first `POST /v1/messages` to `faux/scripted`; then `--conversations` more, owners warm | a conversation object's start, with the owners cold and warm |

**Objects** is how many objects printed their start line before the answer came back: on the
step's critical path (the notes list them, in the order their starts finished, so a start that
waited for another's comes after it; `?` is a key the bench did not name, a conversation's). Starts
after the answer (an alarm the start set) are in the JSON (`after`), not in the table.

**Modelled** is computed from the counts, not injected: the raw time plus `--model-ms` per object
started on the path (LATENCY.md's model of production in neural-agents, where an object start is
about 0.4 to 0.6 s). It assumes those starts were in series, which the notes show they mostly are.

On local workerd the Worker and every object share one isolate, so a cold object pays no script
start there; in production an object may land in a new isolate and pay both (the note's open
question, answered only by an instrumented deploy). Under object composition the host's line says
which (`isolate: new | warm`), and the notes print each started object's fields (`kind`,
`components`, `composeMs`, `startMs`, medians over scenario 1's fresh objects, and each owner's own).

## Baseline: feat/projects

Measured 2026-11-19 on an Apple M3 (8 cores), macOS 27.0.1, Bun 1.4.2, wrangler 4.143.0, default
options; `base` is `feat/projects` at `dc24d41d`, `head` the design branch at `657118df`, the same
code (`agent/kit-object-compose` adds only the design note), so their difference is the noise:
about ±20 % on a single cold step, less on medians of many.

| Measurement | base ms | objects | modelled (+400/object) | head ms | objects | modelled (+400/object) |
|---|---:|---:|---:|---:|---:|---:|
| 0. script start (bundle evaluated, cold isolate) | 45 |  |  | 48 |  |  |
| 0. Worker App start (first request, less a warm one) | 16 |  |  | 18 |  |  |
|    HTTP round trip (warm ping) | 1.2 |  |  | 1.4 |  |  |
| 1. fresh owner key, first call (memory:space:…) | 19 (p90 24) | 1 | 419 | 22 (p90 36) | 1 | 422 |
| 1. same key, second call (warm) | 3.1 | 0 | 3.1 | 4.3 | 0 | 4.3 |
| 2. settings-store:settings cold | 42 | 3 | 1242 | 54 | 3 | 1254 |
| 2. credentials-do cold | 3.7 | 0 | 3.7 | 3.6 | 0 | 3.6 |
| 2. provider-failover:cooldowns cold | 5.9 | 0 | 5.9 | 3.2 | 0 | 3.2 |
| 2. admin-api:index cold | 15 | 1 | 415 | 15 | 1 | 415 |
| 2. projects:index cold | 20 | 1 | 420 | 21 | 1 | 421 |
| 2. tool-mcp-oauth cold | 22 | 1 | 422 | 17 | 1 | 417 |
| 2. approvals-sql:approvals cold | 19 | 1 | 419 | 14 | 1 | 414 |
| 2. the owners in series, cold (total) | 127 | 7 | 2927 | 129 | 7 | 2929 |
| 2. the owners in series, warm (total) | 23 | 0 | 23 | 31 | 0 | 31 |
| 3. fresh conversation, owners cold | 105 | 5 | 2105 | 132 | 5 | 2132 |
| 3. fresh conversation, owners warm | 37 (p90 50) | 1 | 437 | 42 (p90 49) | 1 | 442 |

Started on the path (the same on both sides):

- `settings-store:settings` cold: credentials-do, settings-store:settings, provider-failover:cooldowns.
  Its start awaits runtime-pi's credential reads (credentials-do) and sends provider-failover's first
  sync (the cooldowns, not awaited, but started before the answer): the one-purpose settings object
  costs three starts, as LATENCY.md's 930 ms (modelled) said, here with the cooldowns too.
- every other owner: only itself, because credentials-do and the cooldowns are warm by then (each
  start still calls both: warm calls, a few ms).
- a cold conversation: credentials-do, provider-failover:cooldowns, the conversation, then
  settings-store:settings and admin-api:index (the admission's settings read, admin-api's backfill
  `seen`, awaited in the conversation's start).

What it says, locally:

- **An object's App start is small and the script start is not paid per object.** A fresh owner
  object costs about 16 to 19 ms over a warm call (19 to 22 less 3 to 4), for a 32-component App
  started with its two warm calls; evaluating the bundle is about 45 to 50 ms, once per isolate. The
  Worker's App, a few components, about 16 ms on its first request.
- **What a cold path costs is the number of objects on it**: 3 for the settings object, 5 for a
  conversation with the owners cold, 7 for the owners in series. In the model (0.4 s an object) that
  is 1.2 s, 2.1 s and 2.9 s, against raw times of 40 to 130 ms: the objects started, not their local
  work, are what object composition must reduce (no calls to other objects during a start; 1 object
  for settings-store:settings and each owner).

## Comparing with object composition (T1 and after)

1. Run `bun scripts/bench-object-start.ts --base feat/projects --head <the T1 checkout>` (or, once
   merged, from the merged checkout with `--base feat/projects`).
2. Read: the objects column (settings-store:settings should go from 3 to 1 only once its owner
   declares a kind and runtime-pi and provider-failover stop reading at start, phases 1 and 2), the
   notes' line fields (`components` of a kind's object: 3 for `memory:` once memory-sql declares it,
   T10; `kind none` for every key until its owner declares), and scenario 1's time.
3. Replace the table above with the new one, or add it under its own heading with the revisions, the
   machine and the date (T15).
