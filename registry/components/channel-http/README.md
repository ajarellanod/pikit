# channel-http

Talk to an agent over HTTP: send a message, get the answer in the response.

- **Provides:** `http.route`: `POST /v1/messages`, `GET /v1/conversations/:id/messages/:messageId`
  and `POST /v1/conversations/:id/reset`. It also adds the stage `channel-http-bearer` to
  `http.authenticate`.
- **Requires:** `secrets` (the token), `conversations.registry`, `agent.runtime`. A server (such as
  `server-bun`) serves the routes, and a router (such as `router-basic`) picks the agent.
- **Uses, if installed:** `agent.submissions` (runtime-pi provides it): a message's outcome can be
  read later, and sending it again returns it.
- **Targets:** `server`. Although the handlers use Fetch and Web Crypto, the Cloudflare host serves
  HTTP routes in the Worker's App; this channel has no Worker half yet. Do not install it on
  Cloudflare until that request path is integrated and tested.
- **Installs to:** `src/pikit/channel-http/`.
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
- `messageId` (optional): the message's identity; 1 to 128 of `A-Z a-z 0-9 . _ ~ : -`. It becomes
  the request id. Send the same `messageId` again to the same conversation and it does not run
  again. Without it, every POST is a new message.

The POST waits for the answer, up to `replyTimeoutMs` (120 s by default):

| Status | Body | When |
|---|---|---|
| `200` | `{ requestId, text }` | The agent answered. |
| `202` | `{ requestId }` | No answer in time, or the server is stopping. The answer still lands in the conversation. |
| `400` | `{ error: "invalid_request", message }` | The body is not a message. |
| `401` | `{ error: "unauthorized" }` | Missing or wrong token. |
| `403` | `{ requestId, error: "denied" \| "rejected", message? }` | The router denied it. |
| `409` | `{ requestId, error: "duplicate" }` | This `messageId` is already in the conversation, and nothing records its outcome. It does not run again. With `agent.submissions`, the POST answers with its outcome instead (`200`, `202` while it runs, `502`, `409 aborted`). |
| `409` | `{ requestId, error: "aborted" }` | The run was stopped before answering. |
| `422` | `{ requestId, error: "rejected", message }` | A stage of `inbound.normalize` refused it. |
| `500` | `{ requestId, error: "no_route" }` | No router decided. Install one. |
| `502` | `{ requestId, error: <code> }` | The run failed (for example, the model provider). |

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
4. `conversations.registry.resolve("http:<conversationId>", agent)`: the conversation and its
   runtime conversation.
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

It refuses to start when `PIKIT_HTTP_TOKEN` is missing or shorter than 16 characters.

## Config

```ts
"channel-http": {
  replyTimeoutMs: 120000, // default; keep it below the server's idle timeout
}
```

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

The CLI generates capability declarations in `component.json` from `setup`; targets are declared
by the component. The test "what setup declares" pins the capabilities.
