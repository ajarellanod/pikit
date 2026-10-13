# tool-delegate

The `delegate` tool, for the agents that name it: an agent hands a task to another agent of the
project and gets its answer, now or later. Each task is a child conversation of the agent the call
names, which starts with nothing but the task, on pi-durable's subagents.

- **Provides:** `agent.tool`, under the key `delegate` (replay `safe`).
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
- **`wait: false` returns at once**: the task goes on beyond the run, and when it ends its answer
  arrives in the conversation as a message of its own (`[The agent "researcher" finished the task you
  delegated to it. …]`), so the agent runs again with it and its answer reaches the person on their
  channel. A restart in between loses nothing.
- **A delegated task can delegate too**, if its agent names `delegate`, one level deeper, at most
  `maxDepth` (default 2) levels. A delegated task always waits for its own delegations: only a
  conversation a person started gets answers later.

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
  reads a conversation's depth from it. A call made again after a crash (replay `safe`) finds the
  child it created and the input it submitted, and only waits again.
- **Which agents, and how deep, is this tool's config**, checked when the App is defined; an agent it
  lists that the App does not define stops the App at start. Routing (`route.resolve`) is not asked:
  delegation is between the project's agents, by name.

## Tests

- `tool-delegate.test.ts` (copied into your project): what `setup` declares, a start refused for an
  unknown agent, the description, the task each call asks for (agent, key, task, sender) and how
  (`run` or `start`), the outcomes as the model reads them, depth and waiting rules, and config that is
  refused. It calls the tool with a stand-in for the runtime's delegation.
- `app.test.ts` (beside `files/`, in the registry only): with runtime-pi in a real App, on a SQLite
  file and the scripted faux model: a task waited for, a task answered later, one that reports after a
  restart, and the depth limit.
- `tests/workerd/test/tool-delegate.workerd.ts`: in a real Durable Object, driven by its alarm, both
  ways.
- The runtime's side (`packages/pi-adapter/src/delegation.test.ts`): the child as the other agent, a
  rerun after a crash, a stop that reaches the child, background tasks across a restart.

Design note: [features/subagents.md](https://github.com/ajarellanod/pikit/blob/main/features/subagents.md).
