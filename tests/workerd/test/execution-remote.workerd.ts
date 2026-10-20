/**
 * execution-remote in a real Durable Object, reaching a real sandbox host through workerd's `fetch`
 * (`sandbox-outbound.ts`: execution-serve over a provider keyed as execution-gondolin's and
 * execution-local, real processes, in a Bun process of its own): pi-durable's `ExecutionEnv` suite,
 * each case in an object of its own (`execution`'s sandbox `o-<object id>`); pi-durable's own tools
 * through the `tool-*` components; the sandbox kept across a new App on the same object (an
 * eviction); two agents of one object in two sandboxes, each found again by a reset of the chat and by
 * a delegated child of the same agent; the Worker's App refused.
 */

import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { AgentTool, SecretStore } from "@pikit/contracts";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/cloudflare/testing";
import type { ExecutionEnv, WorkspaceProvider } from "@pikit/pi-adapter";
import { callTool, createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { expect, it } from "vitest";
import executionRemote from "../../../registry/components/execution-remote/files/src/pikit/execution-remote/index.ts";
import toolBash from "../../../registry/components/tool-bash/files/src/pikit/tool-bash/index.ts";
import toolEdit from "../../../registry/components/tool-edit/files/src/pikit/tool-edit/index.ts";
import toolRead from "../../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import toolWrite from "../../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";
import { inObject, objectHost } from "./host.ts";
import { SANDBOX_HOST, SANDBOX_TOKEN } from "./sandbox-host.ts";

const ctx = BACKGROUND_CONTEXT;
const ENDPOINT = `https://${SANDBOX_HOST}`;

function secrets(values: Record<string, string>) {
  const store: SecretStore = { get: async (name) => values[name] };
  return defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", store) });
}

/** An app with execution-remote (and `components`) started as deployment-cloudflare starts it, in `host`'s object. */
async function started(host: WorkersHost, components: ReturnType<typeof defineComponent>[] = []) {
  let env: ExecutionEnv | undefined;
  let workspace: WorkspaceProvider | undefined;
  const tools = new Map<string, AgentTool>();
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const shell = pikit.use("execution.shell");
      const workspaces = pikit.use("workspace");
      const provided = pikit.useKeyed("agent.tool");
      return {
        start() {
          env = shell.get();
          workspace = workspaces.get();
          for (const name of ["bash", "read", "write", "edit"]) {
            const tool = provided.get(name);
            if (tool !== undefined) tools.set(name, tool);
          }
        },
      };
    },
  });
  const app: App = await defineApp({
    components: [secrets({ PIKIT_SANDBOX_TOKEN: SANDBOX_TOKEN }), executionRemote, ...components, reader],
    config: { "execution-remote": { endpoint: ENDPOINT } },
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, host, ctx));
  if (env === undefined) throw new Error("execution.shell was not resolved");
  // `execution`'s working directory is the sandbox's, known after its first operation.
  const opened = await env.absolutePath(".", ctx);
  if (!opened.ok) throw opened.error;
  return { app, env, tools, workspace: workspace as WorkspaceProvider };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// pi-durable's ExecutionEnv contract, with a real shell, without watching: each case in an object of its own.
for (const c of createDurableExecutionConformance(async () => {
  const { app, env } = await started(objectHost());
  return { env, dispose: () => app.stop() };
}, { expect, watch: false })) {
  it(`execution-remote ${c.group}: ${c.name}`, () => inObject(c), c.timeoutMs);
}

it("pi-durable's own write, read, edit and bash tools work in the object's remote sandbox, through the tool-* components", () =>
  inObject(async (host) => {
    const { app, tools, env } = await started(host, [toolBash, toolRead, toolWrite, toolEdit]);
    const call = async (name: string, args: Record<string, unknown>) => (await callTool(tools.get(name) as AgentTool, args, { env })).text;

    expect(await call("write", { path: "notes/plan.md", content: "# Plan\n\n- clone\n- change\n" })).toContain("Successfully wrote");
    expect(await call("edit", { path: "notes/plan.md", edits: [{ oldText: "- change", newText: "- change\n- push" }] })).toContain("Successfully replaced");
    expect(await call("read", { path: "notes/plan.md" })).toBe("# Plan\n\n- clone\n- change\n- push\n");
    // A real shell: processes, pipes, the machine's own programs.
    // `execution`'s own sandbox, resolved on the host for no agent: `remote-o-<object id>/_o-<object id>`.
    expect(await call("bash", { command: "grep -c '^-' notes/plan.md && basename \"$PWD\" && sh -c 'echo $$' | grep -cE '^[0-9]+$'" })).toBe(`3\n_o-${host.object?.id}\n1\n`);
    await app.stop();
  }));

it("the object's sandbox outlives its App: a new App on the same object (after an eviction) finds its files", () =>
  inObject(async (host) => {
    const first = await started(host);
    await first.env.writeFile("kept.txt", "still here", ctx);
    await first.app.stop();

    const next = await started(host);
    expect(await next.env.readTextFile("kept.txt", ctx)).toEqual({ ok: true, value: "still here" });
    expect(next.env.id).toBe(`execution-remote:${ENDPOINT}#o-${host.object?.id}`);
    await next.app.stop();
  }));

it("two agents of one object (a delegated child of another agent) work in two sandboxes on the host; each agent finds its own again, after a reset of the chat and from a delegated child", () =>
  inObject(async (host) => {
    const { app, workspace } = await started(host);
    const objectId = host.object?.id as string;
    const origin = { key: "telegram:1", agent: "developer", conversationId: "c-1", channel: "telegram" };
    const developer = (await workspace.resolve(origin, ctx)).env;
    const analyst = (await workspace.resolve({ key: "delegate:1:developer:t-1", agent: "analyst", conversationId: "c-2", channel: "delegate", origin }, ctx)).env;
    await developer.writeFile("mine.txt", "developer's", ctx);

    const sandbox = `o-${await sha256Hex(`${objectId}\ndeveloper`)}`;
    expect(developer.id).toBe(`execution-remote:${ENDPOINT}#${sandbox}`);
    expect(analyst.id).toBe(`execution-remote:${ENDPOINT}#o-${await sha256Hex(`${objectId}\nanalyst`)}`);
    // Each resolved on the host for its own agent: `remote-<sandbox>/<agent>`.
    expect(developer.cwd.endsWith(`/remote-${sandbox}/developer`)).toBe(true);
    expect(analyst.cwd.endsWith("/analyst")).toBe(true);
    expect(await analyst.exists("mine.txt", ctx)).toEqual({ ok: true, value: false });
    const again = (await workspace.resolve({ key: "delegate:1:developer:t-2", agent: "developer", conversationId: "c-3", channel: "delegate", origin }, ctx)).env;
    expect(again).toBe(developer);
    expect(await again.readTextFile("mine.txt", ctx)).toEqual({ ok: true, value: "developer's" });
    await app.stop();

    // /new: a new conversation under the same key, in the same object, in a new App (an eviction between).
    const next = await started(host);
    const reset = (await next.workspace.resolve({ ...origin, conversationId: "c-4" }, ctx)).env;
    expect(reset.id).toBe(`execution-remote:${ENDPOINT}#${sandbox}`);
    expect(await reset.readTextFile("mine.txt", ctx)).toEqual({ ok: true, value: "developer's" });
    await next.app.stop();
  }));

it("it refuses to start in the Worker's App, which has no object", async () => {
  const app = await defineApp({
    components: [secrets({ PIKIT_SANDBOX_TOKEN: SANDBOX_TOKEN }), ...withWorkersHost({ env: {} }, [executionRemote])],
    config: { "execution-remote": { endpoint: ENDPOINT } },
    logger: silentLogger,
  }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(String((error as Error).cause)).toContain("WORKERS_HOST has no object");
});
