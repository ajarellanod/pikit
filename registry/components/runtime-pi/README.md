# runtime-pi

The agent runtime: Pi runs your agents (`@earendil-works/pi-durable` 1.0), and this component plugs
it into the app.

- **Provides:** `agent.runtime`, and `agent.conversations` (where `conversations.registry` creates the
  conversation of a new key, or of a reset).
- **Requires:** `storage.sql`: pi-durable keeps every conversation there (its transcript, its state,
  its runs and the messages it holds). On a server that is `storage-sqlite`, in a Cloudflare object
  `storage-do`. Its tables are pi-durable's (`conversations`, `entries`, `tasks`, `submissions`,
  `documents`…), unprefixed: one runtime per database.
- **Uses:**
  - `agent.definition`: the agents, one per name;
  - `model.provider`: the providers the agents name as `provider/modelId`;
  - `agent.tool`: the installed tools (`tool-read`, `tool-bash`…) the agents name in `tools`;
  - `execution` and `workspace`, if installed: where tools work. Each tool call gets its
    conversation's workspace when a `workspace` provider is installed (`workspace-local`: a directory
    per agent), otherwise `execution`;
  - `model.credentials`, if installed: where the providers' credentials live (API keys, OAuth tokens).
    pi-ai refreshes OAuth tokens and writes them back there. Without it, providers read only their
    environment variables (`ANTHROPIC_API_KEY`);
  - `agent.submissions`, if installed (`submissions-sql`, which `pikit add runtime-pi` offers): where
    each admitted message and each run's end are recorded ("Nothing admitted goes unanswered" below);
  - `wakeups`, if installed: runs are driven inside wakeups, in slices, instead of by promises left
    running, which is what a Durable Object needs ("Cloudflare" below). Without it, nothing changes.

  It refuses to start without an agent, when an agent names a model no provider has, when an agent
  names a tool no component provides, and when an agent's provider has no credentials at all. That
  last check makes no network call and refreshes nothing: it only asks whether a credential is stored
  or an environment variable set.
- **Target:** `server` and `cloudflare`. On Cloudflare it goes in the conversation object's App, with
  `platform-cloudflare` for `wakeups` ("Cloudflare" below).
- **Installs to:** `src/pikit/runtime-pi/`.
- **npm dependencies:** `@pikit/pi-adapter`, pinned with Pi.

## What it does

A message goes in with `dispatch`. Once the message is durable in pi-durable, `dispatch` resolves
with its admission:
- `started`: the conversation was idle and a run began;
- `queued`: a run is going. The message waits in the conversation's inbox, and every message queued
  while that run goes is taken together by the **next run**, which starts once the run in progress
  ends: its `agent.started` names the first of them, and its one answer (`agent.settled`) lists them
  all in `requestIds`, so a channel that replies per message replies to each;
- `duplicate`: the conversation already has this request (pi-durable deduplicates by request id, for
  as long as it keeps the conversation). Nothing runs.

`abort()` stops the active run. Any message queued behind it is withdrawn and stays a duplicate.

Each agent names its model as `provider/modelId`, so different agents can use different providers.
Install one `model.provider` component per provider.

pi-durable runs every conversation of the storage in one scheduler, opened at the first message (or
at start, with `wakeups`). Stopping the app leaves unfinished runs pending in the storage, and the
next process resumes them.

A conversation key points to a pi-durable conversation id (`ConversationRef.conversationId`). A
conversation made before pikit moved to pi-durable (a Pi 0.99 session id in the registry) starts a
new conversation at its next message (`conversations-file`, `conversations-kv`); a message such a
conversation had pending in `agent.submissions` is settled aborted at start, which no channel tells
the user about, rather than abandoned.

## Nothing admitted goes unanswered

With `agent.submissions` installed (`submissions-sql`):
- `dispatch` records the message once pi-durable holds it and before it resolves, so a channel tells
  its platform "received" only once both hold it;
- every run's end is recorded before its `agent.settled` / `agent.failed` (a failed record is tried
  again in the background), and a message `abort()` withdrew is recorded aborted;
- **at start**, in the background, the conversations holding a message nobody answered are resumed,
  four at a time (`RESUME_AT_ONCE` in `resume.ts`): a run the last process left open continues, a
  message waiting in the inbox gets a run, and a run that ended without its end recorded is settled
  from pi-durable and announced. Start does not wait for them; stop cancels what has not started.
  Progress and failures are logged. With `wakeups`, start asks for a wakeup instead, and its handler
  resumes them ("Cloudflare" below).
- a message nothing can answer is **abandoned**: settled unanswered (`failed`, code `abandoned`) and
  announced as `agent.failed`, so its channel asks the user to send it again, instead of being retried
  at every start. At once when the conversation's agent is no longer defined (`agent_removed`) or its
  conversation is gone (`conversation_missing`); and when, after resuming, it is still unanswered and
  its conversation's oldest pending message is older than `abandonPendingAfterHours`:

```json
"runtime-pi": { "abandonPendingAfterHours": 72 }
```

Channels deliver from its `answers` feed, so an answer that ends while they are stopped (a deploy) is
delivered when they start again. Without it, a run the last process left open waits for the next
message to its conversation, and an answer that ends while its channel is stopped stays in the
transcript.

## Cloudflare: runs driven by wakeups, in slices

A Durable Object keeps running only while an event is in progress (a request, an RPC, an alarm). A
promise left running after its event is killed when the object is evicted, 70 to 140 s after it went
idle, and waiting on an outbound `fetch` (a model call) does not keep it alive: measured, a 180 s run
was lost. So on Cloudflare (SPEC §4.1, C4) a run is driven inside an event: install a `wakeups`
provider (`platform-cloudflare`: the object's alarm, multiplexed) and `agent.submissions`
(`submissions-sql` over the object's SQL), and runtime-pi does the rest.

In an object's App (`WORKERS_HOST` has an `object`), the object is one chat: its first conversation is
pi-durable's root (later ones, after a reset, are ownerless), and pi-durable's clock is the app's
(workerd freezes `Date.now()` between I/O).

pikit's workerd lane runs it so in a real Durable Object (`tests/workerd/test/runtime-pi.workerd.ts`):
pi-durable on `storage-do`, a message sent from the Worker's App by RPC, its run driven in the
object's alarm until it answers; a run the object is evicted in the middle of, answered by the next
instance; a model error's backoff waited out with the object gone.

It registers the wakeup handler `runtime-pi.drive`, and asks for it whenever a run may be left going:
after a `dispatch` or a `resume` that leaves a run in the conversation (before `dispatch` resolves,
so a channel acknowledges its platform only once a wakeup will drive it), and at start when pi-durable
has work pending (or `agent.submissions` is installed). The handler:
1. opens pi-durable if this instance has not (a new instance after an eviction): what it finds resumes;
2. resumes the conversations `agent.submissions` holds pending that this App is not driving (a
   message it never answered: as at start, four at a time, abandoned after `abandonPendingAfterHours`);
3. waits until this App drives no run, or until its slice ends;
4. asks again at once when runs are still going. When what is left only waits for a time (a model
   retry's backoff, a deferred response's poll), the runtime asked for a wakeup at that time
   (`onIdleWithPendingWork` and `nextWakeAtOf` in `@pikit/pi-adapter`), and the handler closes
   pi-durable inside its event (`suspend`) so the object can be evicted until then; the wakeup opens
   it again and the wait continues from its checkpoint.

A request carries nothing: the handler reads what to do from pi-durable and `agent.submissions` each
time. So a handler that runs twice (delivery is at least once), late, or in a new object after an
eviction does the right thing. An object evicted mid-run is started again by its alarm, and the run
resumes from the storage under pi-durable's replay rules (a `safe` tool's interrupted call runs again;
an `unsafe` one's gives the model an interrupted result).

**How slices meet the budgets.** Each alarm is an invocation with its own budget, measured on the Free
plan: 30 s of CPU (waiting on the network does not count), 50 subrequests, 15 minutes of wall clock,
about 200 MB of memory. The slice deadline is the provider's (60 to 90 s on Cloudflare): a slice mostly
waits on the model, so its CPU stays far under 30 s; a few model and tool calls fit in 50
subrequests; and it ends long before 15 minutes. A long run is a sequence of short alarms, each with a
fresh budget. An alarm the platform cuts (a deploy) is retried, and the cut slice asked for the next
one already or runs again: either way the run continues from the storage.

**What still runs in memory, and why that is fine.** The run itself, while the handler waits for it
(the handler's alarm is the event that keeps the object alive); the events' listeners; and recording a
run's end again after `agent.submissions` failed to (1, 5, 30 and 120 s later). If the object is
evicted before such a retry, the request stays pending, and the next run of the handler (the next
message, at the latest) settles it from pi-durable and announces it. Without `agent.submissions`, the
handler keeps this App's runs alive, and pi-durable's own record of live work brings them back after
an eviction (at start, `nextWakeAt`).

## Pi extensions

Not supported: running unmodified Pi coding-agent extensions was dropped with the move to
`@earendil-works/pi-durable`, whose own extensions will replace it.

## Your agents

A component of your own provides your agents:

```ts
import { defineComponent } from "@pikit/core";
import support from "../agents/support/agent.ts";

export default defineComponent({
  name: "agents",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", support.name, support);
  },
});
```

## Tools

An agent gets the tools it names, and only those:

```ts
defineAgent({ name: "ops", model: "anthropic/claude-sonnet-4-6", tools: ["read", "bash", lookupTicket] })
```

A name (`"bash"`) is a tool that a `tool-*` component provides. An object (`lookupTicket`) is a tool
of your own: pi-durable's `defineTool` (from `@pikit/pi-adapter/tools`), with its `replay` (`"safe"`
runs it again when a run resumes after a crash; `"unsafe"`, the default, gives the model an
interrupted result). Installing `tool-bash` gives no agent a shell until one of them names `bash`.

A tool of your own that more than one agent names, or that needs a capability (a secret,
`execution`), is a `defineComponent` providing it as `agent.tool` under its name.

## Agents that change with the conversation

An agent can keep a JSON state per conversation and choose its model, system prompt and tools from it
(`agent.state`, @pikit/contracts' agent-state.ts):

```ts
defineAgent({
  name: "release",
  model: "anthropic/claude-sonnet-4-6",
  tools: ["read", advance],
  state: { phase: "testing" },
  prepare: (state) => (state.phase === "deploying" ? { tools: ["read", "bash", advance] } : {}),
});
```

`prepare` gives the conversation's agent for its state as it is then; what it leaves out keeps the
static value. It runs where its inputs change (when a message is admitted, with every state update,
and when pi-durable reopens), so the agent of each model request is always `prepare` of the state at
that moment: **a tool's state update applies from the run's next model request**, not from the next
run. A tool changes the state of the conversation it runs in through its context:
`await context.value(AGENT_STATE)?.update({ phase: "deploying" }, context)`. The state lives in the
conversation (a pi-durable document): it survives restarts and starts again from `state` after a reset.

Tool names only `prepare` returns cannot be checked at start. If `prepare` throws, or names a tool or a
model nothing provides, the conversation gets the static definition and the error is logged.

## Tests

`runtime-pi.test.ts` is copied with the component and runs in your project. It uses the scripted
model from `@pikit/pi-adapter/testing`, so it needs no API key. It covers:
- the `agent.runtime` conformance suite (queued messages batched into the next run, a worker that died
  mid-run), with and without `agent.submissions` and `wakeups`;
- the lifecycle conformance suite, the same ways;
- a run that died mid-way resumed at start, with no new message, when `agent.submissions` holds it;
- `wakeups`: a run that died mid-way completed by the next App's wakeup; a long run driven over
  several slices, each cut asking again at once; a model retry's backoff as a wakeup at its time, with
  pi-durable suspended meanwhile; stop cancelling a waiting handler, which asks again;
- the start failures above, and a stored credential reaching the provider;
- an agent whose `prepare` gives it a tool once another tool moved its state on.

`component.json` is generated from `setup` by the CLI (`pikit registry validate`) and is not written
by hand. Until the CLI exists, the test "what setup declares" pins it.
