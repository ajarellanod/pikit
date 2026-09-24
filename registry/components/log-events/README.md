# log-events

One structured log line per operational event: what reached which agent, how each run ended, how
long it took and what it cost.

- **Provides:** nothing. It listens to `agent.*`, `conversation.reset`, `pipeline.halted` and
  `runtime.*`.
- **Uses:** nothing. It writes through the app's logger (`ctx.logger`).
- **Targets:** `server` and `cloudflare`.
- **Installs to:** `src/pikit/log-events/`.
- **npm dependencies:** none.

## What it logs

The event's name is the line's message. The fields:

| Event | Level | Fields |
|---|---|---|
| `agent.dispatched` | info | `conversation`, `agent`, `session`, `requestId`, `admission` (`started`, `queued`, `duplicate`) |
| `agent.started` | info | `conversation`, `agent`, `session`, `requestId`, `resumed` |
| `agent.settled` | info (`warn` when aborted) | `conversation`, `agent`, `session`, `requestId`, `requestIds`, `run` (`completed`, `aborted`), `messages`, `durationMs`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `cost` |
| `agent.failed` | error | the same, with `run: "failed"` and `errorCode` |
| `conversation.reset` | info | `conversation`, `agent`, `session` (the new one), `previousSession` |
| `pipeline.halted` | info | `pipeline`, `stage`, `reason` |
| `runtime.starting` / `ready` / `stopping` / `stopped` | info | none |

With a JSON-lines logger (as in a container) a run's end looks like this; the names of the level
and message keys are the logger's:

```json
{"level":"info","msg":"agent.settled","conversation":"http:c1","agent":"assistant","session":"0199…","requestId":"m-42","requestIds":["m-42"],"run":"completed","messages":2,"durationMs":1840,"inputTokens":1200,"outputTokens":85,"cacheReadTokens":3400,"cacheWriteTokens":0,"totalTokens":4685,"cost":0.0071}
```

The format is the logger's: this component passes a message and fields, and the logger that the
deployment gives the app (the console, or `deployment-docker`'s JSON lines) prints them.

- **Tokens and cost** are the run's `usage` as the runtime reports it. With `runtime-pi` they are
  Pi's numbers, and `cost` is priced by pi-ai (US dollars) for the whole run, including failed
  attempts before a retry. A runtime that reports no usage leaves these fields out.
- **`durationMs`** runs from `agent.started` to the run's end, measured with the app's clock. The
  start times are kept in memory only, so a run that ends after a restart, in another worker, or
  after a Durable Object hibernated has no `durationMs`.
- **`requestIds`** lists every message the run answered: the one that started it, then the ones
  steered into it.

## What it never logs

No line carries the text of a message, a prompt, an answer or an error's message, and nothing
here reads a secret (SPEC §13). A failed run logs its `errorCode`, not its message, because a
provider's error message may quote the request. The fields are picked by name in `fields.ts`, so a
field added to an event later is not logged until someone adds it there.

A halt reason is logged as the stage wrote it. Keep message text out of your own `pikit.halt(...)`
reasons.

## Failures

Logging never fails the code that emitted the event: each listener catches its own errors, a
logger that throws included. A line that cannot be built becomes a warning naming the event and
the error's type, without its content.

To stop logging these events, remove the component. There is no switch.

## Tests

`log-events.test.ts` is copied with the component and runs in your project, without an agent
runtime: it emits the events a runtime would. It covers each event's line, the duration, a run
with no known start, the bound on the start times, usage of another shape, that no prompt, answer
or error message reaches a line, and that a failing logger or payload cannot fail the emitter.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
