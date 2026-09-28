# runtime-pi

The agent runtime: Pi runs your agents, and this component plugs it into the app.

- **Provides:** `agent.runtime`.
- **Requires:** `sessions.store` (where each conversation's Pi session lives).
- **Uses:**
  - `agent.definition`: your agents, one per name;
  - `model.provider`: the providers your agents name as `provider/modelId`;
  - `agent.tool`: the installed tools (`tool-read`, `tool-bash`…) that your agents name in their
    `tools`;
  - `agent.extension`: the installed Pi extensions that your agents name in their `extensions`;
  - `model.credentials`, if installed: where the providers' credentials live (API keys, OAuth
    tokens). pi-ai refreshes OAuth tokens and writes them back there. Without it, providers read
    only their environment variables (`ANTHROPIC_API_KEY`);
  - `agent.submissions`, if installed (`submissions-sql`, which `pikit add runtime-pi` offers): where
    each admitted message and each run's end are recorded ("Nothing admitted goes unanswered" below).

  It refuses to start without an agent, when an agent names a model that no provider has, when an
  agent names a tool or an extension that no component provides, or when an agent's provider has no credentials at
  all. That last check makes no network call and
  refreshes nothing: it only asks whether a credential is stored or an environment variable is
  set.
- **Target:** `server`. Cloudflare comes in M4, when Durable Object alarms drive runs.
- **Installs to:** `src/pikit/runtime-pi/`.
- **npm dependencies:** `@pikit/pi-adapter`, which is pinned with Pi.

## What it does

A message goes in with `dispatch`. Once the message is durable in its conversation's session,
`dispatch` resolves with the admission:
- `started`: the conversation was idle and a run began;
- `queued`: the conversation was busy, and the run in progress takes the message as a steer;
- `duplicate`: the message was already there.

The answer arrives as the `agent.settled` event, or `agent.failed` if the run failed. The event
fires even when nobody is waiting: after the caller went away, or after a crash, when the next
process resumes the run. Its `requestIds` lists every message the run answered: the one that
started it and each one queued into it.

`abort()` stops the active run. Any message queued in it is withdrawn and stays a duplicate.

Duplicates are found in the conversation's inbox and in its last 1000 messages. A platform
redelivers within minutes, so a redelivery older than 1000 messages is not expected; one that
arrives anyway runs as a new message.

Each agent names its model as `provider/modelId`, so different agents can use different
providers. Install one `model.provider` component per provider.

A conversation's session is open only while a run is being driven. Stopping the app leaves
unfinished runs open in their sessions, and the next process resumes them.

## Nothing admitted goes unanswered

With `agent.submissions` installed (`submissions-sql`):
- `dispatch` records each message once Pi holds it and before it resolves, so a channel tells its
  platform "received" only once both hold it;
- every run's end is recorded before its `agent.settled` / `agent.failed` (a failed record is tried
  again in the background), and a message `abort()` withdrew is recorded as aborted;
- **at start**, in the background, the conversations holding a message nobody answered are resumed,
  four at a time (`RESUME_AT_ONCE` in `resume.ts`): a run the last process left open continues, a
  message waiting in Pi's inbox gets a run, and a run that ended without its end being recorded is
  settled from the session and announced. Start does not wait for them; stop cancels what has not
  started. Progress and failures are logged.
- a message nothing can answer is **abandoned**: settled unanswered (`failed`, code `abandoned`) and
  announced as `agent.failed`, so its channel asks the user to send it again, instead of being retried
  at every start. At once when its conversation's agent is no longer defined (`agent_removed`) or its
  session is gone (`session_missing`); and when, after resuming, it is still unanswered and its
  conversation's oldest pending message is older than `abandonPendingAfterHours` (default 72, at
  least 1; `unanswered_too_long`). Each abandon is logged.

```json
"runtime-pi": { "abandonPendingAfterHours": 72 }
```

Channels deliver from its `answers` feed, so an answer that ends while they are stopped (a deploy) is
delivered when they start again. Without it, a run the last process left open waits for the next
message to its conversation, and an answer that ends while its channel is stopped stays in the session.

## Pi extensions

A Pi extension that uses only what pikit promises (tier A in SPEC §6.2b: tool policy, the run's
lifecycle and notifications, its own tools) runs unmodified. Its terminal UI is inert: `ctx.hasUI`
is `false`, and `ctx.ui.*` does nothing. `pikit doctor` fails on an import pikit does not provide,
and notes anything else an extension uses that never fires or does nothing here.

An agent names the extensions it uses, as it names its tools. A component of yours installs each
one under its name, as `agent.extension`:

```ts
// src/extensions/permission-gate.ts
import { defineComponent } from "@pikit/core";
import permissionGate from "../../extensions/permission-gate.ts";

export default defineComponent({
  name: "permission-gate",
  setup(pikit) {
    pikit.provideKeyed("agent.extension", "permission-gate", permissionGate);
  },
});
```

```ts
// src/agents/coder/agent.ts
import { defineAgent } from "@pikit/contracts";

export default defineAgent({ name: "coder", model: "anthropic/claude-sonnet", tools: ["bash"], extensions: ["permission-gate"] });
```

Only the conversations of `coder` load it; an agent that does not name it never sees it.

An extension for every agent goes where you compose the app instead:

```ts
import { createRuntimePi } from "./src/pikit/runtime-pi";
import permissionGate from "./extensions/permission-gate.ts";

const runtimePi = createRuntimePi({ extensions: [permissionGate] });
```

They import `@earendil-works/pi-coding-agent`. Your project installs `@pikit/pi-extension-shim`
under that name, so the import resolves without the coding agent itself:

```json
"@earendil-works/pi-coding-agent": "npm:@pikit/pi-extension-shim@…"
```

Each conversation loads the extensions when it opens: those given to `createRuntimePi` first, then
the ones its agent names, in that order, each once. What pikit supports is listed in SPEC §6.2b;
anything else logs a warning and does nothing.

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
of your own. Installing `tool-bash` gives no agent a shell until one of them names `bash`.

## Agents that change with the conversation

An agent can keep a JSON state per conversation and choose its model, system prompt and tools
for each run from it (SPEC §6.2a):

```ts
defineAgent({
  name: "release",
  model: "anthropic/claude-sonnet-4-6",
  tools: ["read", advance],
  state: { phase: "testing" },
  prepare: (state) => (state.phase === "deploying" ? { tools: ["read", "bash", advance] } : {}),
});
```

`prepare` runs before every run, with the conversation's state as it is then; what it leaves out
keeps the static value. A tool changes the state of the conversation it runs in through its context:
`await context.value(AGENT_STATE)?.update({ phase: "deploying" }, context)`. The state lives in the
conversation's Pi session: it survives restarts and starts again from `state` after a reset.

Tool names that only `prepare` returns cannot be checked at start. If `prepare` throws, or names a
tool or a model nothing provides, that run gets the static definition and the error is logged.

## Tests

`runtime-pi.test.ts` is copied with the component and runs in your project. It uses a scripted model
from `@pikit/pi-adapter/testing`, so it needs no API key. It covers:
- the `agent.runtime` conformance suite, including a worker killed mid-run, with and without
  `agent.submissions`;
- the lifecycle conformance suite, with and without it;
- a run killed mid-way resumed at start, with no new message, from what `agent.submissions` holds;
- the start failures above, and a stored credential reaching the provider;
- an agent whose `prepare` gives it a tool once another tool has moved its state on.

`component.json` is generated from `setup` by the CLI (`pikit registry validate`) and is not written by
hand. Until the CLI exists, the test "what setup declares" pins it.
