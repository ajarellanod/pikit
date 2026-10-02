# @pikit/pi-adapter: Pi (pi-durable 1.0) behind pikit's contracts

The only package that imports Pi: `@earendil-works/pi-durable`, `@earendil-works/chord`,
`@earendil-works/pi-ai` and `@earendil-works/pi-mcp`, all exactly `1.0.0`. It implements
`agent.runtime` on pi-durable's `Harness`, opens pi-durable's storage over pikit's `storage.sql`, and
gives components Pi's tools, models, MCP client and execution environments by subpath.

## Exports

| Export | File | What | Targets |
|---|---|---|---|
| `.` | `index.ts` | `createDurableRuntime` (`runtime.ts`); `openDurableStorage` (`sql.ts`); `modelsFrom`, `modelRefOf` (`models.ts`); `nextWakeAt`, `nextWakeAtOf`, `driveSlice` (`wakeups.ts`); `harnessEnv`; `loginInteraction`; the capability types (`types.ts`) and Pi's types | every |
| `./tools` | `tools/index.ts` | `codingTool(name)` (pi-durable's `read`/`write`/`edit`/`bash` with pikit's replay), `createFetchTool`, `createBraveSearchTool`, `defineTool` (`tools/README.md`) | every |
| `./mcp` | `mcp.ts` | pi-mcp's client, `mcpHttpTransport`, `mcpToolName`, `mcpTool` (provided at setup, described at start) | every |
| `./execution` | `execution.ts` | pi-durable's `ExecutionEnv` types and helpers; `harnessEnv`, `atCwd` | every |
| `./node` | `node.ts` | `createLocalExecution` on pi-durable's `NodeExecutionEnv` | server |
| `./providers/anthropic`, `./providers/openrouter` | `providers/*.ts` | pi-ai 1.0's providers by subpath (`openrouterProvider({ apiBase })`) | every |
| `./credentials` | `credentials.ts` | pi-ai's credential types; `loginInteraction(terminal)`, an `AuthInteraction` that answers every prompt type, `select` included | every |
| `./wakeups` | `wakeups.ts` | the same as the root's wake-up functions | every |
| `./testing` | `testing/index.ts` | `./testing/neutral`, plus `createPiRuntimeFixture` (a SQLite file), `sqliteStorage`, `openSqliteDatabase`, `testComponents` with a `storage.sql` in memory | server |
| `./testing/neutral` | `testing/neutral.ts` | the scripted model and agent (`scriptedProvider`, `scriptedAgent`, `holdTool`, `recordingBash`), `createRuntimeFixture`, `interruptRun`, `testComponents`, `fakeConversations`, the `workspace` and `model.credentials` conformance suites | every |
| `./testing/harness` | `testing/harness.ts` | a pi-durable `Harness` smoke over `storage.sql`, in phases, and pi-durable's storage conformance | every |
| `./execution/testing` | `testing/execution.ts` | `createDurableExecutionConformance`; `callTool`; `runToolCalls` (a Harness with the faux model) | every |
| `./mcp/testing` | `testing/mcp.ts` | a fake Streamable HTTP MCP server as a `fetch` handler | every |
| `./wakeups/testing` | `testing/wakeups.ts` | a Harness on an injected clock, and readers of what a run left | every |

`types.ts` makes the contracts' opaque payloads precise by declaration merging: an agent's tool is
pi-durable's `ToolRegistration`, a message pi-ai's `Message`, usage pi-ai's `Usage`; and it declares
the Pi-typed capabilities: `model.credentials` (`CredentialStore`), `execution`, `execution.shell`
and `Workspace.env` (pi-durable's `ExecutionEnv`), `workspace`, and the keyed `model.provider`.

## Storage: pi-durable on `storage.sql` (`sql.ts`)

pi-durable's portable `SqliteStorage` runs over a thin facade on `storage.sql`
(`sqliteDatabaseFrom`, `openDurableStorage`), so one implementation serves a server (storage-sqlite)
and a Durable Object (storage-do). pi-durable's own storage conformance passes on both
(`sql.test.ts`, and `tests/workerd/test/durable-storage.workerd.ts`).

- **Queueing**: both providers run statements and transactions on one line, so a call outside a
  running transaction waits, as `SqliteDatabase` requires. Transaction handles refuse statements once
  their callback settled.
- **Rollback**: the provider's. storage-sqlite rolls back and rethrows the same error; storage-do
  delegates to `DurableObjectStorage.transaction`.
- **bigint**: pi-durable never binds one; a safe-integer bigint binds as a number, a larger one throws.
- **exec**: several statements are split (strings, quoted identifiers, comments, trigger bodies
  respected) and, outside a transaction, run in one.
- **close** waits for the facade's operations and never closes the app's database.
- **Table names** are pi-durable's, fixed and unprefixed (`conversations`, `entries`, `tasks`,
  `submissions`, `documents`…): one `storage.sql` holds one pi-durable session. On a server that is
  one runtime (many conversations) per database; in a Durable Object, one per object (its root
  first). **One owner**: two processes over one database are unsupported (pi-durable caches the next
  id in memory).

## The runtime (`runtime.ts`)

`createDurableRuntime(options)` is `agent.runtime` (`dispatch`, `abort`, `resume`), plus what a host
uses: `createConversation`, `recover`, `abandon`, `holds`, `whenIdle`, `suspend`, `state`, `inspect`,
`close`. The contracts and events are as consumers see them: `Admission` (`started`/`queued`/
`duplicate`), `agent.dispatched`, `agent.started` (`resumed` for a run a previous worker left open),
`agent.settled`/`agent.failed` with `AgentResult`.

- **One Harness per storage**, opened at first use (`storage` is a `Storage` or an opener) and owned
  until `close`. Opening reconfigures every conversation with live work, resumes the scheduler (it is
  global: every conversation's work runs), announces the runs it resumes, and starts runs for inputs a
  failed run left queued. `suspend` closes it and keeps the runtime: the next call reopens it.
- **Conversation ids.** `ConversationRef.conversationId` is the pi-durable conversation id (a number,
  as a string). `createConversation(ctx)` makes one: `conversations: "ownerless"` (default, a
  server's storage holding many) an ownerless conversation each call; `"root"` (a per-chat Durable
  Object) the root the first time, then ownerless ones. A reset is a new conversation
  (`conversations.registry` keeps pointing keys at ids); pi-durable's own `reset()` is not used, so
  `agent.state` starts fresh. A key/agent pair is recorded in the conversation's `pikit.conversation`
  document at each admission, so a settlement found later has its `ConversationRef`. An id that is
  not a pi-durable one (a Pi 0.99 session id) is refused (`conversation_missing`); `recover` settles
  the requests `agent.submissions` held for one aborted, unannounced.
- **Admission.** `dispatch` runs in the conversation's line: a read-only commit looks the request id up
  (`duplicate` if pi-durable has it) and, in the same commit, applies `prepare`; then
  `submit({ type: "input", requestId })`. The status the creating commit published (`queued` in the
  inbox, or `placed`) gives `queued` or `started`. Every input is a **follow-up**, and follow-ups are
  placed all at once (`followUpMode: "all"`; `steeringMode: "all"` too, though pikit submits no steer):
  the messages queued while a run goes start the next run together. Its `agent.started` names the
  first (the others' placing announces nothing), and its result lists them all in `requestIds`.
- **Settlement.** Read from pi-durable's commits (`subscribeCommits`): a run's inputs settle in the
  commit that ends it, and are one result (`runsOf`); one an abort withdrew while queued is its own.
  `done` → `agent.settled` `completed` with the answer's text; `unanswered`/`aborted` → `agent.settled`
  `aborted`; any other reason (`model_error`, `no_model`, `faulted`, `orphaned`, `reset`) →
  `agent.failed` with `{ code: reason, message: detail }`. `messages` are the model messages from the
  first input's `pi.user` entry to the answer (system entries excluded); `usage` sums their assistant
  and tool-result usage, what pi-durable adds to `pi.usage`. A withdrawn input is recorded aborted in
  `agent.submissions` and not announced. Events wait for the admissions' `agent.dispatched`/
  `agent.started`, so the order is kept.
- **`agent.submissions` bridge** (transitional): `admitted` before `dispatch` resolves, `settled`
  before the event (retried in the background on failure). `recover(conversation, requestIds)`
  settles what pi-durable finished while nobody recorded it, grouped by run (`storedRunsOf`: answered
  inputs by their answer; unanswered ones whose `pi.user` entries follow each other), and waits for
  those still queued or running. `abandon` skips requests pi-durable still holds.
- **Agents and state** (`agent.ts`). Tools live in the registry, one extension per agent
  (`pikit.agent.<name>`); each conversation's `pi.agent` selects only that extension, offers the
  turn's tools by name, and holds the model and `instructions` (the system prompt). `agent.state` is
  the conversation-scoped document `pikit.agent-state`. `prepare(state)` is applied where its inputs
  change: at each admission, in the same commit as every state update, and before a reopened Harness
  resumes a conversation. So the agent pi-durable reads when it prepares a model request is always
  `prepare` of the state at that moment: **a tool's state update applies from the run's next model
  request**, not from the next run. Tools run wrapped so their context carries `CONVERSATION` and
  `AGENT_STATE`.
- **Tools, models and environments.** `tool(name)` returns a pi-durable tool; a tool object in a
  definition must be one too. `models` is pi-ai 1.0's `Models`. Each tool call's environment is
  `harnessEnv` over `workspace()` (the call's conversation's) and `execution()`, unless `env` is given.
- **Hosts that live per event.** `whenIdle` resolves once no task is driven and nothing is being
  recorded or announced; work that only waits for a time (a generation's `retry`/`poll`, a
  compaction's `retry`) does not count, and `onIdleWithPendingWork(inspection, ctx)` is called so the
  host schedules a wake-up (`nextWakeAtOf`). A reopened Harness continues the wait from its checkpoint,
  on the Harness clock (`now`).
- **Contexts.** `toChord` re-attaches a pikit context's signal for Chord 1.0. Tasks run in the
  Harness's context (the app's values); a dispatching caller's values reach the run's events, not its
  tools.

### Gaps bridged (asserted in `pi-facts.test.ts`)

- A run that ends unanswered leaves follow-ups queued in the inbox until the next submission. The
  runtime submits a write of kind `pikit.inbox-kick` (an entry without model messages) to an idle
  conversation with queued inputs: the admission boundary places them and starts their run.
- pi-durable passes the provider no session id, so prompt-cache keys keyed on it get none.

## Wake-ups (`wakeups.ts`)

pi-durable 1.0 waits with in-process timers and reports no next due time. `nextWakeAt(harness)` reads
`harness.inspect()`: a `ready` or `running` task is due now, except the built-in waits, whose due time
is in the task's checkpoint (`pi.generation` phase `retry` `until`, phase `poll` `pollAt`;
`pi.compaction` phase `retry` `until`). `driveSlice(harness, { signal, now, until })` drives one bounded
slice and returns when the host must come back. runtime-pi uses the runtime's `whenIdle` and
`onIdleWithPendingWork` with `nextWakeAtOf`, and `suspend`s the runtime inside the wake-up's event
when only timed work is left (a pending timer keeps a Durable Object from being evicted).

## Models, providers and credentials

- `modelsFrom(providers, { credentials, authContext })`: a pi-ai 1.0 `Models`; with a
  `CredentialStore` (`model.credentials`), a stored credential owns its provider, refreshed OAuth tokens
  are written back through it. `modelRefOf(models, agent, "provider/modelId")`: pi-durable's `ModelRef`,
  split at the first slash (`openrouter/z-ai/glm-5.3-flash`).
- `providers/anthropic.ts`: `anthropicProvider` (credential order: stored, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, then workload identity federation). Its OAuth login
  first asks a `select` prompt (`browser` or `copy_code`): `loginInteraction` answers it.
- `providers/openrouter.ts`: `openrouterProvider({ apiBase })` moves every model's address, the image
  and classifier models too.

## Tests

`*.test.ts` here: `runtime` (answers, busy conversations and batching, duplicates, abort, contexts),
`recovery` (restarts, `agent.submissions`, retries, `suspend`, ids of Pi 0.99's time), `prepare` (and
`agent.state`'s conformance), `usage`, `conformance` (the contracts' `agent.runtime` suite, every
case), `pi-facts` (the pi-durable behaviours relied on: duplicate admission, follow-up batching,
checkpoint shapes, inbox kick…), `sql`, `wakeups`, `models`, `credentials`, `execution`, `mcp`,
`tools/*`. `test-support.ts` (not exported) is the scripted runtime worker they share.
