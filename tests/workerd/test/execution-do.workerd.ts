/**
 * execution-do on a real SQLite-backed Durable Object (SPEC C7): pi-durable's `ExecutionEnv` suite;
 * pi-durable's own `bash`, `read`, `write` and `edit` tools, through the unmodified `tool-*` components,
 * working on it;
 * the shell (pipes, loops, redirections, `grep`, `find`, `awk`, `jq`), `node` in QuickJS with its
 * budget, the `.git` fence, and `git` against a fake GitHub reached through `fetch` (no network).
 */

import { type App, BACKGROUND_CONTEXT, defineApp, defineComponent, silentLogger, withContextValue } from "@pikit/core";
import type { AgentTool } from "@pikit/contracts";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";
import { withWorkersHost } from "@pikit/contracts/testing";
import type { ExecutionEnv } from "@pikit/pi-adapter";
import { callTool, createDurableExecutionConformance } from "@pikit/pi-adapter/execution/testing";
import { afterEach, expect, it } from "vitest";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import { createFiles, type DurableObjectFilesStorage } from "../../../registry/components/execution-do/files/src/pikit/execution-do/files.ts";
import { createFakeGitHub } from "../../../registry/components/execution-do/files/src/pikit/execution-do/git-server.test-support.ts";
import toolBash from "../../../registry/components/tool-bash/files/src/pikit/tool-bash/index.ts";
import toolEdit from "../../../registry/components/tool-edit/files/src/pikit/tool-edit/index.ts";
import toolRead from "../../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import toolWrite from "../../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";
import { inObject, objectHost } from "./host.ts";

const ctx = BACKGROUND_CONTEXT;
const TOKEN = "ghp_workerd-token";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// pi-durable's ExecutionEnv contract, with a shell and without watching, each case in an object of its own.
for (const c of createDurableExecutionConformance(async () => {
  const { app, env } = await started(objectHost());
  return { env, dispose: () => app.stop() };
}, { expect, watch: false })) {
  it(`execution-do ${c.group}: ${c.name}`, () => inObject(c));
}

/** An app with execution-do (and `components`) started as deployment-cloudflare starts it, in `host`'s object. */
async function started(host: WorkersHost, options: { config?: Record<string, unknown>; components?: ReturnType<typeof defineComponent>[] } = {}) {
  let env: ExecutionEnv | undefined;
  const tools = new Map<string, AgentTool>();
  const reader = defineComponent({
    name: "workspace-reader",
    setup(pikit) {
      const shell = pikit.use("execution.shell");
      const provided = pikit.useKeyed("agent.tool");
      return {
        start() {
          env = shell.get();
          for (const name of ["bash", "read", "write", "edit"]) {
            const tool = provided.get(name);
            if (tool !== undefined) tools.set(name, tool);
          }
        },
      };
    },
  });
  const app: App = await defineApp({
    components: [executionDo, ...(options.components ?? []), reader],
    config: { "execution-do": options.config ?? {} },
    logger: silentLogger,
  }).create();
  await app.start(withContextValue(WORKERS_HOST, host, ctx));
  if (env === undefined) throw new Error("execution.shell was not resolved");
  return { app, env, tools };
}

/** Runs `command` as pi-durable's `bash` tool does, and returns its exit code and combined output. */
async function run(env: ExecutionEnv, command: string, cwd?: string) {
  let output = "";
  const result = await env.exec(command, { ...(cwd !== undefined && { cwd }), onOutput: (text) => void (output += text) }, ctx);
  if (!result.ok) throw new Error(`exec failed: ${result.error.code} ${result.error.message}`);
  return { exitCode: result.value.exitCode, output };
}

/** Calls `tool` on `env`, as the runtime does (it gives each call its environment), and returns its text. */
async function callOn(tool: AgentTool | undefined, args: Record<string, unknown>, env: ExecutionEnv): Promise<string> {
  if (tool === undefined) throw new Error("the tool is not installed");
  return (await callTool(tool, args, { env })).text;
}

it("pi-durable's own write, read, edit and bash tools work on the object's files, through the tool-* components", () =>
  inObject(async (host) => {
    const { app, tools, env } = await started(host, { components: [toolBash, toolRead, toolWrite, toolEdit] });
    const call = (tool: AgentTool | undefined, args: Record<string, unknown>) => callOn(tool, args, env);

    expect(await call(tools.get("write"), { path: "notes/plan.md", content: "# Plan\n\n- clone\n- change\n" })).toContain("Successfully wrote");
    expect(await call(tools.get("edit"), { path: "notes/plan.md", edits: [{ oldText: "- change", newText: "- change\n- push" }] })).toContain("Successfully replaced");
    expect(await call(tools.get("read"), { path: "notes/plan.md" })).toBe("# Plan\n\n- clone\n- change\n- push\n");
    expect(await call(tools.get("bash"), { command: "wc -l < notes/plan.md && grep -c '^-' notes/plan.md && pwd" })).toBe("5\n3\n/work\n");
    // The files are the object's rows.
    expect((host.object?.storage as DurableObjectFilesStorage).sql.exec("SELECT kind FROM execution_do_nodes WHERE path = '/work/notes/plan.md'").toArray()).toEqual([{ kind: "file" }]);
    await app.stop();
  }));

it("the shell: pipes, loops, redirections, functions, grep, find, awk, sed and jq", () =>
  inObject(async (host) => {
    const { app, env } = await started(host);
    const script = [
      "mkdir -p src/lib && for n in 1 2 3; do echo \"export const v$n = $n;\" > src/lib/v$n.ts; done",
      "count() { find src -name '*.ts' | wc -l; }",
      "echo files: $(count)",
      "grep -rl 'v2' src | sed 's#src/##'",
      "cat src/lib/*.ts | awk '{ sum += $5 } END { print \"sum:\", sum }'",
      "echo '{\"tools\":[{\"name\":\"bash\"},{\"name\":\"read\"}]}' > tools.json && jq -r '.tools[].name' tools.json | sort -r | tr '\\n' ' '",
      "echo; ls nothere 2>/dev/null || echo 'missing, as expected'",
    ].join("\n");

    expect(await run(env, script)).toEqual({ exitCode: 0, output: "files: 3\nlib/v2.ts\nsum: 6\nread bash \nmissing, as expected\n" });
    await app.stop();
  }));

it("node runs JavaScript in QuickJS (bundled WebAssembly) with fs over the object's files, and its budget stops a loop", () =>
  inObject(async (host) => {
    const { app, env } = await started(host, { config: { node: { interruptBudget: 500 } } });
    await env.writeFile("data.json", '{"items":[1,2,3]}', ctx);
    const script = `node -e 'const fs = require("node:fs"); const { items } = JSON.parse(fs.readFileSync("data.json")); fs.writeFileSync("out/sum.txt", String(items.reduce((a, b) => a + b)))'`;

    expect(await run(env, `${script} && cat out/sum.txt && node -p '6 * 7'`)).toEqual({ exitCode: 0, output: "642\n" });
    const loop = await run(env, "node -e 'while (true) {}'");
    expect(loop.exitCode).toBe(1);
    expect(loop.output).toContain("its whole CPU budget");
    await app.stop();
  }));

it("files inside .git change only through git: the file tools and the shell are refused", () =>
  inObject(async (host) => {
    const { app, env } = await started(host);
    const files = createFiles(() => host.object?.storage as DurableObjectFilesStorage);
    files.mkdirp("/work/repo/.git");
    files.write("/work/repo/.git/config", new TextEncoder().encode("[core]\n"));

    const written = await env.writeFile("repo/.git/config", "changed", ctx);
    expect(written.ok ? "ok" : written.error.code).toBe("permission_denied");
    expect((await run(env, "echo x > repo/.git/config")).exitCode).toBe(1);
    expect((await run(env, "ln -s repo/.git/config link && echo x > link")).exitCode).toBe(1);
    expect(await run(env, "cat repo/.git/config")).toEqual({ exitCode: 0, output: "[core]\n" });
    await app.stop();
  }));

it("git clones from a fake GitHub, commits, and pushes a pikit/self/ branch with the token, never to main", () =>
  inObject(async (host) => {
    // The fake GitHub keeps its repositories in this object's files too, under /srv.
    const github = await createFakeGitHub(host.object?.storage as DurableObjectFilesStorage, { "acme/app": { files: { "README.md": "hello\n" } } }, TOKEN);
    globalThis.fetch = github.fetch as typeof fetch;
    const secrets = defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name) => (name === "GITHUB_TOKEN" ? TOKEN : undefined) }) });
    const { app, env } = await started(host, { components: [secrets], config: { git: { pushRepositories: ["acme/app"] } } });

    expect((await run(env, "git clone https://github.com/acme/app")).exitCode).toBe(0);
    expect((await run(env, "echo more >> README.md && git status && git commit -m 'More' && git log", "app")).output).toMatch(
      /^On branch main\n M README\.md\n\[main [0-9a-f]{7}\] More\n 1 file\(s\) changed: README\.md\n[0-9a-f]{7} More \(pikit agent\)\n[0-9a-f]{7} second commit \(fake github\)\n$/,
    );
    expect((await run(env, "git push origin main", "app")).exitCode).toBe(1);
    expect((await run(env, "git push origin pikit/self/more", "app")).exitCode).toBe(0);
    expect(github.pushes.map((pushed) => pushed.ref)).toEqual(["refs/heads/pikit/self/more"]);
    expect(github.requests.every((request) => request.authorization !== null)).toBe(true);
    expect((await run(env, "env")).output).not.toContain(TOKEN);
    await app.stop();
  }));

it("it refuses to start in the Worker's App, which has no object", async () => {
  const app = await defineApp({ components: withWorkersHost({ env: {} }, [executionDo]), logger: silentLogger }).create();
  const error = await app.start().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(String((error as Error).cause)).toContain("WORKERS_HOST has no object");
});
