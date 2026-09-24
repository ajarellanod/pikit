# runtime-pi

The agent runtime: Pi runs your agents, and this component plugs it into the app.

- **Provides:** `agent.runtime`.
- **Requires:** `sessions.store` (where each conversation's Pi session lives).
- **Uses:**
  - `agent.definition`: your agents, one per name;
  - `model.provider`: the providers your agents name as `provider/modelId`.

  It refuses to start without an agent, or when an agent names a model that no provider has.
- **Target:** `server`. Cloudflare comes in M4, when Durable Object alarms drive runs.
- **Installs to:** `src/pikit/runtime/pi/`.
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

A conversation's session is open only while a run is being driven. Stopping the app leaves
unfinished runs open in their sessions, and the next process resumes them.

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

## Tests

`runtime-pi.test.ts` is copied with the component and runs in your project. It uses a scripted model
from `@pikit/pi-adapter/testing`, so it needs no API key. It covers:
- the `agent.runtime` conformance suite, including a worker killed mid-run;
- the lifecycle conformance suite;
- the start failures above.

`component.json` is generated from `setup` by the CLI (`pikit registry validate`) and is not written by
hand. Until the CLI exists, the test "what setup declares" pins it.
