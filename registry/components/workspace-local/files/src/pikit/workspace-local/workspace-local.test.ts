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

test("each agent gets a directory of its own under root, in execution's directory, made on its first call", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);
  expect(readdirSync(join(dir, "agents"))).toEqual([]);

  const support = await workspace.resolve(conversation("support"), app.context());
  const ops = await workspace.resolve(conversation("ops"), app.context());

  expect(support.env.cwd).toBe(join(dir, "agents", "support"));
  expect(ops.env.cwd).toBe(join(dir, "agents", "ops"));
  expect(readdirSync(join(dir, "agents")).sort()).toEqual(["ops", "support"]);
  await app.stop();
});

test("an absolute root is used as it is", async () => {
  const root = join(temporaryDir(), "workspaces");
  const { app, workspace } = await started(temporaryDir(), { root });

  expect((await workspace.resolve(conversation("support"), app.context())).env.cwd).toBe(join(root, "support"));
  await app.stop();
});

test("an agent's commands run with execution's variables, in the agent's directory", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir, {}, { GITHUB_TOKEN: "from-execution" });
  const { env } = await workspace.resolve(conversation("ops"), app.context());

  await env.exec('printf "%s %s" "$GITHUB_TOKEN" "$(pwd)" > seen.txt', undefined, app.context());

  expect(readFileSync(join(dir, "agents", "ops", "seen.txt"), "utf8")).toBe(`from-execution ${join(dir, "agents", "ops")}`);
  await app.stop();
});

test("an agent name that could leave root is refused, and nothing is created", async () => {
  const dir = temporaryDir();
  const { app, workspace } = await started(dir);

  for (const agent of ["", "..", "../escaped", "a/b", "/tmp", "Support"]) {
    await expect(workspace.resolve(conversation(agent), app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(join(dir, "agents"))).toEqual([]);
  expect(existsSync(join(dir, "escaped"))).toBe(false);
  await app.stop();
});

test("in real runs, a file agent A's write tool writes is in A's directory and not in B's", async () => {
  const dir = temporaryDir();
  const root = join(dir, "agents");
  // The runtime gives each tool call its conversation's workspace (runtime-pi's wiring: `harnessEnv`).
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
  const app = await defineApp({ components: [executionAt(dir), workspaceLocal, reader], logger: silentLogger }).create();
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
  /** A new conversation with `agent`, sent one message; resolves when its run has ended. */
  const ask = async (agent: string, prompt: string) => {
    const conversationId = await runtime.createConversation(app.context());
    const requestId = `r-${agent}`;
    await runtime.dispatch({ requestId, conversation: { key: `test:${agent}`, agent, conversationId }, prompt }, app.context());
    while (!settled.includes(requestId)) await Bun.sleep(5);
  };

  await ask("alpha", 'call: write {"path":"note.md","content":"from alpha"}');
  await ask("beta", 'call: write {"path":"other.md","content":"from beta"}');

  expect(readFileSync(join(root, "alpha", "note.md"), "utf8")).toBe("from alpha");
  expect(existsSync(join(root, "beta", "note.md"))).toBe(false);
  expect(readFileSync(join(root, "beta", "other.md"), "utf8")).toBe("from beta");
  expect(existsSync(join(root, "alpha", "other.md"))).toBe(false);
  await runtime.close(app.context());
  await sqlite.close();
  await app.stop();
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
