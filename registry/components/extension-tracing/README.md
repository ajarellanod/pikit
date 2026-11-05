# extension-tracing

Traces of your agents' runs in Langfuse or any OpenTelemetry collector: each run of an agent that
names the extension `tracing` is exported as an OpenTelemetry trace (the run, each model request, each
tool call, with tokens, costs and errors), over OTLP/HTTP JSON with plain `fetch`. No OpenTelemetry
SDK (it pulls Node modules and weighs on a Worker's bundle). See
[features/tracing.md](https://github.com/ajarellanod/pikit/blob/main/features/tracing.md).

- **Provides:** `agent.extension`, under the key `tracing` (hooks only: no section, no tool).
- **Uses:** `secrets`, if installed (the collector's credentials, by name; required when config names
  one); `health`, if installed (degraded when the collector did not take a batch).
- **Targets:** `server` and `durable`: plain code over `fetch` and Web Crypto. On `durable` each
  conversation's object traces its own runs and sends its own batches.
- **Installs to:** `src/pikit/extension-tracing/` (`index.ts`, `otlp.ts`, `extension-tracing.test.ts`).

## Use it

```sh
pikit add extension-tracing
```

**Langfuse** (Cloud or self-hosted): its OTLP endpoint, Basic auth with the project's public and
secret keys, kept as secrets (`.env` on a server, the Worker's secrets on Cloudflare):

```ts
export const config = {
  "extension-tracing": {
    endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces", // or https://us.cloud.langfuse.com/..., your host
    basicAuth: { username: "LANGFUSE_PUBLIC_KEY", password: "LANGFUSE_SECRET_KEY" }, // secret names
  },
};
```

**Any OTLP collector** (an OpenTelemetry Collector, Grafana Tempo, Honeycomb, Jaeger…): its traces
endpoint, and each header that carries a credential named by the secret that holds its value:

```ts
export const config = {
  "extension-tracing": {
    endpoint: "http://otel-collector:4318/v1/traces",
    headers: { "x-honeycomb-team": "HONEYCOMB_API_KEY" }, // header name: secret name
    serviceName: "support-bot",                            // resource service.name; default "pikit"
  },
};
```

Then name it in the agents to trace (`src/agents/<agent>/agent.ts`); the others are not traced:

```ts
defineAgent({ name: "support", model: "…", tools: ["bash"], extensions: ["tracing"] })
```

Other settings: `captureContent` (default `false`, see Privacy), `redact` (more secret names whose
values are removed from captured content), `maxSpans` (finished spans held at most while unsent,
default 2,000).

## What is exported

One trace per run; its trace id is derived from the conversation id and the run's first request id.
Spans follow OpenTelemetry's GenAI conventions:

| Span | From, to | Attributes |
|---|---|---|
| `invoke_agent <agent>` (the root) | `agent.started` to `agent.settled` / `agent.failed` | `gen_ai.operation.name`, `gen_ai.agent.name`, `pikit.conversation.key`, `pikit.conversation.id`, `pikit.request.id`, `pikit.request.ids`, `pikit.run.kind`, `pikit.run.resumed`, the run's totals `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_creation.input_tokens`, `gen_ai.usage.cost`; `error.type` (the error's code) and an error status for a failed run |
| `chat <model>` (client), a child of the root | `beforeRequest` to `afterResponse`, one per request attempt (a retry is another span) | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, the request's tokens and cost; `error.type` and an error status when it ended in `error` or `aborted` |
| `execute_tool <name>`, a child of the root (a nested call: of the call that made it) | `beforeTool` to `afterTool` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`; `error.type: tool_error` for the tool's error result; for an error result pi-durable wrote itself (it runs `afterTool` on those too), its diagnostic code: `blocked` (by a hook), `invalid_arguments`, `tool_unavailable`, `interrupted`, `aborted`, `abandoned`, `restart_limit`; `error.type: not_run` for a call whose `afterTool` never came (past pi-durable's restart limit), ended at its round's end |

Every span also carries `session.id` and `langfuse.session.id` (the conversation key: a chat is a
Langfuse session), `user.id` and `langfuse.user.id` (the sender of the run's first message,
`<channel>:<id>` as the channel authenticated them, when there is one), `gen_ai.agent.name` and
`gen_ai.conversation.id`. Langfuse reads the `chat` spans as generations, with their model, tokens and
cost.

## Privacy

By default **no prompt, answer, tool argument or result** leaves the App: identifiers, names, token
counts, costs, finish reasons and error codes only (an error's message is not sent: a provider's may
quote the request).

`captureContent: true` adds `gen_ai.input.messages` (what each model request brings that the one before
did not: the prompt, tool results), `gen_ai.output.messages` (the answer, its tool calls),
`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, the run's first input and final answer on the
root, and redacted error messages. Each is first redacted: the values of every secret config names
(`headers`, `basicAuth`, `redact`) removed; `Bearer`/`Basic`/`Token` credentials and words shaped like
a known credential (`sk-…`, `ghp_…`, `xox…-`, JWTs, bot tokens, AWS and Google keys: the check
`@pikit/contracts`' `credentialSettingProblem` makes, as memory-summaries does) replaced by
`[redacted]`. Then each attribute is capped at 4 KB, and images are dropped. Redaction removes what it
recognizes: a password typed in prose is not one of them.

## Delivery and limits

- **One POST per run.** Finished spans are buffered in memory and sent when a run ends, with any other
  run's spans finished meanwhile; a run with 200 spans before its end sends them early. On
  Cloudflare's Free plan that is about one subrequest of the alarm's 50 per run.
- **Never in the run's way.** The POST is not awaited by the run's event (the answer is delivered
  without waiting for it), has 5 s, and is tried once more after a network error, a 429 or a 5xx (a
  4xx is not). Then the batch is dropped, a warning is logged with the number of spans and the reason
  (no payload, no header), and `health` says `degraded` until a batch is taken. Every hook catches its
  own failures: tracing never blocks a call nor fails a run.
- **A buffer cap.** Past `maxSpans` unsent spans, the oldest are dropped, and that is logged.
- **Resumed runs.** A run resumed by another instance (a restart, an eviction) keeps its trace id and
  its root span's id, so spans sent before and after hang under one run. The root then starts when
  the instance that ends it saw the run (`pikit.run.resumed: true`). A tool call's start is kept in
  its tool task's durable memo (pi-durable's `api.memo`, one write per call): a call that outlives an
  eviction keeps the start the first instance wrote. A model request's start is in memory: an evicted
  request is sent again, as a new span.
- **Lost, by design.** The spans an instance buffered when it is evicted or killed (spans sent early
  or at a stop are not). On Cloudflare the object outlives a POST it started after its event, as a
  rule; an eviction during that POST loses the batch. A run that fails before its first model request
  is not traced (no hook saw it). A call interrupted by an eviction and not run again has no span.
- **Extension order does not matter**: a call another extension's `beforeTool` blocks still gets its
  `blocked` span, started at the model's response when this `beforeTool` did not see it.

## Tests

- `extension-tracing.test.ts` (copied into your project): what `setup` declares, config refused (no
  endpoint, a secret's value instead of its name, a secret named without a `secrets` provider), the
  derived ids, OTLP's JSON, redaction, the 4 KB cap, images dropped.
- `app.test.ts` (in the registry only: it imports runtime-pi) runs it in a real App with runtime-pi on
  a SQLite file, the scripted faux model and a fake collector (`fetch`): a run is one batch whose
  spans share one trace and hang under the run's span, with Basic auth from `secrets`; no content by
  default; with `captureContent`, a named secret's value, a Bearer token, `ghp_`, a JWT and `sk-` are
  redacted and each attribute is at most 4 KB; a blocked call is an error span whichever the
  extensions' order; a run resumed by the next App keeps its trace id and run span; a collector that
  answers 500 is tried once more, a dropped batch is a warning without payload and `health` degraded,
  the run's answer unchanged (a network error and a 400, not retried, too); `maxSpans` drops the
  oldest; one POST per run, and one more at 200 spans; an agent that does not name it sends nothing.
  Each guarantee was checked to fail on a broken component (contract rule 7): parent links, the
  not-run span, a random trace id, content always on, each redaction removed, no retry, no cap, one
  POST per span, no early flush, untraced runs exported, no attribute cap.
- The workerd lane (`tests/workerd/test/tracing.workerd.ts`): in a conversation's Durable Object, a
  run is one batch to a collector behind the isolate's `fetch`; a run evicted between two alarms is
  ended by the next instance with the derived trace id, under the same run span, its tool call's
  start read from the memo the first instance wrote (checked to fail without the memo).
- Not covered: a real Langfuse or collector (checked against fakes only); a POST cut by an eviction.
