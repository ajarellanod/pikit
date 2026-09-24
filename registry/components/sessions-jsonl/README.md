# sessions-jsonl

Each conversation's Pi session is a JSONL file on the server's disk.

- **Provides:** `sessions.store`.
- **Requires:** nothing.
- **Target:** `server` (it uses the filesystem).
- **Installs to:** `src/pikit/sessions-jsonl/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

Pi writes the sessions: this component is Pi's own `JsonlSessionRepo`, reached through
`@pikit/pi-adapter/node`, and decides only where the files go. A session holds a conversation's
transcript, its inbox of queued messages, its open runs and its values. The agent runtime opens
conversations from it, and the conversation registry creates new sessions in it.

A session records the directory the agent works in. Until workspaces exist (SPEC §8), that is the
server's working directory.

Pi opens a session in one process at a time, and two processes on the same files are not
supported. Run one server replica over one `root`.

It refuses to start when `root` cannot be created or written.

## Config

```ts
"sessions-jsonl": {
  root: ".pikit/sessions", // default; relative to the working directory
}
```

## Tests

`sessions-jsonl.test.ts` is copied with the component and runs in your project. It covers:
- Pi's own session suites, `createSessionRepoConformance` and `createStorageConformance`, over the
  store this component provides. One case is a known gap of Pi's JSONL repository on Pi 0.87.1
  (a `create` racing a `fork` for the same new id; pikit does neither). It is registered as
  expected to fail, so a Pi release that fixes it is noticed;
- the lifecycle conformance suite;
- a session outliving the process, and the start failure above.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
