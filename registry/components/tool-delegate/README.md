# tool-delegate

The `delegate` tool, for the agents that name it: an agent hands a task to another agent of the
project and gets its answer, now or later. Each task is a child conversation of the agent the call
names, which starts with nothing but the task, on pi-durable's subagents. Three more tools list,
steer and stop the tasks it did not wait for.

- **Provides:** `agent.tool`, under the keys `delegate`, `delegate_tasks`, `delegate_steer` and
  `delegate_cancel` (replay `safe`, all four).
- **Uses, optionally:** `agent.definition`, to check at start that the agents its config lists exist.
- **Targets:** `server` and `durable` (Cloudflare, celld): the child lives in the parent's storage.
- **Installs to:** `src/pikit/tool-delegate/` (`index.ts`, `tool-delegate.test.ts`).

## Use it

```sh
pikit add tool-delegate
```

List the agents it may hand work to in `pikit.config.ts`, each with what it is for (the model reads it
to pick one):

```ts
export const config = {
  "tool-delegate": {
    agents: [
      { name: "researcher", description: "Finds and reads sources on the web, and answers with what they say." },
      { name: "coder", description: "Changes code in the workspace and runs its tests." },
    ],
    maxDepth: 2,
  },
};
```

and name the tool in the agents that delegate (`src/agents/<agent>/agent.ts`):

```ts
defineAgent({ name: "assistant", model: "…", tools: ["delegate"] })
```

The model calls `delegate({ agent, task, wait? })`:

- **`wait` (the default) waits** for the agent's answer and returns it: `The agent "researcher"
  answered: …`. A task that failed or was stopped is an error result the model reads. Stopping the
  assistant's run stops the task it waits for.
- **`wait: false` returns at once**, with the task's id: the task goes on beyond the run, and when it ends its answer
  arrives in the conversation as a message of its own (`[The agent "researcher" finished the task you
  delegated to it. …]`), so the agent runs again with it and its answer reaches the person on their
  channel. A restart in between loses nothing.
- **A delegated task can delegate too**, if its agent names `delegate`, one level deeper, at most
  `maxDepth` (default 2) levels. A delegated task always waits for its own delegations: only a
  conversation a person started gets answers later.

### Who may delegate to an agent

An agent with a machine or secrets of its own (a `developer` with a GitHub token,
[features/agent-sandboxes.md](https://github.com/ajarellanod/pikit/blob/main/features/agent-sandboxes.md)) should
take tasks only from the agents you trust with them. Name them in its `from`:

```ts
"tool-delegate": {
  agents: [
    { name: "developer", description: "Changes code in the repository and opens pull requests.", from: ["orchestrator"] },
    { name: "orchestrator", description: "Plans a job and hands its parts to the right agents." },
  ],
},
```

- **The rule:** a `delegate` call to an agent with `from` is allowed only when the calling
  conversation's agent **and every agent above it** in its delegation, up to the conversation a person
  or a channel started, are in `from`. So a `support` agent that may delegate to `orchestrator` still
  cannot reach `developer` through it: the orchestrator's child was delegated from `support`.
- **Refused, nothing starts** (waited for or not): the model reads why (`the agent "developer" takes
  tasks only from orchestrator; this conversation (orchestrator, delegated from support) may not
  delegate to it: …`). The checks, in order: an agent it does not list, `from`, the depth.
- **The model is told**: the tool's description adds `(only from: orchestrator)` to the agent's line.
- An agent without `from` takes tasks from any agent, as before. Each name in `from` must be an
  `agent.definition`, or the App does not start.
- **Not a substitute for scoping the token**: the boundary is the reviewed code's, in one Worker or
  process (agent sandboxes' Limits); give the agent a fine-grained token as well. `from` decides who
  may hand it work, not what its tools do once it has some.

### When the agent needs more

The main agent hands "fix the login bug" to `developer`, which does not know which branch. It should
not guess, and the person it could ask with `askUser` may not know either: the agent that delegated
does. So, by convention (no new tool, no protocol), the delegated agent asks back:

- **Every task ends with one instruction** (`framedTask`, the only place it is added): `[If
  something you need to do this task is missing and you cannot find it yourself, do not guess: stop,
  and answer with a line starting with QUESTION: that says exactly what you need. The agent that gave
  you the task will answer by giving you a new task.]` The prefix is `QUESTION_PREFIX`.
- **The delegating agent answers by delegating again**, with everything the previous task had plus
  the answer: a new task starts with nothing, not even the question it asked. The tool's description
  says so.
- **Waited for**, an answer that starts with `QUESTION:` is flagged in the call's result: `The agent
  "developer" needs more information, and did not do the task: which branch? [To go on, answer it by
  delegating to it again, ...]`. Any other answer reads as before.
- **Not waited for**, the question arrives as the task's report, as the agent wrote it (the
  runtime's `[The agent "developer" finished the task ...]`): only the description tells the model
  what it means.

A real way to ask the delegating agent while the task runs (`ask_parent`) is not built: a parent
waiting with `wait: true` is inside its tool call and cannot take a message from its child
([features/subagents.md](https://github.com/ajarellanod/pikit/blob/main/features/subagents.md)).

For the tasks not waited for, name the tools the agent needs (`tools: ["delegate", "delegate_tasks",
"delegate_steer", "delegate_cancel"]`); `extension-house-rules` can allow them per sender:

- **`delegate_tasks({ id? })`** lists the conversation's tasks (id, agent, `running`, `completed`,
  `failed` or `aborted`, and the answer or why it failed, at most 2000 characters), a running one
  with its latest step on its line. With an id, it shows how that task is going, running or ended:
  its agent's last 5 steps, oldest first, and how long ago the last one was. A step is what the
  agent wrote (at most 300 characters) or a tool it called, with its arguments (at most 120
  characters) and `running`, `ok` or `error`:

  ```
  - 17: the agent "developer", running
  Its last steps, oldest first (the last one 40 seconds ago):
    - wrote: The failing test is in src/app.test.ts; fixing the parser.
    - called read {"path":"src/parse.ts"}: ok
    - called bash {"command":"bun test"}: running
  ```

  So the agent can tell the person how it is going, and decide whether to steer or stop it. It shows
  only what the task's own conversation holds (the arguments its tools were called with, a secret
  typed there included), which this conversation's storage already holds.
- **`delegate_steer({ id, message })`** sends a running task a message from the delegating agent: it
  joins the task's run (or runs right after it), and the task's one answer covers it. A task that
  ended takes none (an error the model reads).
- **`delegate_cancel({ id })`** stops it: the conversation gets one message saying it was stopped.
  Again, or once ended, it changes nothing and says so.

Each sees only the tasks its own conversation started: another's id is an unknown task.

## How it is built

- **pi-durable has subagents**: a tool call can create a conversation it owns, submit to it and wait,
  and a background task can own one that outlives the run (pi-durable's examples 22 and 23). The
  runtime gives every tool its delegation in its context (`AGENT_DELEGATION`, from
  `@pikit/pi-adapter/tools`), which adds what is pikit's: the child runs as another of the project's
  agents (its model, prompt, tools, extensions and skills), its sender is the delegating agent
  (`{ channel: "delegate", id }`, which its tools and hooks read through `RUN_REQUESTS`), and a
  background task's answer is admitted to the parent through the runtime's `dispatch`, so it is
  logged and delivered like any answer.
- **A task's key is the call's**: `delegate:<depth>:<chain>:<tool call's task id>`, `<chain>` the
  child's ancestors' agents, root first, joined by `.` (`delegate:2:support.orchestrator:17`: support
  delegated to orchestrator, whose child this is). This tool alone makes `delegate:` keys, and reads a
  conversation's depth (`depthOf`) and chain (`chainOf`) from them; nothing else parses them.
- **Who is above a conversation is never the model's**: its chain is in its key, which the runtime
  gives the tool (`CONVERSATION`), and the chain's first agent must be the origin's, which the runtime
  fixed when it created the conversation (`originOf`). A chain that does not parse, does not match its
  depth or its origin, or a delegated conversation under a key that is not this tool's, is not
  trusted: it reaches no agent with `from` (fail closed), and its children's chain is written empty
  (`delegate:<depth>::<task id>`), so none below reaches one either. An agent without `from` is still
  reached. The child conversation's channel (`ConversationRef.channel`)
  is `delegate`; its origin (`ConversationRef.origin`), the conversation the person talks in, is the
  runtime's to record, so the child's memory, scheduled prompts and approvals are that person's
  (`originOf`). A call made again after a crash (replay `safe`) finds the child it created and the
  input it submitted, and only waits again.
- **The child works on its own agent's machine**: with `execution-gondolin` or `execution-remote`, a
  child of another agent gets a sandbox of its own (its agent's packages, hosts and secrets), never
  its parent's; what it made comes back in its answer or through git. A child of the same agent
  shares its parent's only in a Durable Object (on a server it has its own key, so its own sandbox).
  An agent with a machine of its own (a token) takes tasks only from the agents in its `from`, so no
  other agent with `delegate` can drive it, directly or through another agent ([features/agent-sandboxes.md](https://github.com/ajarellanod/pikit/blob/main/features/agent-sandboxes.md)).
- **What the child asks the person reaches them**: a completed task's outcome carries its run's parts
  (a `question` its `askUser` or `request_approval` asked). Waited for, the `delegate` call's result
  carries them (`withParts`); not waited for, the task's report does (`AgentRequest.parts`). Either
  way they go with the answer of this conversation's run, which its channel delivers, and the model
  reads them as shown to the person (`partsNote`), so it does not ask again. The answer comes back
  to this conversation as a message: the agent hands it on with a new delegation.
- **The tasks not waited for** are the runtime's `list`, `progress`, `steer` and `cancel`
  (`AGENT_DELEGATION`), which read the calling conversation's own record of them (so another's are
  not found, and a restart loses nothing); `progress` reads the child's last steps from its entries,
  in the same storage (no call between actors). Replay `safe`: listing only reads, a steer's request id is its call's (a rerun sends
  nothing twice), and a cancel done again changes nothing.
- **Which agents, who may delegate to each, and how deep, is this tool's config**, checked when the
  App is defined; an agent it lists (or names in a `from`) that the App does not define stops the App
  at start. Routing (`route.resolve`) is not asked:
  delegation is between the project's agents, by name.

## Tests

- `tool-delegate.test.ts` (copied into your project): what `setup` declares, a start refused for an
  unknown agent (in `agents` or a `from`), the description, the task each call asks for (agent, key
  with its chain, channel, task, sender) and how (`run` or `start`), the outcomes as the model reads
  them, the task framed to ask back and a `QUESTION:` answer flagged (any other unchanged), depth and
  waiting rules, `from` (an allowed caller, a refused one with nothing started both
  ways, laundering through an allowed agent refused, a chain wholly in it allowed, untrusted chains
  refused for a restricted agent and not for another, the order of the checks), config that is
  refused, and what `delegate_tasks` (a task's steps with its id, a running one's latest in the
  list), `delegate_steer` and `delegate_cancel` answer for each status. It
  calls the tools with a stand-in for the runtime's delegation.
- `app.test.ts` (beside `files/`, in the registry only): with runtime-pi in a real App, on a SQLite
  file and the scripted faux model: a task waited for, a task answered later, one that reports after a
  restart, the depth limit, a task listed, steered and cancelled (reported once) by its own
  conversation, while another conversation neither sees nor stops it, a task's tool calls read with
  `delegate_tasks({ id })` while it runs and after (another conversation reads none), a developer
  that asks back which branch (flagged; delegating again with the branch gets it done; its tasks
  arrived framed), and `from`: allowed directly and
  two levels deep (the keys carry the chain), refused directly and through an allowed agent (the
  restricted agent never runs). The scripted rules match a message whole, so the agents on it read a
  task without its framing (`unframed.test-support.ts`, also used by the workerd and acceptance tests).
- `tests/workerd/test/tool-delegate.workerd.ts`: in a real Durable Object, driven by its alarm, both
  ways, a task listed and cancelled, its steps read while it runs and after, the child's key with its chain, and a `from` refusal.
- The runtime's side (`packages/pi-adapter/src/delegation.test.ts`): the child as the other agent, a
  rerun after a crash, a stop that reaches the child, background tasks across a restart, a stable id,
  the list after a restart, a steer that joins the run and one that comes after its last tool round,
  a cancel reported once, another conversation's id `not_found`, `progress` (none before the child's
  first answer, the last steps bounded and oldest first, how each call went, the ended task's, another
  conversation's id and an unknown one `not_found`, after a restart), the origin two delegations deep and
  after a restart, and the child's parts in `run`'s outcome and in the report, once.
- `tests/acceptance/team-bases.test.ts`: a delegated worker's approval asked, decided in the chat and
  used by the chat's tree once (never by another's), its memory and its scheduled prompt.

Design note: [features/subagents.md](https://github.com/ajarellanod/pikit/blob/main/features/subagents.md).
