# runtime-pi

The agent runtime: Pi runs your agents, and this component plugs it into the app.

- **Provides:** `agent.runtime`.
- **Requires:** `sessions.store` (where each conversation's Pi session lives).
- **Uses:**
  - `agent.definition`: your agents, one per name;
  - `model.provider`: the providers your agents name as `provider/modelId`;
  - `agent.tool`: the installed tools (`tool-read`, `tool-bash`…) that your agents name in their
    `tools`;
  - `model.credentials`, if installed: where the providers' credentials live (API keys, OAuth
    tokens). pi-ai refreshes OAuth tokens and writes them back there. Without it, providers read
    only their environment variables (`ANTHROPIC_API_KEY`).

  It refuses to start without an agent, when an agent names a model that no provider has, when an
  agent names a tool that no component provides, or when an agent's provider has no credentials at
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

## Pi extensions

Existing Pi extensions run unmodified, except for their terminal UI: `ctx.hasUI` is `false`,
and `ctx.ui.*` does nothing. List them where you compose the app:

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

Each conversation loads the extensions when it opens. What pikit supports is listed in
SPEC §6.2b; anything else logs a warning and does nothing.

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

## Tests

`runtime-pi.test.ts` is copied with the component and runs in your project. It uses a scripted model
from `@pikit/pi-adapter/testing`, so it needs no API key. It covers:
- the `agent.runtime` conformance suite, including a worker killed mid-run;
- the lifecycle conformance suite;
- the start failures above, and a stored credential reaching the provider.

`component.json` is generated from `setup` by the CLI (`pikit registry validate`) and is not written by
hand. Until the CLI exists, the test "what setup declares" pins it.
