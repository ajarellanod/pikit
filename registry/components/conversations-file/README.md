# conversations-file

The conversation registry in one JSON file: which Pi session each conversation is in now.

- **Provides:** `conversations.registry`.
- **Requires:** `sessions.store` (it creates each conversation's session there).
- **Target:** `server` (it uses the filesystem).
- **Installs to:** `src/pikit/conversations/file/`.
- **npm dependencies:** `@pikit/pi-adapter` (for the `sessions.store` type), `typebox`.

## What it does

A channel names a conversation with a key (`channel-http` uses `http:<conversationId>`).
- The first time a key is resolved, the registry creates a new session and records
  `key → { agent, sessionId }`.
- After that, the key resolves to the same session. A conversation keeps the agent it was created
  with, even if a later route names another one.
- A reset creates a new session and moves the pointer to it. The old session is kept, and its id
  is added to `previousSessionIds`. It then emits `conversation.reset`.
- No pointer is ever deleted. A conversation that went idle and was closed in memory keeps its
  pointer.

The file is the record, and the map in memory is only a cache. Every change is written to a
temporary file, flushed to disk, and renamed over the old file. A crash therefore leaves the old
file or the new one, never half of each. A pointer is used only once it is on disk.

A crash between creating a session and writing its pointer leaves one unused session behind. It
never leaves a pointer to a session that does not exist.

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
      "sessionId": "…",
      "previousSessionIds": ["…"],
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
- the `conversations.registry` conformance suite from `@pikit/core/testing`, including the
  sessions it creates;
- the lifecycle conformance suite;
- the file's content, a `__proto__` key, and the start failures above.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
