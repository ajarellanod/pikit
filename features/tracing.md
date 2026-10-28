# Tracing: each run as an OpenTelemetry trace, in Langfuse or any collector

**Public appeal:** — (an operator sees what an agent did, step by step: which model was asked, how
long it took, what it cost, which tool failed; in Langfuse, the observability tool many teams of agents
already use, or in their own OpenTelemetry backend)

**Status:** built (`extension-tracing`, both targets), as planned (owner's decisions: opt-in per agent,
content off by default). Checked against fake collectors (bun and the workerd lane), not yet against a
real Langfuse project; it moves to `completed/` once it is.

**Needed by:** nothing required. It fills [team agents](team-agents.md)' row "Tracing (Langfuse,
OpenTelemetry)". Builds on `agent.extension` (pi-durable's hooks), the App's run events, `secrets` and
`health`; runs on `server` and `durable` (celld, Cloudflare).

## What it gives
Each run of an agent that names the extension `tracing` is exported as one OpenTelemetry trace over
OTLP/HTTP JSON: Langfuse at `<host>/api/public/otel/v1/traces` with Basic auth (its public and secret
keys), or any OTLP collector with its endpoint and headers. Credentials are secrets, named in config.

```ts
"extension-tracing": {
  endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
  basicAuth: { username: "LANGFUSE_PUBLIC_KEY", password: "LANGFUSE_SECRET_KEY" },
}
// src/agents/support/agent.ts
defineAgent({ name: "support", model: "…", extensions: ["tracing"] })
```

The spans (OpenTelemetry's GenAI conventions): `invoke_agent <agent>` for the run (agent, conversation
key and id, request ids, token and cost totals, error code), `chat <model>` per model request attempt
(provider, model, input, output and cache tokens, finish reason, error type), `execute_tool <name>` per
tool call (call id, error type), with parent links. The Langfuse session is the conversation key, the
user the sender of the run's first message. The component's
[README](../registry/components/extension-tracing/README.md) lists every attribute.

## Where it is
- The component: `registry/components/extension-tracing/` (`index.ts`: the extension, the event
  listeners, the buffer and the sends; `otlp.ts`: ids, OTLP JSON, redaction and the cap).
- Tests: `extension-tracing.test.ts` (copied), `app.test.ts` (registry only),
  `tests/workerd/test/tracing.workerd.ts`; listed in the README, each guarantee checked to fail on a
  broken component.

## Decisions
1. **Plain `fetch`, no OpenTelemetry SDK.** The SDK pulls Node modules and weighs on a Worker's bundle
   (SPEC §4's budgets). OTLP/HTTP JSON is a small, stable shape: `otlp.ts` writes it (hex ids,
   nanosecond strings, typed attributes, an error status).
2. **One component, both halves.** The hooks (`beforeRequest`, `afterResponse`, `afterTools` of the
   generation task; `beforeTool`, `afterTool` of the tool task) and the App's events (`agent.started`,
   `agent.settled`, `agent.failed`) are registered by the same component and share its memory: one App
   on a server, one conversation's object on `durable`, where both run in the object. The hooks are
   pi-durable's, imported from `@pikit/pi-adapter/extensions` (contract rule 2); no contract changed.
3. **Opt-in per agent** (owner's decision): only the agents that name `tracing` are traced, as with
   every extension. A run is traced once one of its hooks saw it, so the events of other agents' runs
   send nothing.
4. **Which run a hook is in**: its context's `CONVERSATION` and the first of `RUN_REQUESTS` (the request
   that started the run, the one `agent.started` names). Read at each hook: a SQL read in the
   conversation's storage, no subrequest.
5. **Resumed runs keep their trace.** The trace id is SHA-256 of the conversation id and the first
   request id, cut to 16 bytes; the run span's id the same way, cut to 8; a tool call's span id from its
   call id. The instance that resumes a run (after a restart, after an eviction) continues the same
   trace, under the same run span, and a nested call finds its parent's span. What pi-durable 1.3.0's
   `HookApi` gives: `taskId`, `conversationId`, `models`, document reads and the asking task's `memo`
   (first write wins, committed with the task, gone once the task's outcome is decided). A tool call's
   start goes in its tool task's memo in `beforeTool` (one durable write per call), and `afterTool`, in
   whichever instance runs it, reads it back; a model request's start stays in memory (an evicted
   request is sent again, as a new span). The run span's start is when the ending instance first saw the
   run (`pikit.run.resumed` says so): no durable write per run.
6. **A call that never ran is still a span.** `afterTool` does not run for a call a hook blocked, whose
   arguments were refused or whose tool is unavailable, and an earlier extension's block skips later
   `beforeTool`s. So `afterResponse` notes the calls the model asked for, and the round's `afterTools`
   ends those with no `afterTool` as `not_run` errors: independent of the extensions' order.
7. **Privacy** (owner's decision: content off by default). Without `captureContent`, only identifiers,
   names, counts, costs, finish reasons and error codes are exported. With it, prompts, answers, tool
   arguments and results, redacted (the secrets config names, `Bearer …`, known credential shapes:
   `@pikit/contracts`' check, as memory-summaries' `redact`), each attribute capped at 4 KB, images
   dropped.
8. **Batching**: one POST per run (at its end, with any other run's finished spans), early at 200
   spans; a buffer cap (`maxSpans`) that drops the oldest; 5 s per POST, one retry after a network
   error, a 429 or a 5xx, then the batch is dropped with a warning (no payload) and `health` degraded.
   On Cloudflare's Free plan a run costs about one of an alarm's 50 subrequests.
9. **The POST never holds the run's event.** Listeners of `agent.settled` run in order and the answer's
   delivery listens there too: awaiting a collector (up to 10 s) would delay answers. The send is
   started and tracked; `stop` waits for it. On Cloudflare the object outlives such a POST as a rule
   (an object is evicted after tens of seconds idle); an eviction during it loses the batch.

## How it fits pikit
- **An agent extension component**, like extension-house-rules and extension-approvals, with event
  listeners like log-events. It needs no capability; `secrets` and `health` are optional.
- **Server**: one App holds every conversation: one buffer, one send chain.
- **Durable**: each conversation's object has its own App, buffer and sends; the POST is a subrequest
  of the object's alarm or RPC that ended the run.

## Pi first
pi-durable has hooks on model requests and tool calls and a durable memo per task, which is all this
needs; it has no tracer of its own. Pi's coding agent's OpenTelemetry support is the SDK's, which a
Worker does not want (decision 1).

## Guarantees and tests
- A run is one batch: its spans share one trace and hang under the run's span; Basic auth from
  `secrets`.
- A blocked call's span is an error, whichever the extensions' order.
- A run resumed by the next App, or by the next instance of an evicted object, keeps its trace id and
  run span; a tool call that outlives an eviction keeps its first start (workerd).
- No content by default; with `captureContent`, secrets' values and token shapes are redacted and each
  attribute is at most 4 KB.
- A failing collector never changes the run's answer: one retry, then a warning without payload and
  `health` degraded.
- The buffer cap drops the oldest; one POST per run, plus one per 200 spans.
- An agent that does not name the extension sends nothing.
- Not covered: a real Langfuse or collector; a POST cut by an eviction.

## Open questions
- **Sampling**: every run of a traced agent is sent. A ratio or a rule (failed runs only) is a config
  field when someone needs it.
- **Spans lost at eviction**: a run's buffered spans could be kept in the conversation's storage until
  sent, at the cost of a write per span; not done (accepted loss).
- **A run's true start after a resume**: a memo of the generation task holds a request's start, not
  the run's; a run-level durable record would need a write per run.
- **Metrics** (`/metrics`, OTLP metrics) and logs over OTLP are other components.
- **Delegated runs**: a child conversation's run is a trace of its own (its own first request); linking
  it to the parent's tool span (a span link from `delegate`) is open.
