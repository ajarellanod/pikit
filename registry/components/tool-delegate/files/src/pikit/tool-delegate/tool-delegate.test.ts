/**
 * tool-delegate's tests. They are copied with the component and keep running in your project.
 *
 * The tool is called directly, with a conversation and a stand-in for the runtime's delegation in its
 * context (`CONVERSATION`, `AGENT_DELEGATION`), as the runtime gives them. The tool in a real App,
 * through runtime-pi, is `app.test.ts` beside `files/` in the registry.
 */

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import { CONVERSATION, type ConversationRef, type MessagePart } from "@pikit/contracts";
import { AGENT_DELEGATION, type AgentDelegation, type BackgroundDelegation, type DelegatedOutcome, type DelegatedTask, type DelegationProgress, PARTS_DETAIL } from "@pikit/pi-adapter/tools";
import toolDelegate, {
  CANCEL_TOOL,
  createCancelTool,
  createDelegateTool,
  createSteerTool,
  createTasksTool,
  DELEGATE_TOOL,
  type DelegateConfig,
  callersOf,
  chainOf,
  delegateDescription,
  depthOf,
  STEER_TOOL,
  TASKS_TOOL,
} from "./index.ts";

const config: DelegateConfig = { agents: [{ name: "researcher", description: "Reads sources." }, { name: "coder", description: "Writes code." }], maxDepth: 2 };
const parent: ConversationRef = { key: "telegram:1", agent: "assistant", conversationId: "7" };

/**
 * A stand-in delegation that answers `outcome`, records each task by how it was asked, and has `tasks`
 * started in the background, each with its child's `steps` (none by default).
 */
function delegation(
  outcome: DelegatedOutcome = { kind: "completed", text: "done" },
  tasks: BackgroundDelegation[] = [],
  steps: Record<string, Pick<DelegationProgress, "steps" | "updatedAt">> = {},
) {
  const asked: { how: "run" | "start"; task: DelegatedTask }[] = [];
  const steered: { id: string; message: string }[] = [];
  const statusOf = (id: string) => tasks.find((task) => task.id === id)?.status ?? "not_found";
  const stand: AgentDelegation = {
    run: async (_api, task) => {
      asked.push({ how: "run", task });
      return outcome;
    },
    start: async (_api, task) => {
      asked.push({ how: "start", task });
      return "t9";
    },
    list: async () => tasks,
    progress: async (_api, id) => {
      const task = tasks.find((each) => each.id === id);
      return task === undefined ? "not_found" : { ...task, steps: [], ...steps[id] };
    },
    steer: async (_api, id, message) => {
      if (statusOf(id) === "running") steered.push({ id, message });
      return statusOf(id);
    },
    cancel: async (_api, id) => (statusOf(id) === "running" ? "aborted" : statusOf(id)),
  };
  return { stand, asked, steered };
}

/** Calls the tool as the runtime does, in `conversation`'s run (`null`: outside any run). */
const call = (args: Record<string, unknown>, d = delegation(), conversation: ConversationRef | null = parent, options: DelegateConfig = config) => {
  const context = conversation === null ? BACKGROUND_CONTEXT : withContextValue(AGENT_DELEGATION, d.stand, withContextValue(CONVERSATION, conversation, BACKGROUND_CONTEXT));
  return createDelegateTool(options).execute(args as never, { taskId: "t9" } as never, context as never);
};

const textOf = (result: Awaited<ReturnType<typeof call>>) => result.output?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const agents = defineComponent({ name: "agents", setup: (pikit) => pikit.provideKeyed("agent.definition", "researcher", { name: "researcher", model: "x/y" }) });
  const app = await defineApp({
    components: [agents, toolDelegate],
    config: { "tool-delegate": { agents: [{ name: "researcher", description: "Reads sources." }] } },
    logger: silentLogger,
  }).create();

  expect(app.describe().components.find((component) => component.name === "tool-delegate")).toMatchObject({
    provides: ["agent.tool"],
    requires: [],
    // Keyed: it checks at start that the agents its config lists are defined.
    optional: ["agent.definition"],
  });
  expect(app.describe().capabilities["agent.tool"]?.keys).toEqual({ [DELEGATE_TOOL]: "tool-delegate", [TASKS_TOOL]: "tool-delegate", [STEER_TOOL]: "tool-delegate", [CANCEL_TOOL]: "tool-delegate" });
});

test("it refuses to start when its config names an agent the App does not define", async () => {
  const app = await defineApp({ components: [toolDelegate], config: { "tool-delegate": { agents: [{ name: "nobody", description: "x" }] } }, logger: silentLogger }).create();
  const failure = await app.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String((failure as Error).cause)).toContain('"nobody" in its agents is no agent.definition');
});

test("its description names each agent with what it is for; its replay is safe", () => {
  const tool = createDelegateTool(config);
  expect(tool.name).toBe(DELEGATE_TOOL);
  expect(tool.replay).toBe("safe");
  expect(tool.description).toBe(delegateDescription(config));
  expect(tool.description).toContain("- researcher: Reads sources.\n- coder: Writes code.");
});

test("a call runs the task in a child of the agent it names, one level deeper, its sender the delegating agent", async () => {
  const d = delegation();
  expect(textOf(await call({ agent: "researcher", task: "find X" }, d))).toBe('The agent "researcher" answered:\n\ndone');

  expect(d.asked).toEqual([{ how: "run", task: { agent: "researcher", key: "delegate:1:assistant:t9", channel: "delegate", task: "find X", sender: { channel: "delegate", id: "assistant" } } }]);
});

test("wait: false starts it, and says its id and that the answer comes later", async () => {
  const d = delegation();
  expect(textOf(await call({ agent: "coder", task: "write Y", wait: false }, d))).toStartWith('The task "t9" is with the agent "coder" now.');
  expect(d.asked.map((each) => each.how)).toEqual(["start"]);
});

test("each outcome is what the model reads: an answer, or an error", async () => {
  expect(textOf(await call({ agent: "researcher", task: "x" }, delegation({ kind: "completed", text: "" })))).toBe('The agent "researcher" answered:\n\n(nothing)');
  await expect(call({ agent: "researcher", task: "x" }, delegation({ kind: "failed", message: "no model" }))).rejects.toThrow('the agent "researcher" could not do the task: no model');
  await expect(call({ agent: "researcher", task: "x" }, delegation({ kind: "aborted" }))).rejects.toThrow("was stopped before it answered");
});

test("what the child asked the person goes with the call's result, as its parts, and the model reads not to repeat it", async () => {
  const question = { type: "question", fallback: "Pay acme 10? Answer yes or no." } as unknown as MessagePart;
  const result = await call({ agent: "researcher", task: "x" }, delegation({ kind: "completed", text: "", parts: [question] }));

  expect(result.details).toEqual({ [PARTS_DETAIL]: [question] as never });
  expect(textOf(result)).toBe('The agent "researcher" answered:\n\n(nothing)\n\n[The person is shown what follows with your answer, as it is: do not repeat it.]\n\nPay acme 10? Answer yes or no.');
  // None: no details at all.
  expect((await call({ agent: "researcher", task: "x" })).details).toBeUndefined();
});

test("a delegated task always waits for its own delegations, and goes no deeper than maxDepth", async () => {
  const d = delegation();
  const task: ConversationRef = { key: "delegate:1:assistant:t3", agent: "researcher", conversationId: "8", origin: parent };
  await call({ agent: "coder", task: "x", wait: false }, d, task);
  expect(d.asked).toEqual([{ how: "run", task: { agent: "coder", key: "delegate:2:assistant.researcher:t9", channel: "delegate", task: "x", sender: { channel: "delegate", id: "researcher" } } }]);

  const deepest: ConversationRef = { key: "delegate:2:assistant.researcher:t9", agent: "coder", conversationId: "9", origin: parent };
  await expect(call({ agent: "researcher", task: "x" }, d, deepest)).rejects.toThrow("already 2 delegations deep, the most this project allows");
  expect(d.asked).toHaveLength(1);
  expect([depthOf("telegram:1"), depthOf("delegate:3:a.b.c:t1"), depthOf("delegate:x")]).toEqual([0, 3, 0]);
});

/** Who may delegate to whom: `developer` takes tasks only from `orchestrator`; `researcher` from anyone. */
const guarded: DelegateConfig = {
  agents: [
    { name: "developer", description: "Uses the GitHub token.", from: ["orchestrator"] },
    { name: "orchestrator", description: "Plans." },
    { name: "researcher", description: "Reads sources." },
  ],
  maxDepth: 3,
};
/** A conversation a person started, of `agent`. */
const root = (agent: string): ConversationRef => ({ key: `telegram:${agent}`, agent, conversationId: `c-${agent}` });
/** A delegated conversation of `agent` under `chain` (root first), as the runtime gives it: its origin the root's. */
const delegated = (chain: string[], agent: string, origin: ConversationRef = root(chain[0] ?? "")): ConversationRef => ({
  key: `delegate:${chain.length}:${chain.join(".")}:t1`,
  agent,
  conversationId: `c-${chain.join(".")}-${agent}`,
  origin,
});
/** Asks for `developer` in `conversation`, both ways, and expects both refused with nothing started. */
async function refusedBothWays(conversation: ConversationRef, message: string) {
  const d = delegation();
  for (const wait of [true, false]) await expect(call({ agent: "developer", task: "push", wait }, d, conversation, guarded)).rejects.toThrow(message);
  expect(d.asked).toEqual([]);
}

test("from: an allowed agent a person talks to delegates to it, its child's key carrying the chain", async () => {
  const d = delegation();
  expect(textOf(await call({ agent: "developer", task: "push" }, d, root("orchestrator"), guarded))).toBe('The agent "developer" answered:\n\ndone');
  await call({ agent: "developer", task: "push", wait: false }, d, root("orchestrator"), guarded);
  expect(d.asked.map((each) => [each.how, each.task.key])).toEqual([
    ["run", "delegate:1:orchestrator:t9"],
    ["start", "delegate:1:orchestrator:t9"],
  ]);
  expect([depthOf("delegate:1:orchestrator:t9"), chainOf("delegate:1:orchestrator:t9")]).toEqual([1, ["orchestrator"]]);
});

test("from: an agent it does not name is refused, waited for or not, and nothing is started", async () => {
  await refusedBothWays(root("support"), 'the agent "developer" takes tasks only from orchestrator; this conversation (support) may not delegate to it');
});

test("from: laundering through an allowed agent is refused: every agent above the caller must be named too", async () => {
  // support delegated to orchestrator, which is allowed; the task came from support, which is not.
  await refusedBothWays(delegated(["support"], "orchestrator"), "this conversation (orchestrator, delegated from support) may not delegate to it");
  // Two levels: support, then researcher (no from), then orchestrator.
  await refusedBothWays(delegated(["support", "researcher"], "orchestrator"), "(orchestrator, delegated from support then researcher)");
});

test("from: a chain wholly in it is allowed, and the child's key carries it one agent longer", async () => {
  const d = delegation();
  await call({ agent: "developer", task: "push" }, d, delegated(["orchestrator"], "orchestrator"), guarded);
  const key = d.asked[0]?.task.key ?? "";
  expect(key).toBe("delegate:2:orchestrator.orchestrator:t9");
  expect([depthOf(key), chainOf(key)]).toEqual([2, ["orchestrator", "orchestrator"]]);
});

test("from: a chain that cannot be trusted reaches no restricted agent; unrestricted ones still, and the distrust goes down", async () => {
  const untrusted: ConversationRef[] = [
    // The origin the runtime fixed is not the chain's first agent.
    delegated(["orchestrator"], "orchestrator", root("support")),
    // A delegate key without an origin, malformed, of another depth than its chain, the old format, or written empty.
    { key: "delegate:1:orchestrator:t1", agent: "orchestrator", conversationId: "c" },
    { ...delegated(["orchestrator"], "orchestrator"), key: "delegate:1:orchestrator" },
    { ...delegated(["orchestrator"], "orchestrator"), key: "delegate:2:orchestrator:t1" },
    { ...delegated(["orchestrator"], "orchestrator"), key: "delegate:1:t1" },
    { ...delegated(["orchestrator"], "orchestrator"), key: "delegate:1::t1" },
    { ...delegated(["orchestrator"], "orchestrator"), key: "delegate:1:Orchestrator:t1" },
    // Delegated (an origin) under a key that is not this tool's.
    { key: "telegram:9", agent: "orchestrator", conversationId: "c", origin: root("orchestrator") },
  ];
  for (const conversation of untrusted) {
    expect(callersOf(conversation)).toBeUndefined();
    await refusedBothWays(conversation, "this conversation's chain of delegations cannot be verified");
    const d = delegation();
    await call({ agent: "researcher", task: "x" }, d, conversation, guarded);
    // The child's chain is written empty: nothing under it can be trusted either.
    expect(d.asked[0]?.task.key).toMatch(/^delegate:\d+::t9$/);
    expect(chainOf(d.asked[0]?.task.key ?? "")).toBeUndefined();
  }
  expect([chainOf("telegram:1"), callersOf(root("support"))]).toEqual([[], ["support"]]);
});

test("from: an unknown agent is refused before it, and it before the depth limit", async () => {
  const d = delegation();
  await expect(call({ agent: "stranger", task: "x" }, d, root("support"), guarded)).rejects.toThrow('there is no agent "stranger"');
  const deep = delegated(["support", "orchestrator", "orchestrator"], "orchestrator");
  await expect(call({ agent: "developer", task: "x" }, d, deep, guarded)).rejects.toThrow('takes tasks only from orchestrator');
  expect(d.asked).toEqual([]);
});

test("from: the description says who may delegate to a restricted agent", () => {
  expect(delegateDescription(guarded)).toContain("- developer: Uses the GitHub token. (only from: orchestrator)\n- orchestrator: Plans.\n- researcher: Reads sources.");
});

test("from: start refuses a name in it that is no agent.definition", async () => {
  const agents = defineComponent({ name: "agents", setup: (pikit) => pikit.provideKeyed("agent.definition", "developer", { name: "developer", model: "x/y" }) });
  const app = await defineApp({
    components: [agents, toolDelegate],
    config: { "tool-delegate": { agents: [{ name: "developer", description: "x", from: ["orchestrator"] }] } },
    logger: silentLogger,
  }).create();
  const failure = await app.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String((failure as Error).cause)).toContain('"orchestrator" in the from of "developer" is no agent.definition');
});

test("outside a conversation's run, or to an agent it does not list, nothing is asked", async () => {
  const d = delegation();
  await expect(call({ agent: "researcher", task: "x" }, d, null)).rejects.toThrow("only in a conversation's run");
  await expect(call({ agent: "stranger", task: "x" }, d)).rejects.toThrow('there is no agent "stranger"');
  expect(d.asked).toEqual([]);
});

/** Calls one of the tools of the tasks not waited for, as the runtime does. */
const control = (tool: ReturnType<typeof createTasksTool>, args: Record<string, unknown>, d: ReturnType<typeof delegation>) =>
  tool.execute(args as never, { taskId: "t10" } as never, withContextValue(AGENT_DELEGATION, d.stand, BACKGROUND_CONTEXT) as never);

test("delegate_tasks lists this conversation's tasks, or one by id; an id it does not have is an error", async () => {
  const tasks: BackgroundDelegation[] = [
    { id: "t1", agent: "researcher", status: "running" },
    { id: "t2", agent: "coder", status: "completed", result: "wrote it" },
  ];
  const d = delegation(undefined, tasks);
  expect(textOf(await control(createTasksTool(), {}, d))).toBe('- t1: the agent "researcher", running\n- t2: the agent "coder", completed:\nwrote it');
  expect(textOf(await control(createTasksTool(), { id: "t2" }, d))).toBe('- t2: the agent "coder", completed:\nwrote it\nIts agent took no step.');
  await expect(control(createTasksTool(), { id: "t3" }, d)).rejects.toThrow('there is no task "t3" started from this conversation');
  expect(textOf(await control(createTasksTool(), {}, delegation()))).toBe("No task was handed over from this conversation without waiting.");
});

test("delegate_tasks shows how a task is going: with its id, its agent's last steps; in the list, a running task's latest step", async () => {
  const tasks: BackgroundDelegation[] = [
    { id: "t1", agent: "researcher", status: "running" },
    { id: "t2", agent: "coder", status: "completed", result: "wrote it" },
    { id: "t3", agent: "coder", status: "running" },
  ];
  const steps = {
    t1: {
      steps: [
        { kind: "text" as const, text: "Looking at\nthe sources." },
        { kind: "tool" as const, name: "search", arguments: '{"q":"durable"}', status: "ok" as const },
        { kind: "tool" as const, name: "fetch", arguments: '{"url":"x"}', status: "running" as const },
      ],
      updatedAt: Date.now() - 180_000,
    },
    t2: { steps: [{ kind: "tool" as const, name: "write", arguments: "{}", status: "error" as const }] },
  };
  const d = delegation(undefined, tasks, steps);

  expect(textOf(await control(createTasksTool(), { id: "t1" }, d))).toBe(
    '- t1: the agent "researcher", running\nIts last steps, oldest first (the last one 3 minutes ago):\n  - wrote: Looking at the sources.\n  - called search {"q":"durable"}: ok\n  - called fetch {"url":"x"}: running',
  );
  // An ended task too; one with no step yet says so.
  expect(textOf(await control(createTasksTool(), { id: "t2" }, d))).toBe('- t2: the agent "coder", completed:\nwrote it\nIts last steps, oldest first:\n  - called write {}: error');
  expect(textOf(await control(createTasksTool(), { id: "t3" }, d))).toBe('- t3: the agent "coder", running\nIts agent has taken no step yet.');
  await expect(control(createTasksTool(), { id: "t4" }, d)).rejects.toThrow('there is no task "t4" started from this conversation');
  // The list: one line per task, a running one's latest step on it.
  expect(textOf(await control(createTasksTool(), {}, d))).toBe(
    '- t1: the agent "researcher", running; its latest step: called fetch {"url":"x"}: running\n- t2: the agent "coder", completed:\nwrote it\n- t3: the agent "coder", running',
  );
});

test("delegate_steer sends only to a running task; delegate_cancel stops one, and says when it had ended", async () => {
  const d = delegation(undefined, [
    { id: "t1", agent: "researcher", status: "running" },
    { id: "t2", agent: "coder", status: "completed", result: "x" },
  ]);
  expect(textOf(await control(createSteerTool(), { id: "t1", message: "also Z" }, d))).toBe('The message is with the task "t1". Its answer will arrive in this conversation when it ends.');
  await expect(control(createSteerTool(), { id: "t2", message: "also Z" }, d)).rejects.toThrow('the task "t2" has already ended (completed): nothing was sent');
  await expect(control(createSteerTool(), { id: "t3", message: "also Z" }, d)).rejects.toThrow('there is no task "t3"');
  expect(d.steered).toEqual([{ id: "t1", message: "also Z" }]);

  expect(textOf(await control(createCancelTool(), { id: "t1" }, d))).toBe('The task "t1" is stopped.');
  expect(textOf(await control(createCancelTool(), { id: "t2" }, d))).toBe('The task "t2" had already ended (completed): nothing to stop.');
  await expect(control(createCancelTool(), { id: "t3" }, d)).rejects.toThrow('there is no task "t3"');
  for (const tool of [createTasksTool(), createSteerTool(), createCancelTool()]) expect(tool.replay).toBe("safe");
});

test("config is checked when the App is defined: at least one agent, each named and described, a non-empty from of names, a depth from 1 to 5", () => {
  for (const bad of [
    { agents: [] },
    { agents: [{ name: "", description: "x" }] },
    { agents: [{ name: "ok", description: "" }] },
    { agents: [{ name: "ok", description: "x" }], maxDepth: 0 },
    { agents: [{ name: "ok", description: "x", from: [] }] },
    { agents: [{ name: "ok", description: "x", from: [""] }] },
  ]) {
    expect(() => defineApp({ components: [toolDelegate], config: { "tool-delegate": bad }, logger: silentLogger })).toThrow("/tool-delegate/");
  }
});
