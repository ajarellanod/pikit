/**
 * workspace-local's tests. They are copied with the component and keep running in your project.
 * `execution` is a test environment over a temporary directory (`createLocalExecution`, the one
 * behind `execution-local`); the agents' runs use a scripted model, so no API key is needed.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type ConversationRef, defineAgent } from "@pikit/contracts";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createDurableRuntime, modelsFrom, type WorkspaceProvider } from "@pikit/pi-adapter";
import { createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { createLocalExecution } from "@pikit/pi-adapter/node";
import { createWorkspaceConformance, openSqliteDatabase, scriptedProvider } from "@pikit/pi-adapter/testing";
import { createWriteTool } from "@pikit/pi-adapter/tools";
import workspaceLocal from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory, `execution`'s working directory in a test. */
function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pikit-workspace-local-")));
  directories.push(dir);
  return dir;
}

/** `execution` and `execution.shell` over `dir`, as execution-local provides them, with `variables`. */
function executionAt(dir: string, variables: Record<string, string> = {}) {
  return defineComponent({
    name: "execution-test",
    setup(pikit) {
      const env = createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "", ...variables } });
      pikit.provide("execution", env);
      pikit.provide("execution.shell", env);
      return { stop: (ctx) => env.cleanup(ctx) };
    },
  });
}

function conversation(agent: string, id = "1"): ConversationRef {
  return { key: `test:${agent}:${id}`, agent, conversationId: `${agent}-${id}` };
}

/** The directory of the chat `key` inside its agent's: `_chats/` and the hex SHA-256 of the key, computed here. */
const chatDir = (key: string) => join("_chats", new Bun.CryptoHasher("sha256").update(key).digest("hex"));

/** A started app with this component over `execution` in `dir`, and the `workspace` it provides. */
async function started(dir: string, config: Record<string, unknown> = {}, variables?: Record<string, string>): Promise<{ app: App; workspace: WorkspaceProvider }> {
  let found: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const workspace = pikit.use("workspace");
      return { start: () => void (found = workspace.get()) };
    },
  });
  const app = await defineApp({ components: [executionAt(dir, variables), workspaceLocal, reader], config: { "workspace-local": config }, logger: silentLogger }).create();
  await app.start();
  if (found === undefined) throw new Error("workspace was not resolved");
  return { app, workspace: found };
}

// The workspace contract: a conversation keeps its files, two agents are apart.
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir());
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir(), { per: "agent" });
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local per agent ${c.group}: ${c.name}`, () => c.run());
}
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started(temporaryDir(), { per: "channel" });
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local per channel ${c.group}: ${c.name}`, () => c.run());
}

// An agent's directory is still pi-durable's whole ExecutionEnv, with a shell.
for (const c of createDurableExecutionConformance(async () => {
  const { app, workspace } = await started(temporaryDir());
  const { env } = await workspace.resolve(conversation("support"), app.context());
  return { env, dispose: () => app.stop() };
}, { expect })) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run(), c.timeoutMs);
}

// Start and stop honour their deadline.
const lifecycleDir = temporaryDir();
for (const c of createLifecycleConformance(() => ({ component: workspaceLocal, providers: [executionAt(lifecycleDir)] }))) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [executionAt(tmpdir()), workspaceLocal], logger: silentLogger }).create();

  expect(app.describe().components.find((component) => component.name === "workspace-local")).toEqual({
    name: "workspace-local",
    provides: ["workspace"],
    requires: ["execution"],
    optional: [],
  });
});

test("each agent gets a directory of its own in each chat under root, in execution's directory, made on its first call", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);
  expect(readdirSync(join(dir, "agents"))).toEqual([]);

  const support = await workspace.resolve(conversation("support"), app.context());
  const ops = await workspace.resolve(conversation("ops"), app.context());

  expect(support.env.cwd).toBe(join(dir, "agents", "support", chatDir("test:support:1")));
  expect(ops.env.cwd).toBe(join(dir, "agents", "ops", chatDir("test:ops:1")));
  expect(readdirSync(join(dir, "agents")).sort()).toEqual(["ops", "support"]);
  await app.stop();
});

test("per chat (the default): a reset (/new) and a delegated child of the same agent work in the chat's directory; another agent and another chat in their own", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);
  const origin = { key: "gchat:spaces/AAA", agent: "support", conversationId: "1", channel: "google-chat" };
  const cwd = async (ref: ConversationRef) => (await workspace.resolve(ref, app.context())).env.cwd;
  const here = join(dir, "agents", "support", chatDir("gchat:spaces/AAA"));
  const first = (await workspace.resolve(origin, app.context())).env;
  await first.writeFile("notes.md", "what my past self wrote", app.context());

  // /new: a new conversationId under the same key.
  const reset = (await workspace.resolve({ ...origin, conversationId: "2" }, app.context())).env;
  expect(reset.cwd).toBe(here);
  expect(await reset.readTextFile("notes.md", app.context())).toEqual({ ok: true, value: "what my past self wrote" });
  // A delegated child (and grandchild) of the same agent: its origin's chat, not its own key.
  expect(await cwd({ key: "delegate:1:support:t-1", agent: "support", conversationId: "3", channel: "delegate", origin })).toBe(here);
  expect(await cwd({ key: "delegate:2:support.support:t-2", agent: "support", conversationId: "4", channel: "delegate", origin })).toBe(here);
  // A child of another agent: that agent's directory of the chat.
  expect(await cwd({ key: "delegate:1:support:t-3", agent: "ops", conversationId: "5", channel: "delegate", origin })).toBe(join(dir, "agents", "ops", chatDir("gchat:spaces/AAA")));
  // Another chat: another directory.
  expect(await cwd({ ...origin, key: "gchat:spaces/BBB", conversationId: "6" })).toBe(join(dir, "agents", "support", chatDir("gchat:spaces/BBB")));
  expect(readdirSync(join(dir, "agents", "support", "_chats")).sort()).toEqual([chatDir("gchat:spaces/AAA"), chatDir("gchat:spaces/BBB")].map((path) => path.slice("_chats/".length)).sort());
  await app.stop();
});

test("per agent: every chat of an agent shares its directory; two agents still never do", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "agent" });
  const one = (await workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1" }, app.context())).env;
  const two = (await workspace.resolve({ key: "telegram:2", agent: "support", conversationId: "2", channel: "telegram" }, app.context())).env;
  await one.writeFile("index.md", "everything", app.context());

  expect(one.cwd).toBe(join(dir, "agents", "support"));
  expect(two.cwd).toBe(one.cwd);
  expect(await two.readTextFile("index.md", app.context())).toEqual({ ok: true, value: "everything" });
  expect((await workspace.resolve({ key: "telegram:1", agent: "ops", conversationId: "1" }, app.context())).env.cwd).toBe(join(dir, "agents", "ops"));
  await app.stop();
});

test("per chat, a chat with no key is refused and nothing is created; any other key is one safe name once hashed", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  await expect(workspace.resolve({ key: "", agent: "support", conversationId: "1" }, app.context())).rejects.toThrow("a directory needs a non-empty key");
  await expect(workspace.resolve({ key: "telegram:1", agent: "support", conversationId: "1", origin: { key: "", agent: "support", conversationId: "0" } }, app.context())).rejects.toThrow("a directory needs a non-empty key");
  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect((await workspace.resolve({ key: "../../escaped/..", agent: "support", conversationId: "1" }, app.context())).env.cwd).toBe(join(dir, "agents", "support", chatDir("../../escaped/..")));
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

test("an absolute root is used as it is", async () => {
  const root = join(temporaryDir(), "workspaces");
  const { app, workspace } = await started(temporaryDir(), { root });

  expect((await workspace.resolve(conversation("support"), app.context())).env.cwd).toBe(join(root, "support", chatDir("test:support:1")));
  await app.stop();
});

test("an agent's commands run with execution's variables, in the agent's directory", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, {}, { GITHUB_TOKEN: "from-execution" });
  const { env } = await workspace.resolve(conversation("ops"), app.context());

  await env.exec('printf "%s %s" "$GITHUB_TOKEN" "$(pwd)" > seen.txt', undefined, app.context());

  const own = join(dir, "agents", "ops", chatDir("test:ops:1"));
  expect(readFileSync(join(own, "seen.txt"), "utf8")).toBe(`from-execution ${own}`);
  await app.stop();
});

test("an agent name that could leave root is refused, and nothing is created", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  for (const agent of ["", "..", "../escaped", "a/b", "/tmp", "Support", "_", "__shared", "_../escaped"]) {
    await expect(workspace.resolve(conversation(agent), app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

test("per channel, each channel of an agent gets a directory of its own inside the agent's; a channel instance's `:` becomes `.`", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "channel" });
  const resolve = async (channel?: string) => (await workspace.resolve({ ...conversation("support"), ...(channel !== undefined && { channel }) }, app.context())).env.cwd;

  expect(await resolve("telegram")).toBe(join(dir, "agents", "support", "telegram"));
  expect(await resolve("telegram:ops")).toBe(join(dir, "agents", "support", "telegram.ops"));
  expect(await resolve("dashboard")).toBe(join(dir, "agents", "support", "dashboard"));
  // No channel recorded (a ref made by hand): the agent's directory.
  expect(await resolve()).toBe(join(dir, "agents", "support"));
  expect(readdirSync(join(dir, "agents", "support")).sort()).toEqual(["dashboard", "telegram", "telegram.ops"]);
  await app.stop();
});

test("an agentless sandbox's name (one leading `_`, execution-serve's) gets a directory of its own", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  expect((await workspace.resolve(conversation("_shared"), app.context())).env.cwd).toBe(join(dir, "agents", "_shared", chatDir("test:_shared:1")));
  expect((await workspace.resolve(conversation("shared"), app.context())).env.cwd).toBe(join(dir, "agents", "shared", chatDir("test:shared:1")));
  await app.stop();
});

test("per agent and per chat, the channel changes nothing", async () => {
  const dir = temporaryDir();
  const perAgent = await started(dir, { per: "agent" });
  expect((await perAgent.workspace.resolve({ ...conversation("support"), channel: "telegram" }, perAgent.app.context())).env.cwd).toBe(join(dir, "agents", "support"));
  await perAgent.app.stop();

  const { app, workspace } = await started(dir);
  expect((await workspace.resolve({ ...conversation("support"), channel: "telegram" }, app.context())).env.cwd).toBe(join(dir, "agents", "support", chatDir("test:support:1")));
  await app.stop();
});

test("per channel, a channel that is not a safe directory name is refused, and nothing is created", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, { per: "channel" });

  for (const channel of ["", "..", "a/b", "../escaped", "Telegram", "telegram:", ":ops", "telegram:..", "tele.gram"]) {
    await expect(workspace.resolve({ ...conversation("support"), channel }, app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

/**
 * Real runs over this component (scripted model, the `write` tool): the runtime gives each tool call its
 * conversation's workspace (runtime-pi's wiring: `harnessEnv`). `ask` sends one message to a
 * conversation of `agent` and resolves when its run has ended.
 */
async function realRuns(dir: string, config: Record<string, unknown> = {}) {
  let workspace!: WorkspaceProvider;
  const agents = ["alpha", "beta"].map((name) => defineAgent({ name, model: "faux/scripted", tools: ["write"] }));
  const settled: string[] = [];
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const provided = pikit.use("workspace");
      pikit.on("agent.settled", (payload) => void settled.push(payload.requestId));
      return { start: () => void (workspace = provided.get()) };
    },
  });
  const app = await defineApp({ components: [executionAt(dir), workspaceLocal, reader], config: { "workspace-local": config }, logger: silentLogger }).create();
  await app.start();
  const sqlite = openSqliteDatabase(":memory:");
  const write = createWriteTool();
  const runtime = createDurableRuntime({
    db: sqlite.database,
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => (name === "write" ? write : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
    workspace: () => workspace,
  });
  let requests = 0;
  return {
    /** A new conversation of `agent` (with `channel`, when given), under `key` (a reset of that chat), or a key of its own. */
    async conversation(agent: string, channel?: string, key?: string): Promise<ConversationRef> {
      const conversationId = await runtime.createConversation(app.context());
      return { key: key ?? `test:${agent}:${conversationId}`, agent, conversationId, ...(channel !== undefined && { channel }) };
    },
    async ask(conversation: ConversationRef, prompt: string) {
      const requestId = `r${++requests}`;
      await runtime.dispatch({ requestId, conversation, prompt }, app.context());
      while (!settled.includes(requestId)) await Bun.sleep(5);
    },
    async close() {
      await runtime.close(app.context());
      await sqlite.close();
      await app.stop();
    },
  };
}

test("in real runs, a file agent A's write tool writes is in A's directory and not in B's", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir);
  const alpha = await runs.conversation("alpha", undefined, "telegram:1");
  const beta = await runs.conversation("beta", undefined, "telegram:1");

  await runs.ask(alpha, 'call: write {"path":"note.md","content":"from alpha"}');
  await runs.ask(beta, 'call: write {"path":"other.md","content":"from beta"}');

  const [alphaDir, betaDir] = [join(root, "alpha", chatDir("telegram:1")), join(root, "beta", chatDir("telegram:1"))];
  expect(readFileSync(join(alphaDir, "note.md"), "utf8")).toBe("from alpha");
  expect(existsSync(join(betaDir, "note.md"))).toBe(false);
  expect(readFileSync(join(betaDir, "other.md"), "utf8")).toBe("from beta");
  expect(existsSync(join(alphaDir, "other.md"))).toBe(false);
  await runs.close();
});

test("in real runs, a reset of the chat (a new conversation under the same key) edits what the conversation before it wrote; another chat's does not see it", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir);

  await runs.ask(await runs.conversation("alpha", "telegram", "telegram:1"), 'call: write {"path":"note.md","content":"before /new"}');
  // /new: the registry points the key to a new conversation of the runtime.
  const after = await runs.conversation("alpha", "telegram", "telegram:1");
  await runs.ask(after, 'call: write {"path":"later.md","content":"after /new"}');
  await runs.ask(await runs.conversation("alpha", "telegram", "telegram:2"), 'call: write {"path":"other.md","content":"another chat"}');

  const here = join(root, "alpha", chatDir("telegram:1"));
  expect(readdirSync(here).sort()).toEqual(["later.md", "note.md"]);
  expect(readFileSync(join(here, "note.md"), "utf8")).toBe("before /new");
  expect(readdirSync(join(root, "alpha", chatDir("telegram:2")))).toEqual(["other.md"]);
  await runs.close();
});

test("per channel, in real runs: a conversation's files are in its channel's directory, also for a later message whose ref has no channel", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  const runs = await realRuns(dir, { per: "channel" });
  const telegram = await runs.conversation("alpha", "telegram");

  await runs.ask(telegram, 'call: write {"path":"one.md","content":"from telegram"}');
  // An operator's message: the runtime gives the run the channel recorded with the conversation.
  await runs.ask({ key: telegram.key, agent: telegram.agent, conversationId: telegram.conversationId }, 'call: write {"path":"two.md","content":"from the operator"}');
  await runs.ask(await runs.conversation("alpha", "dashboard"), 'call: write {"path":"one.md","content":"from the dashboard"}');

  expect(readFileSync(join(root, "alpha", "telegram", "one.md"), "utf8")).toBe("from telegram");
  expect(readFileSync(join(root, "alpha", "telegram", "two.md"), "utf8")).toBe("from the operator");
  expect(readFileSync(join(root, "alpha", "dashboard", "one.md"), "utf8")).toBe("from the dashboard");
  expect(existsSync(join(root, "alpha", "one.md"))).toBe(false);
  await runs.close();
});

test("it refuses to start when root cannot be a directory", async () => {
  const dir = temporaryDir();
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "blocked"), "a file where the agents' directories should be");
  const app = await defineApp({
    components: [executionAt(join(dir, "work")), workspaceLocal],
    config: { "workspace-local": { root: "blocked/agents" } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).message)).toContain('"workspace-local" failed to start');
});
