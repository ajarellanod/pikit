# conversations-file

The conversation registry in one JSON file: which runtime conversation each conversation key is in now.

- **Provides:** `conversations.registry`.
- **Requires:** `agent.conversations` (the agent runtime's: `runtime-pi`; it creates each conversation there).
- **Target:** `server` (it uses the filesystem).
- **Installs to:** `src/pikit/conversations-file/`.
- **npm dependencies:** `typebox` (and `@pikit/pi-adapter` for its tests' fake `agent.conversations`).

The registry uses the runtime, never the other way round: `runtime-pi` provides
`agent.conversations` (a new pi-durable conversation) and starts first; this component records which
key points to which conversation id. So a project installs `runtime-pi` before it.

## What it does

A channel names a conversation with a key (`channel-http` uses `http:<conversationId>`).
- The first time a key is resolved, the registry creates a new conversation and records
  `key → { agent, conversationId }`.
- After that, the key resolves to the same conversation. A conversation keeps the agent it was created
  with, even if a later route names another one.
- A reset creates a new conversation and moves the pointer to it. The old conversation is kept, and its id
  is added to `previousConversationIds`. It then emits `conversation.reset`.
- No pointer is ever deleted. A conversation that went idle and was closed in memory keeps its
  pointer.

The file is the record, and the map in memory is only a cache. Every change is written to a
temporary file, flushed to disk, and renamed over the old file. A crash therefore leaves the old
file or the new one, never half of each. A pointer is used only once it is on disk.

A crash between creating a conversation and writing its pointer leaves one unused conversation behind. It
never leaves a pointer to a conversation that does not exist.

One process owns the file, and its changes run one at a time. Two processes on the same file are
not supported: run one server replica.

It refuses to start when the file is not a registry, or when its directory cannot be written.

The file (mode `0600`):

```json
{
  "version": 1,
  "conversations": {
    "http:c1": {
      "agent": "assistant",
      "conversationId": "…",
      "previousConversationIds": ["…"],
      "createdAt": 1790000000000,
      "updatedAt": 1790000000000
    }
  }
}
```

## Config

```ts
"conversations-file": {
  path: ".pikit/conversations.json", // default; relative to the working directory
}
```

## Tests

`conversations-file.test.ts` is copied with the component and runs in your project. It covers:
- the `conversations.registry` conformance suite from `@pikit/contracts/testing`, including the
  conversations it creates;
- the lifecycle conformance suite;
- the file's content, a `__proto__` key, and the start failures above.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
