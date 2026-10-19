# channel-http

Talk to an agent over HTTP: send a message, get the answer in the response.

- **Provides:** `http.route`: `POST /v1/messages`, `GET /v1/conversations/:id/messages/:messageId`
  and `POST /v1/conversations/:id/reset`. It also adds the stage `channel-http-bearer` to
  `http.authenticate`, and one to `conversation.describe`: who a conversation is with, for the
  dashboard: the client's conversation id, all the channel knows.
- **Requires:** `secrets` (the token), `conversations.registry`, `agent.runtime`. A server (such as
  `server-bun`, or deployment-cloudflare's Worker) serves the routes, and a router (such as
  `router-basic`) picks the agent. On Cloudflare its Worker half requires `secrets` and
  `actor.mailbox` (actors-do).
- **Uses, if installed:** `agent.submissions` (runtime-pi provides it): a message's outcome can be
  read later, and sending it again returns it. `actor.inbox` and `actor.mailbox`: where it runs
  (below).
- **Targets:** `server` and `durable` (Cloudflare). One code on both: in `start`, `actor.inbox`'s
  `scope` says where it runs ("On each target").
- **Installs to:** `src/pikit/channel-http/`; on Cloudflare, `pikit add` puts its Worker half
  (`channel-http-worker`, the export `worker`) in the Worker's App.
- **npm dependencies:** `typebox`.
- **Environment:** `PIKIT_HTTP_TOKEN` (secret, required, at least 16 characters; for example
  `openssl rand -hex 32`).

## The API

Every request needs `Authorization: Bearer <PIKIT_HTTP_TOKEN>`. Without it, or with a wrong token,
the answer is `401`.

### `POST /v1/messages`

```json
{ "conversationId": "c1", "text": "What changed yesterday?", "messageId": "m-42" }
```

- `conversationId`: your name for the conversation; 1 to 128 of `A-Z a-z 0-9 . _ ~ -`. Each one is
  its own conversation, with its own history.
- `text`: the message.
- `messageId` (optional): the message's identity; 1 to 128 of `A-Z a-z 0-9 . _ ~ : -`, never
  starting with `dashboard:` (the operator's messages, a `400`). It becomes the request id. Send the same `messageId` again to the same conversation and it does not run
  again. Without it, every POST is a new message.

The POST waits for the answer, up to `replyTimeoutMs` (120 s by default):

| Status | Body | When |
|---|---|---|
| `200` | `{ requestId, text }` | The agent answered. The parts of its answer (a question a tool asked) are in `text` too, after it, as their fallbacks. |
| `202` | `{ requestId }` | No answer in time, or the server is stopping. The answer still lands in the conversation. |
| `400` | `{ error: "invalid_request", message }` | The body is not a message. |
| `401` | `{ error: "unauthorized" }` | Missing or wrong token. |
| `403` | `{ requestId, error: "denied" \| "rejected", message? }` | The router denied it. |
| `409` | `{ requestId, error: "duplicate" }` | This `messageId` is already in the conversation, and nothing records its outcome. It does not run again. With `agent.submissions`, the POST answers with its outcome instead (`200`, `202` while it runs, `502`, `409 aborted`). |
| `409` | `{ requestId, error: "aborted" }` | The run was stopped before answering. |
| `422` | `{ requestId, error: "rejected", message }` | A stage of `inbound.normalize` refused it. |
| `500` | `{ requestId, error: "no_route" }` | No router decided. Install one. |
| `502` | `{ requestId, error: <code> }` | The run failed (for example, the model provider). |
| `503` | `{ requestId, error: "unavailable" }` | On Cloudflare only: the conversation's object could not be reached (a deploy reset it mid-request). The message may have been admitted: read it with `GET`, or send it again with the same `messageId`. |

**Messages sent while the agent is working are answered together by its next run.** Each waits in
the conversation's inbox; once the run in progress ends (its own POST gets its answer), the next run
takes them all, and its one answer goes to every one of their POSTs.

### `GET /v1/conversations/:id/messages/:messageId`

What became of a message, for a client whose POST answered `202` (the agent took longer than
`replyTimeoutMs`, or the server restarted):

| Status | Body | When |
|---|---|---|
| `200` | `{ requestId, text }` | The agent answered. |
| `202` | `{ requestId }` | Still running. |
| `409` | `{ requestId, error: "aborted" }` | The run was stopped before answering. |
| `502` | `{ requestId, error: <code> }` | The run failed. |
| `502` | `{ requestId, error: "abandoned" }` | The runtime gave up on the message (its agent or conversation is gone, or it waited too long): it was never answered; send it again. |
| `404` | `{ requestId, error: "not_found" }` | No such message in the conversation's current runtime conversation: never sent, or sent before a reset. |
| `501` | `{ error: "not_supported", message }` | `agent.submissions` is not installed: nothing keeps a message's outcome outside the runtime. |
| `503` | `{ requestId, error: "unavailable" }` | On Cloudflare only: the conversation's object could not be reached; ask again. |

Sending the same POST again (same `conversationId` and `messageId`) answers the same way, and never
runs it again.

### `POST /v1/conversations/:id/reset`

This starts the conversation over on a new runtime conversation. The old one is kept.
- `200 { conversationId, previousRuntimeConversationId, runtimeConversationId }` when the reset happened.
- `404` for a conversation that never had a message.

A run still going on the old conversation finishes there, and a POST waiting for it still gets its
answer.

## How it works

1. `http.authenticate`: this channel's stage checks the token. Tokens are compared as SHA-256
   digests, in constant time. The stage acts only on `http` requests and never overrides a
   rejection by another stage.
2. `inbound.normalize`: the body becomes an `InboundMessage` (`id` = request id). Your stages may
   rewrite the text or refuse the message, but must keep its id, channel and conversation.
3. `route.resolve`: a router picks the agent.
4. `conversations.registry.resolve("http:<conversationId>", agent, "http")`: the conversation (of the
   channel `http`) and its runtime conversation.
5. `agent.runtime.dispatch`: Pi takes the message.

The answer comes from the runtime's `agent.settled` / `agent.failed` events. The channel answers
every POST waiting for one of the run's `requestIds`. That list includes the message that started
the run and the messages queued with it. The waiting POSTs are an in-memory cache only: the answer
is in the conversation whether or not anyone waits.

Delivery guarantee: once a message is accepted, it is in the runtime's conversation and is
answered there. The HTTP response is the only push. With `agent.submissions` installed, a message
is also recorded before the POST returns, the next process resumes its run at start if this one
died, and a client that got a `202` reads the answer with `GET`. Without it, a run a dead process
left waits for the next message to its conversation, and the answer is only in the conversation.

It refuses to start when `PIKIT_HTTP_TOKEN` is missing or shorter than 16 characters (each half,
on Cloudflare).

## On each target

The same routes, statuses and guarantees; only where each step runs differs.

- **On a server** (`actor.inbox`'s scope `"all"`, or none installed): one App does everything. Its
  routes authenticate, admit the message and wait for its answer in process.
- **On Cloudflare** (scope `"one"`: each conversation is a Durable Object), two halves:
  - **The Worker's half** (`worker.ts`) serves the routes. It runs `http.authenticate` (a project's
    own stage of it goes in the Worker's App, where the request is), reads the request, makes the
    request id, and calls the conversation's object: `actor.mailbox.call("http:<conversationId>",
    "channel-http.message", { conversationId, text, requestId, actor })`, and `channel-http.status`
    or `channel-http.reset` for the other routes. The object's answer is the response.
  - **The object's half** (the default export) answers those calls (`actor.inbox.answer`). It checks
    the message again (it crossed an RPC) and that it names the object's own conversation, then
    runs the steps above: `admitInbound`, and the wait for `agent.settled` / `agent.failed` naming its
    request id, up to `replyTimeoutMs`. The wait is inside the call's RPC event, which keeps the
    object running while the run is driven by its alarm: an object keeps nothing alive after an
    event (a promise left behind dies). When the wait ends without an answer the call answers
    `202`; the message was admitted before the wait began, so it is durable in the object. Its own
    routes, which no server serves, call their conversation's object as the Worker's do.
  - `replyTimeoutMs` is the object's half's config; the Worker's half has none. An HTTP request to a
    Worker has no wall-clock limit while its client waits, and the object stays in memory meanwhile
    (billed as such): keep `replyTimeoutMs` as short as your clients allow.
  - A client that hangs up does not cut the object's wait: it ends at `replyTimeoutMs`, and the run
    goes on either way.

## Config

```ts
"channel-http": {
  replyTimeoutMs: 120000, // default; keep it below the server's idle timeout
}
```

On Cloudflare it is the object's half's (`export default` of pikit.config.ts); the Worker's half
(`channel-http-worker`) has no config.

## Tests

`channel-http.test.ts` is copied with the component and runs in your project. It calls the routes
as a server would, with small doubles for the runtime, the registry and the secrets. It covers the
statuses above, a run answering several queued messages with every POST answered, per-conversation
duplicates, cancellation, reset, the lifecycle conformance suite and the start failures; with
`agent.submissions`, a `202` answered later by `GET` and by the same POST sent again, a failed run and
unknown messages; without it, `GET`'s `501`.
`conformance.test.ts` runs the channel conformance suite from `@pikit/contracts/testing`: what every
channel does with a message (routed, deduplicated, stopped, denied, no router), over these routes,
and, as a channel whose answers are in its responses (`answers: "in-response"`), that an answer that
ended while the channel was stopped, or whose event was lost, is what the same POST sent again gets
after a restart. The suite's cases for a pushed answer (a platform's failures, a send cut mid-flight)
do not apply: the client's retry is its transport.
The `samples/http` tests run the same channel with Pi, over real HTTP.

On Cloudflare's model: `conformance.test.ts` runs the same suite a second time with the Worker half's
routes, in an App of their own, calling the objects' App (an `actor.inbox` of scope `"one"`, from
`actors.test-support.ts`) by `actor.mailbox.call`; `channel-http.test.ts` covers the Worker's `401`
and `400` before any call, a `202` whose message is admitted and later read by `GET` and by the same
POST (run once), an unreachable object's `503`, reset, the object's own routes, and the object
refusing a call for another conversation or not of this channel. In the pikit repository, the
workerd lane (`tests/workerd/test/channel-http.workerd.ts`) runs both halves on real Durable Objects
with runtime-pi: a message answered in the POST's response, a run longer than `replyTimeoutMs`
(`202`, then `GET` finds it), the same `messageId` run once, and a request without the token refused
by the Worker.

The CLI generates capability declarations in `component.json` from `setup`; targets are declared
by the component. The test "what setup declares" pins the capabilities.
