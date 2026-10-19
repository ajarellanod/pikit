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

For the tasks not waited for, name the tools the agent needs (`tools: ["delegate", "delegate_tasks",
"delegate_steer", "delegate_cancel"]`); `extension-house-rules` can allow them per sender:

- **`delegate_tasks({ id? })`** lists the conversation's tasks (id, agent, `running`, `completed`,
  `failed` or `aborted`, and the answer or why it failed, at most 2000 characters), or one.
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
- **A task's key is the call's**: `delegate:<depth>:<tool call's task id>`. This tool makes it and
  reads a conversation's depth from it. The child conversation's channel (`ConversationRef.channel`)
  is `delegate`; its origin (`ConversationRef.origin`), the conversation the person talks in, is the
  runtime's to record, so the child's memory, scheduled prompts and approvals are that person's
  (`originOf`). A call made again after a crash (replay `safe`) finds the child it created and the
  input it submitted, and only waits again.
- **What the child asks the person reaches them**: a completed task's outcome carries its run's parts
  (a `question` its `askUser` or `request_approval` asked). Waited for, the `delegate` call's result
  carries them (`withParts`); not waited for, the task's report does (`AgentRequest.parts`). Either
  way they go with the answer of this conversation's run, which its channel delivers, and the model
  reads them as shown to the person (`partsNote`), so it does not ask again. The answer comes back
  to this conversation as a message: the agent hands it on with a new delegation.
- **The tasks not waited for** are the runtime's `list`, `steer` and `cancel` (`AGENT_DELEGATION`),
  which read the calling conversation's own record of them (so another's are not found, and a restart
  loses nothing). Replay `safe`: listing only reads, a steer's request id is its call's (a rerun sends
  nothing twice), and a cancel done again changes nothing.
- **Which agents, and how deep, is this tool's config**, checked when the App is defined; an agent it
  lists that the App does not define stops the App at start. Routing (`route.resolve`) is not asked:
  delegation is between the project's agents, by name.

## Tests

- `tool-delegate.test.ts` (copied into your project): what `setup` declares, a start refused for an
  unknown agent, the description, the task each call asks for (agent, key, channel, task, sender) and how
  (`run` or `start`), the outcomes as the model reads them, depth and waiting rules, config that is
  refused, and what `delegate_tasks`, `delegate_steer` and `delegate_cancel` answer for each status. It
  calls the tools with a stand-in for the runtime's delegation.
- `app.test.ts` (beside `files/`, in the registry only): with runtime-pi in a real App, on a SQLite
  file and the scripted faux model: a task waited for, a task answered later, one that reports after a
  restart, the depth limit, and a task listed, steered and cancelled (reported once) by its own
  conversation, while another conversation neither sees nor stops it.
- `tests/workerd/test/tool-delegate.workerd.ts`: in a real Durable Object, driven by its alarm, both
  ways, and a task listed and cancelled.
- The runtime's side (`packages/pi-adapter/src/delegation.test.ts`): the child as the other agent, a
  rerun after a crash, a stop that reaches the child, background tasks across a restart, a stable id,
  the list after a restart, a steer that joins the run and one that comes after its last tool round,
  a cancel reported once, another conversation's id `not_found`, the origin two delegations deep and
  after a restart, and the child's parts in `run`'s outcome and in the report, once.
- `tests/acceptance/team-bases.test.ts`: a delegated worker's approval asked, decided in the chat and
  used by the chat's tree once (never by another's), its memory and its scheduled prompt.

Design note: [features/subagents.md](https://github.com/ajarellanod/pikit/blob/main/features/subagents.md).
