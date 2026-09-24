/**
 * `up`, `down`, `restart`, `logs` and `status` without Docker: a fake `Runner` records the argv each
 * one would run, and a fake `fetch` answers the probes. `spawnRunner` itself runs Bun, not Docker.
 */

import { expect, test } from "bun:test";
import { down, logs, parseContainers, restart, type Runner, spawnRunner, status, up } from "./commands.ts";

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

  expect(result).toEqual({ containers: [], health: "unreachable", ready: "unreachable" });
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
