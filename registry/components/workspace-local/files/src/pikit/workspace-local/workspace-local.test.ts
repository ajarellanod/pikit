/**
 * workspace-local's tests. They are copied with the component and keep running in your project.
 * Every root is a temporary directory; the agents' runs use a scripted model, so no API key is needed.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type App,
  CONVERSATION,
  type ConversationRef,
  defineAgent,
  defineApp,
  defineComponent,
  silentLogger,
} from "@pikit/core";
import { createLifecycleConformance } from "@pikit/core/testing";
import { createPiRuntime, modelsFrom, type SessionStore, type WorkspaceProvider } from "@pikit/pi-adapter";
import { createExecutionConformance, createWorkspaceConformance, scriptedProvider, testComponents } from "@pikit/pi-adapter/testing";
import { bindTool, createWriteTool } from "@pikit/pi-adapter/tools";
import workspaceLocal from "./index.ts";

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pikit-workspace-local-"));
  directories.push(dir);
  return join(dir, "workspaces");
}

function conversation(agent: string, id = "1"): ConversationRef {
  return { key: `test:${agent}:${id}`, agent, sessionId: `session-${agent}-${id}` };
}

/** A started app with this component, and the `workspace` it provides. */
async function started(config: Record<string, unknown>): Promise<{ app: App; workspace: WorkspaceProvider }> {
  let found: WorkspaceProvider | undefined;
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const workspace = pikit.use("workspace");
      return { start: () => void (found = workspace.get()) };
    },
  });
  const app = await defineApp({ components: [workspaceLocal, reader], config: { "workspace-local": config }, logger: silentLogger }).create();
  await app.start();
  if (found === undefined) throw new Error("workspace was not resolved");
  return { app, workspace: found };
}

// The workspace contract (SPEC §14): a conversation keeps its files, two agents are apart.
for (const c of createWorkspaceConformance(async () => {
  const { app, workspace } = await started({ root: temporaryRoot() });
  return { provider: workspace, dispose: () => app.stop() };
})) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}

// An agent's directory is Pi's ExecutionEnv, with a shell (SPEC §8.3).
for (const c of createExecutionConformance(async () => {
  const { app, workspace } = await started({ root: temporaryRoot() });
  const { env } = await workspace.resolve(conversation("support"), app.context());
  return { env, shell: true, dispose: () => app.stop() };
})) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}

// Start and stop honour their deadline.
const lifecycleRoot = temporaryRoot();
for (const c of createLifecycleConformance(() => ({ component: workspaceLocal, config: { "workspace-local": { root: lifecycleRoot } } }))) {
  test(`workspace-local ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [workspaceLocal], logger: silentLogger }).create();

  expect(app.describe().components).toEqual([{ name: "workspace-local", provides: ["workspace"], requires: [], optional: [] }]);
});

test("each agent gets a directory of its own under root, created on its first call", async () => {
  const root = temporaryRoot();
  const { app, workspace } = await started({ root });
  expect(readdirSync(root)).toEqual([]);

  const support = await workspace.resolve(conversation("support"), app.context());
  const ops = await workspace.resolve(conversation("ops"), app.context());

  expect(support.env.cwd).toBe(join(root, "support"));
  expect(ops.env.cwd).toBe(join(root, "ops"));
  expect(readdirSync(root).sort()).toEqual(["ops", "support"]);
  await app.stop();
});

test("every conversation of one agent gets the same environment", async () => {
  const { app, workspace } = await started({ root: temporaryRoot() });

  const [first, second] = await Promise.all([
    workspace.resolve(conversation("support", "1"), app.context()),
    workspace.resolve(conversation("support", "2"), app.context()),
  ]);

  expect(first.env).toBe(second.env);
  await app.stop();
});

test("an agent name that could leave root is refused, and nothing is created", async () => {
  const root = temporaryRoot();
  const { app, workspace } = await started({ root });

  for (const agent of ["", "..", "../escaped", "a/b", "/tmp", "Support"]) {
    await expect(workspace.resolve(conversation(agent), app.context())).rejects.toThrow("not a safe directory name");
  }

  expect(readdirSync(root)).toEqual([]);
  expect(existsSync(join(root, "..", "escaped"))).toBe(false);
  await app.stop();
});

test("a command does not see the server's variables, only the allowed ones", async () => {
  const root = temporaryRoot();
  // Stands in for a secret of the server, such as PIKIT_HTTP_TOKEN or ANTHROPIC_API_KEY.
  process.env.PIKIT_WORKSPACE_LOCAL_SECRET = "server-secret";
  try {
    const { app, workspace } = await started({ root });
    const { env } = await workspace.resolve(conversation("ops"), app.context());

    await env.exec('printf "%s" "${PIKIT_WORKSPACE_LOCAL_SECRET:-absent}" > seen.txt', undefined, app.context());

    expect(readFileSync(join(root, "ops", "seen.txt"), "utf8")).toBe("absent");
    await app.stop();
  } finally {
    delete process.env.PIKIT_WORKSPACE_LOCAL_SECRET;
  }
});

test("in real runs, a file agent A's write tool writes is in A's directory and not in B's", async () => {
  const root = temporaryRoot();
  // tool-write's own wiring (components never import each other): the agent's workspace, from the run.
  let workspace!: WorkspaceProvider;
  const write = bindTool(createWriteTool(), {
    env: async (context) => {
      const ref = context.value(CONVERSATION);
      if (ref === undefined) throw new Error("a call outside a run");
      return (await workspace.resolve(ref, context)).env;
    },
    replay: "never",
  });
  const agents = ["alpha", "beta"].map((name) => defineAgent({ name, model: "faux/scripted", tools: ["write"] }));
  const fixtures = testComponents({ agents });
  let sessions!: SessionStore;
  const settled: string[] = [];
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const provided = pikit.use("workspace");
      const store = pikit.use("sessions.store");
      pikit.on("agent.settled", (payload) => void settled.push(payload.requestId));
      return {
        start() {
          workspace = provided.get();
          sessions = store.get();
        },
      };
    },
  });
  const app = await defineApp({
    components: [workspaceLocal, fixtures.sessions, reader],
    config: { "workspace-local": { root } },
    logger: silentLogger,
  }).create();
  await app.start();
  const runtime = createPiRuntime({
    sessions,
    agent: (name) => agents.find((agent) => agent.name === name),
    tool: (name) => (name === "write" ? write : undefined),
    models: modelsFrom([scriptedProvider()]),
    events: app.context(),
  });
  /** A new conversation with `agent`, sent one message; resolves when its run has ended. */
  const ask = async (agent: string, prompt: string) => {
    const session = await sessions.create({}, app.context());
    await session.close(app.context());
    const requestId = `r-${agent}`;
    await runtime.dispatch({ requestId, conversation: { key: `test:${agent}`, agent, sessionId: session.metadata.id }, prompt }, app.context());
    while (!settled.includes(requestId)) await Bun.sleep(5);
  };

  await ask("alpha", 'call: write {"path":"note.md","content":"from alpha"}');
  await ask("beta", 'call: write {"path":"other.md","content":"from beta"}');

  expect(readFileSync(join(root, "alpha", "note.md"), "utf8")).toBe("from alpha");
  expect(existsSync(join(root, "beta", "note.md"))).toBe(false);
  expect(readFileSync(join(root, "beta", "other.md"), "utf8")).toBe("from beta");
  expect(existsSync(join(root, "alpha", "other.md"))).toBe(false);
  await runtime.close(app.context());
  await app.stop();
});

test("it refuses to start when root cannot be a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-workspace-local-"));
  directories.push(dir);
  writeFileSync(join(dir, "blocked"), "a file where the workspaces should be");
  const app = await defineApp({
    components: [workspaceLocal],
    config: { "workspace-local": { root: join(dir, "blocked", "workspaces") } },
    logger: silentLogger,
  }).create();

  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(String((error as Error).message)).toContain('"workspace-local" failed to start');
});
