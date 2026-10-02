# Proposal for pi-durable: send the provider a session id

Status: draft for upstream (`@earendil-works/pi-durable`, against 1.0.0). From pikit, which runs
many long-lived chat conversations per deployment.

## Problem

pi-ai's request options carry `sessionId` ("for providers that support session-based caching …
prompt caching, request routing, or other session-aware features", `StreamOptions` in pi-ai 1.0's
`types.d.ts`). Providers use it: OpenAI and Azure Responses send it as `prompt_cache_key`, Anthropic
uses it for its cache session and session-affinity headers, OpenCode as a header, Codex for its
WebSocket session cache.

pi-durable never sets it. The generation task builds its options as
`{ ...streamOptions, signal, reasoning }` (`harness/generation.js`), and `ConversationStreamOptions`
(the harness-wide `settings.stream`) has no `sessionId`. Since settings are harness-wide, a host
cannot pass a per-conversation id through them either.

So every conversation's requests reach the provider with no cache key: on providers that route cache
hits by key, a long conversation pays for its whole prefix again and loses affinity.

## Repro

`packages/pi-adapter/src/durable/pi-facts.test.ts`, "pi-durable sends the provider no session id":
a faux response step records `streamOptions?.sessionId` for one submitted input; it is `undefined`.
pi-ai's faux provider simulates prompt caching only when `sessionId` is set, so its cache figures stay
at zero too.

## pikit's workaround

None. pikit cannot reach the request options per conversation: a `beforeRequest` hook may replace
the messages but not the options, and `settings.stream` is shared. pikit records the gap in its
facts test so it notices when it closes.

## Proposal

### 1. A default: the conversation's id

The generation task sets `sessionId` to a stable string per conversation (derived from the
conversation id, made unique across storages, for example with a random id kept in
`durable_metadata`) unless the options already carry one.
Compaction keeps its own choice (`cacheRetention: "none"`).

### 2. A per-conversation override

```ts
type ConversationStreamOptions = {
  // …
  /** Sent as pi-ai's `sessionId`. Absent: pi-durable's default for the conversation. `null`: none. */
  sessionId?: string | null;
};
```

settable per conversation through `configure()` (the agent's stream options), so a host can share a
cache key between a conversation and its forks, or keep keys stable across a reset.

## Compatibility

(1) changes requests: providers that ignored a missing id start sending one. A setting
`stream.sessionId: null` restores today's behaviour. (2) is additive.
