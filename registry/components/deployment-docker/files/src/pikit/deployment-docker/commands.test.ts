/**
 * `up`, `down`, `restart`, `logs` and `status` without Docker: a fake `Runner` records the argv each
 * one would run, and a fake `fetch` answers the probes. `spawnRunner` itself runs Bun, not Docker.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeDeployHooks, down, exec, logs, parseContainers, restart, type Runner, spawnRunner, status, up } from "./commands.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function recorder(stdout = "", code = 0) {
  const calls: { command: readonly string[]; cwd: string; capture: boolean }[] = [];
  const run: Runner = async (command, options) => {
    calls.push({ command, ...options });
    return { code, stdout };
  };
  return { calls, run };
}

test("up builds, starts detached and waits for the healthcheck", async () => {
  const { calls, run } = recorder();

  await up({ cwd: "/srv/my-agent", run });

  expect(calls).toEqual([{ command: ["docker", "compose", "up", "--detach", "--build", "--wait"], cwd: "/srv/my-agent", capture: false }]);
});

/**
 * A project whose `tool-a` has a before-deploy hook, as `pikit add` records it in pikit.json: it writes
 * `seed.ts` in its own directory from its config and `.env`, or reports `TOOL_A_PROBLEM` when set.
 */
function projectWithBeforeHook(env: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "pikit-docker-commands-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, ".env"), env);
  const components = { "tool-a": { hooks: { beforeDeploy: "src/pikit/tool-a/deploy.ts" } }, "deployment-docker": {} };
  writeFileSync(join(cwd, "pikit.json"), JSON.stringify({ version: 1, targets: ["server"], registries: {}, components }));
  writeFileSync(join(cwd, "pikit.config.ts"), `export default { config: { "tool-a": { server: "wiki" } } };\n`);
  mkdirSync(join(cwd, "src", "pikit", "tool-a"), { recursive: true });
  writeFileSync(
    join(cwd, "src", "pikit", "tool-a", "deploy.ts"),
    `export async function beforeDeploy(io) {
  const problem = io.get("TOOL_A_PROBLEM");
  if (problem !== undefined) return [problem];
  io.say(io.write("seed.ts", \`export const seed = \${JSON.stringify({ ...io.config, token: io.get("HOOK_TEST_TOKEN") })};\\n\`) ? "written" : "unchanged");
  return [];
}
`,
  );
  return cwd;
}

test("up runs each component's beforeDeploy before it builds: its own files are written, once, then the image is built", async () => {
  const cwd = projectWithBeforeHook("HOOK_TEST_TOKEN=t\n");
  expect(beforeDeployHooks(cwd)).toEqual([{ component: "tool-a", file: "src/pikit/tool-a/deploy.ts" }]);
  const said: string[] = [];
  let seedWhenBuilt = "";
  const run: Runner = async () => {
    seedWhenBuilt = readFileSync(join(cwd, "src", "pikit", "tool-a", "seed.ts"), "utf8");
    return { code: 0, stdout: "" };
  };
  await up({ cwd, run, say: (line) => said.push(line) });
  await up({ cwd, run, say: (line) => said.push(line) });
  expect(seedWhenBuilt).toBe('export const seed = {"server":"wiki","token":"t"};\n');
  expect(said).toEqual(["written", "unchanged"]);
});

test("a beforeDeploy problem stops up before the build, naming the component", async () => {
  const { calls, run } = recorder();
  await expect(up({ cwd: projectWithBeforeHook("TOOL_A_PROBLEM=the MCP server is down\n"), run, say: () => {} })).rejects.toThrow(
    "what runs before a deploy failed, so nothing was built:\n  tool-a: the MCP server is down\n",
  );
  expect(calls).toEqual([]);
});

test("down keeps the .pikit volume; restart restarts the same containers", async () => {
  const { calls, run } = recorder();

  await down({ cwd: "/p", run });
  await restart({ cwd: "/p", run });

  expect(calls.map((call) => call.command)).toEqual([
    ["docker", "compose", "down"],
    ["docker", "compose", "restart"],
  ]);
  expect(calls[0]?.command).not.toContain("--volumes");
});

test("logs streams to the terminal, without prefixes so every line stays JSON", async () => {
  const { calls, run } = recorder();

  await logs({ cwd: "/p", run });
  await logs({ cwd: "/p", run, follow: true, tail: 100 });

  expect(calls).toEqual([
    { command: ["docker", "compose", "logs", "--no-log-prefix"], cwd: "/p", capture: false },
    { command: ["docker", "compose", "logs", "--no-log-prefix", "--follow", "--tail", "100"], cwd: "/p", capture: false },
  ]);
});

test("exec runs a one-off container of the app, with the shared directories at the same path", async () => {
  const { calls, run } = recorder("", 3);

  const code = await exec({
    cwd: "/srv/my-agent",
    run,
    command: ["bun", "/cli/credentials.ts", ".", "/tmp/out/result.json", "check"],
    share: [{ path: "/cli" }, { path: "/tmp/out", writable: true }],
  });

  // The exit code is returned, not thrown: the caller reads the command's own result.
  expect(code).toBe(3);
  expect(calls).toEqual([
    {
      command: [
        "docker", "compose", "--progress", "quiet", "run", "--rm", "--build", "--no-deps", "-T",
        "--volume", "/cli:/cli:ro", "--volume", "/tmp/out:/tmp/out",
        "app", "bun", "/cli/credentials.ts", ".", "/tmp/out/result.json", "check",
      ],
      cwd: "/srv/my-agent",
      capture: true,
    },
  ]);
});

test("exec with a person gets a terminal, and its output reaches it", async () => {
  const { calls, run } = recorder();

  await exec({ cwd: "/p", run, command: ["bun", "login.ts"], interactive: true });

  expect(calls[0]?.command).toEqual(["docker", "compose", "run", "--rm", "--build", "--no-deps", "app", "bun", "login.ts"]);
  expect(calls[0]?.capture).toBe(false);
});

test("the current directory is the default project", async () => {
  const { calls, run } = recorder();

  await up({ run });

  expect(calls[0]?.cwd).toBe(process.cwd());
});

test("a docker command that fails rejects with the command and its exit code", async () => {
  const { run } = recorder("", 17);

  await expect(up({ cwd: "/p", run })).rejects.toThrow("`docker compose up --detach --build --wait` exited with code 17");
});

test("status reports the containers and what /health and /ready answer", async () => {
  const ps = [
    { Name: "my-agent-app-1", Service: "app", State: "running", Health: "healthy", Status: "Up 3 minutes (healthy)" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const { calls, run } = recorder(`${ps}\n`);
  const probed: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    probed.push(url);
    return new Response(null, { status: url.endsWith("/health") ? 200 : 503 });
  }) as typeof fetch;

  const result = await status({ cwd: "/p", run, fetch: fakeFetch, url: "http://127.0.0.1:8080" });

  expect(calls).toEqual([{ command: ["docker", "compose", "ps", "--all", "--format", "json"], cwd: "/p", capture: true }]);
  expect(probed.sort()).toEqual(["http://127.0.0.1:8080/health", "http://127.0.0.1:8080/ready"]);
  expect(result).toEqual({
    containers: [{ name: "my-agent-app-1", service: "app", state: "running", health: "healthy", status: "Up 3 minutes (healthy)" }],
    health: 200,
    ready: 503,
    lines: ["my-agent-app-1: running (healthy) · Up 3 minutes (healthy)", "GET /health: 200", "GET /ready:  503"],
  });
});

test("status says unreachable when nothing answers, and probes compose.yaml's port by default", async () => {
  const { run } = recorder("");
  const probed: string[] = [];
  const refused = (async (input: string | URL | Request) => {
    probed.push(String(input));
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch;

  const result = await status({ run, fetch: refused });

  expect(result).toEqual({ containers: [], health: "unreachable", ready: "unreachable", lines: ["no containers", "GET /health: unreachable", "GET /ready:  unreachable"] });
  expect(probed.sort()).toEqual(["http://127.0.0.1:3000/health", "http://127.0.0.1:3000/ready"]);
});

test("docker compose ps output is read as JSON lines and as a JSON array (older Compose)", () => {
  const entry = { Name: "a", Service: "app", State: "exited", Health: "", Status: "Exited (1)", Extra: 1 };
  const expected = [{ name: "a", service: "app", state: "exited", health: "", status: "Exited (1)" }];

  expect(parseContainers(`${JSON.stringify(entry)}\n`)).toEqual(expected);
  expect(parseContainers(JSON.stringify([entry]))).toEqual(expected);
  expect(parseContainers(" \n")).toEqual([]);
});

test("spawnRunner captures stdout, returns the exit code and uses no shell", async () => {
  const result = await spawnRunner([process.execPath, "-e", "console.log('$HOME'); process.exit(3)"], {
    cwd: process.cwd(),
    capture: true,
  });

  expect(result).toEqual({ code: 3, stdout: "$HOME\n" });
});

test("spawnRunner says so when the program is not installed", async () => {
  await expect(spawnRunner(["pikit-no-such-docker-binary", "compose"], { cwd: process.cwd(), capture: true })).rejects.toThrow(
    "`pikit-no-such-docker-binary` was not found: install Docker with the Compose plugin",
  );
});
