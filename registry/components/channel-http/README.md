# channel-http

Talk to an agent over HTTP: send a message, get the answer in the response.

- **Provides:** `http.route`: `POST /v1/messages` and `POST /v1/conversations/:id/reset`. It also
  adds the stage `channel-http-bearer` to `inbound.authenticate`.
- **Requires:** `secrets` (the token), `conversations.registry`, `agent.runtime`. A server (such as
  `server-bun`) serves the routes, and a router (such as `router-basic`) picks the agent.
- **Targets:** `server` and `cloudflare` (fetch handlers and Web Crypto only).
- **Installs to:** `src/pikit/channels/http/`.
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
| `202` | `{ requestId }` | No answer in time, or the server is stopping. The answer still lands in the conversation's session. |
| `400` | `{ error: "invalid_request", message }` | The body is not a message. |
| `401` | `{ error: "unauthorized" }` | Missing or wrong token. |
| `403` | `{ requestId, error: "denied" \| "rejected", message? }` | The router denied it. |
| `409` | `{ requestId, error: "duplicate" }` | This `messageId` is already in the conversation. It does not run again, and its answer went to the first POST. |
| `409` | `{ requestId, error: "aborted" }` | The run was stopped before answering. |
| `422` | `{ requestId, error: "rejected", message }` | A stage of `inbound.normalize` refused it. |
| `500` | `{ requestId, error: "no_route" }` | No router decided. Install one. |
| `502` | `{ requestId, error: <code> }` | The run failed (for example, the model provider). |

**A message sent while the agent is working changes its course.** It goes to Pi's inbox as a
steer, and the run in progress takes it after its current tool calls. That run answers both
messages, so both POSTs receive the same answer.

### `POST /v1/conversations/:id/reset`

This starts the conversation over on a new session. The old session is kept.
- `200 { conversationId, previousSessionId, sessionId }` when the reset happened.
- `404` for a conversation that never had a message.

A run still going on the old session finishes there, and a POST waiting for it still gets its
answer.

## How it works

1. `inbound.authenticate`: this channel's stage checks the token. Tokens are compared as SHA-256
   digests, in constant time. The stage acts only on `http` requests and never overrides a
   rejection by another stage.
2. `inbound.normalize`: the body becomes an `InboundMessage` (`id` = request id). Your stages may
   rewrite the text or refuse the message, but must keep its id, channel and conversation.
3. `route.resolve`: a router picks the agent.
4. `conversations.registry.resolve("http:<conversationId>", agent)`: the conversation and its
   session.
5. `agent.runtime.dispatch`: Pi takes the message.

The answer comes from the runtime's `agent.settled` / `agent.failed` events. The channel answers
every POST waiting for one of the run's `requestIds`. That list includes the message that started
the run and each message queued into it. The waiting POSTs are an in-memory cache only: the answer
is in the session whether or not anyone waits.

Delivery guarantee: once a message is accepted, it is in the conversation's session and is
answered there. If the process dies, the next one resumes the run. The HTTP response is the only
delivery; a client that got a `202` finds the answer in the session. Sending answers to platforms,
with retries, comes with `durable-outbox` (M2).

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
statuses above, a message steered into a busy run with both POSTs answered, per-conversation
duplicates, cancellation, reset, the lifecycle conformance suite and the start failures. The
`samples/http` tests run the same channel with Pi, over real HTTP.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
